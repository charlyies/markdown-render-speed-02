// src/inline.js — inline parsing: tokenize a block's raw text, resolve
// links, resolve emphasis, render to HTML.
//
// A block's text is first scanned into tokens (text runs, code spans,
// raw HTML, delimiter runs, bracket openers/closers, autolinks). A "]"
// is resolved the moment it is met, while the suffix ahead is still
// unscanned, so no text run can ever straddle a link boundary. Then
// emphasis runs over the token list with a delimiter stack. The result
// is a node tree that renders to HTML. Link text is re-parsed by the
// emphasis pass alone (the link node is opaque to outer emphasis), which
// is why emphasis can never span a link boundary.
//
// Node shapes:
//   {t:'text', s}             plain text (escapes applied, entities decoded)
//   {t:'code', s}             code span content (raw)
//   {t:'html', s}             raw inline HTML (verbatim)
//   {t:'br'}                  hard break
//   {t:'link', href, title, children}
//   {t:'image', src, title, alt}   (alt is children, rendered as text)
//   {t:'em'|'strong'|'del', children}
//
// Tokens used only while resolving:
//   {t:'delim', ch, len, canOpen, canClose, seq, pos}
//   {t:'open', bang, pos, end, active}
//   {t:'close', pos, end}

import {
  ASCII_PUNCT_BITS,
  decodeNumericEntity,
  escapeAttr,
  escapeRaw,
  foldLinkLabel,
  isAlnumChar,
  isPunctChar,
  isUnicodeSpaceChar,
  sanitizeHref,
} from "./text.js";

// Extended autolinks (www., scheme://, email, scheme:email) are disabled
// while the parser is "inside an <a>" element: any <a> open tag met
// during inline scanning sets it, any </a> close tag met during inline
// scanning clears it, and the state persists across blocks for the whole
// document. It is a plain boolean, not a depth count: one </a> clears it
// even after two <a> opens. Tags that form HTML blocks (alone on a line)
// are never scanned inline, so they do not touch it — that is why a lone
// <a href="x"> on its own line does not suppress, while the same tag
// mid-paragraph does. Only <a> matters (<b>/<span>/<div> do not
// suppress); a </a> with trailing space (</a >) does not clear it;
// bracket autolinks are unaffected. Reset at the start of each parse().
let insideAnchor = false;

export function resetAnchorTracking() {
  insideAnchor = false;
}

// Scan one inline string into tokens.
export function tokenizeInline(s, refs) {
  const n = s.length;
  const tokens = [];
  const bracketStack = []; // indices into tokens of active "[" openers
  // Source index of a "]" that a code-span search stopped at because the
  // span was broken there (see the code-span search below); a later
  // backtick opener before that "]" may not search past it.
  let spanFence = -1;
  let textBuf = "";
  let i = 0;
  // Sequence number for emphasis delimiters, in encounter order; used by
  // resolveEmphasis to scope the strict rule-of-3s flag (see there).
  let delimCount = 0;

  function flushText() {
    if (textBuf !== "") {
      tokens.push({ t: "text", s: textBuf });
      textBuf = "";
    }
  }
  function pushText(str) {
    textBuf += str;
  }
  // A literal "&" that must always be escaped (from \& or &#38;) gets its
  // own text token, so it can never join up with a following "name;" and
  // look like a named entity when the run is escaped.
  function pushAmp() {
    flushText();
    tokens.push({ t: "text", s: "&" });
  }
  // Is position i the start of an email local-part run? The raw
  // preceding character is not enough: "*" (and "_" / "~") is both an
  // email local character and an emphasis delimiter, so after "**"
  // the email does start even though s[i-1] is "*". Use the tokenized
  // state instead: if pending text ends in a local character we are
  // mid-run; a just-closed delimiter / code / tag is a boundary.
  function atMailRunStart() {
    if (textBuf !== "") return !isMailLocalChar(textBuf[textBuf.length - 1]);
    if (tokens.length === 0) return true;
    const last = tokens[tokens.length - 1];
    if (last.t === "text") {
      return (
        last.s.length === 0 ||
        !isMailLocalChar(last.s[last.s.length - 1])
      );
    }
    return true;
  }
  // An extended autolink must not swallow the "]" (and suffix) of a
  // link that will form: marked matches the link as a unit first, so
  // a URL inside its label stays plain text and can never eat the
  // "]". If the first "]" in the autolink's span closes an opener
  // whose link would form (same checks as the "]" handler: the
  // suffix parses, a referenced label is defined, no explicit link
  // in the text so far, no backtick code span in the text so far —
  // the autolink itself would be the content after it), the
  // autolink is not formed at all and the URL is scanned as plain
  // text; the link then forms and the URL stays text. If the link
  // would NOT form (e.g. it already contains a link, doc-08/b7),
  // the autolink forms and may swallow the "]".
  function autolinkBarred(i, end) {
    if (bracketStack.length === 0) return false;
    // First "]" inside the span (bounded scan — an unbounded
    // indexOf would run to the end of the string on every match).
    let k = -1;
    for (let p = i; p < end; p++) {
      if (s[p] === "]") {
        k = p;
        break;
      }
    }
    if (k < 0) return false;
    let oi = -1;
    for (let q = bracketStack.length - 1; q >= 0; q--) {
      if (tokens[bracketStack[q]].active) {
        oi = bracketStack[q];
        break;
      }
    }
    if (oi < 0) return false;
    const opener = tokens[oi];
    const suffix = parseLinkTail(s, k + 1);
    let formed;
    if (suffix && suffix.kind === "inline") {
      formed = true;
    } else if (suffix && suffix.kind === "ref") {
      formed = !!refs.get(foldLinkLabel(suffix.label));
    } else {
      // Collapsed / shortcut / malformed suffix: shortcut fallback
      // on the raw label text.
      formed = !!refs.get(foldLinkLabel(s.slice(opener.end, k)));
    }
    if (!formed) return false;
    const children = tokens.slice(oi + 1);
    if (!opener.bang && hasNestedLink(children)) return false;
    for (const node of children) {
      if (
        node.t === "code" &&
        typeof node.s === "string" &&
        node.s.includes("`")
      ) {
        return false;
      }
    }
    return true;
  }

  while (i < n) {
    const c = s[i];

    // --- backslash escapes / hard break -------------------------------
    if (c === "\\") {
      if (i + 1 < n) {
        const d = s[i + 1];
        if (d === "\n") {
          flushText();
          tokens.push({ t: "br" });
          i += 2;
          // A hard break strips the leading whitespace of the next line.
          while (i < n && (s[i] === " " || s[i] === "\t")) i++;
          continue;
        }
        const dc = d.charCodeAt(0);
        if (dc < 128 && ASCII_PUNCT_BITS[dc] === 1) {
          if (d === "&") pushAmp();
          else pushText(d);
          i += 2;
          continue;
        }
      }
      pushText("\\");
      i++;
      continue;
    }

    // --- code spans ----------------------------------------------------
    if (c === "`") {
      let j = i;
      while (j < n && s[j] === "`") j++;
      const ticks = j - i;
      // Find a matching run of exactly the same length.
      let k = j;
      let found = -1;
      // A backtick run of a different length than the opener, seen
      // before a "]" that would close a link, means the code span is
      // broken there and the link takes precedence (e.g. the "``url`"
      // in "[docs each ``url`](...)": the single "`" breaks the
      // "``" span, so the link forms and the backticks stay literal).
      // With no such run, the search continues past the "]" and the
      // code span may contain it ("[a `b]c` d](url)", cm-342/525/537).
      // The "]" the search stopped at becomes a boundary: a later
      // backtick opener before it (the single "`" in "``url`") may
      // not search past it either, or it would span the link.
      let sawOtherLen = false;
      const searchEnd =
        spanFence >= 0 && i < spanFence ? spanFence : n;
      while (k < searchEnd) {
        if (s[k] === "`") {
          let m = k;
          while (m < searchEnd && s[m] === "`") m++;
          if (m - k === ticks) {
            found = k;
            break;
          }
          sawOtherLen = true;
          k = m;
        } else if (
          s[k] === "]" &&
          sawOtherLen &&
          bracketStack.some((idx) => tokens[idx].active) &&
          parseLinkTail(s, k + 1)
        ) {
          spanFence = k;
          break;
        } else {
          k++;
        }
      }
      if (found >= 0) {
        let content = s.slice(j, found).replace(/\n/g, " ");
        if (
          content.length >= 2 &&
          content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32 &&
          content.trim() !== ""
        ) {
          content = content.slice(1, -1);
        }
        flushText();
        tokens.push({ t: "code", s: content });
        i = found + ticks;
        continue;
      }
      pushText(s.slice(i, j));
      i = j;
      continue;
    }

    // --- < : autolinks and raw HTML ------------------------------------
    if (c === "<") {
      const auto = matchAngleLink(s, i);
      if (auto) {
        flushText();
        tokens.push(auto.node);
        i = auto.end;
        continue;
      }
      const tag = matchRawTag(s, i);
      if (tag) {
        // An <a> open tag enters "inside a link", which suppresses
        // extended autolinks; a clean </a> leaves it. Only an <a>
        // whose tag name is followed by a literal space counts: a
        // bare <a>, a self-closing <a/>, and <a\n...> / <a\t...> do
        // not. (Probed 16 Nov 2026.)
        const t = tag.text;
        if (t[1] !== "/" && t[1] !== "!" && t[1] !== "?") {
          let k = 1;
          while (k < t.length && /[A-Za-z0-9-]/.test(t[k])) k++;
          if (t.slice(1, k).toLowerCase() === "a" && t[k] === " ") {
            insideAnchor = true;
          }
        } else if (t.toLowerCase() === "</a>") {
          insideAnchor = false;
        }
        flushText();
        tokens.push({ t: "html", s: tag.text });
        i = tag.end;
        continue;
      }
      pushText("<");
      i++;
      continue;
    }

    // --- entities ------------------------------------------------------
    if (c === "&") {
      const ent = scanEntity(s, i);
      if (ent) {
        if (ent.kind === "named") {
          pushText(ent.text);
        } else if (ent.decoded === "&") {
          pushAmp();
        } else {
          pushText(ent.decoded);
        }
        i = ent.end;
        continue;
      }
      pushAmp();
      i++;
      continue;
    }

    // --- images / links -------------------------------------------------
    // A "]" is resolved right here, while the suffix text ahead has not
    // been scanned yet, so no text run can ever straddle a link boundary.
    if (c === "!" && i + 1 < n && s[i + 1] === "[") {
      flushText();
      bracketStack.push(tokens.length);
      tokens.push({ t: "open", bang: true, pos: i + 1, end: i + 2, active: true });
      i += 2;
      continue;
    }
    if (c === "[") {
      flushText();
      bracketStack.push(tokens.length);
      tokens.push({ t: "open", bang: false, pos: i, end: i + 1, active: true });
      i++;
      continue;
    }
    if (c === "]") {
      flushText();
      if (i >= spanFence) spanFence = -1;
      let openerIdx = -1;
      for (let k = bracketStack.length - 1; k >= 0; k--) {
        const oi = bracketStack[k];
        if (tokens[oi].active) {
          openerIdx = oi;
          bracketStack.splice(k, 1);
          break;
        }
      }
      if (openerIdx < 0) {
        pushText("]");
        i++;
        continue;
      }
      const opener = tokens[openerIdx];
      const suffix = parseLinkTail(s, i + 1);
      let href = null;
      let title = null;
      let failed = false;
      let isShortcut = false;
      if (!suffix) {
        // The inline link failed to parse (or the label was malformed):
        // fall back to the shortcut form, leaving the failed suffix as
        // literal text. A full reference label that simply is not
        // defined does NOT fall back (that case returns a "ref" suffix).
        const label = foldLinkLabel(s.slice(opener.end, i));
        const ref = refs.get(label);
        if (ref && (opener.bang || !hasNestedLink(tokens.slice(openerIdx + 1)))) {
          href = ref.href;
          title = ref.title;
          isShortcut = true;
        } else {
          failed = true;
        }
      } else if (suffix.kind === "inline") {
        href = suffix.href;
        title = suffix.title;
      } else if (suffix.kind === "ref") {
        const ref = refs.get(foldLinkLabel(suffix.label));
        if (!ref) failed = true;
        else {
          href = ref.href;
          title = ref.title;
        }
      } else {
        // Collapsed / shortcut: the label is the raw source text of
        // the link text (escapes kept), not the rendered plain text.
        const label = foldLinkLabel(s.slice(opener.end, i));
        const ref = refs.get(label);
        if (!ref) failed = true;
        else {
          href = ref.href;
          title = ref.title;
        }
      }
      if (failed) {
        opener.active = false;
        pushText("]");
        i++;
        continue;
      }
      // A link cannot contain another link (an image's text may, its
      // link becomes part of the alt text).
      if (!opener.bang && hasNestedLink(tokens.slice(openerIdx + 1))) {
        opener.active = false;
        pushText("]");
        i++;
        continue;
      }
      // A code span containing a backtick, with content after it in
      // the link text, prevents the link from forming (probe79/80/81);
      // marked also renders every emphasis delimiter in that link
      // text literally (probe82), so deactivate them all.
      if (hasBacktickTail(tokens.slice(openerIdx + 1))) {
        for (let k = openerIdx + 1; k < tokens.length; k++) {
          if (tokens[k].t === "delim") {
            tokens[k].canOpen = false;
            tokens[k].canClose = false;
          }
        }
        opener.active = false;
        pushText("]");
        i++;
        continue;
      }
      const children = tokens.splice(openerIdx + 1);
      tokens.splice(openerIdx, 1);
      // A formed link swallows extended autolinks in its text: they
      // render as plain text, not links (marked puts no link inside
      // a link). Only direct children are demoted, and only extended
      // autolinks (ext); bracket autolinks stay links (doc-08), and
      // an autolink inside a nested link/image child keeps the fate
      // its own formation gave it. Images skip this: their alt text
      // is plain text either way.
      if (!opener.bang) demoteExtendedLinks(children);
      // Every opener still on the stack past this one was inside the
      // link text; drop them (they are deactivated openers now).
      for (let k = bracketStack.length - 1; k >= 0; k--) {
        if (bracketStack[k] >= openerIdx) bracketStack.splice(k, 1);
      }
      let node;
      // ls/le: source range of the link text, so emphasis inside it
      // can be masked against the label alone (marked tokenizes a
      // link's text separately from the surrounding text).
      if (opener.bang) {
        node = { t: "image", src: href, title, children, ls: opener.end, le: i };
      } else {
        node = { t: "link", href, title, children, ls: opener.end, le: i };
      }
      tokens.push(node);
      i = isShortcut ? i + 1 : suffix.end;
      continue;
    }

    // --- emphasis / strikethrough delimiters ---------------------------
    if (c === "*" || c === "_" || c === "~") {
      let j = i;
      while (j < n && s[j] === c) j++;
      const len = j - i;
      const before = i > 0 ? s[i - 1] : " ";
      const after = j < n ? s[j] : " ";
      const beforeWs = isUnicodeSpaceChar(before);
      const afterWs = isUnicodeSpaceChar(after);
      const beforePunct = isPunctChar(before);
      const afterPunct = isPunctChar(after);
      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (c === "_") {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flushText();
      tokens.push({ t: "delim", ch: c, len, canOpen, canClose, seq: delimCount++, pos: i });
      i = j;
      continue;
    }

    // --- extended autolinks (GFM) ---------------------------------------
    // They form everywhere during the scan, including inside a "["
    // ... "]" label: whether one survives is decided when the link
    // resolves, not here. If the link forms, every extended autolink
    // among its direct children is demoted back to plain text (see
    // demoteExtendedLinks); if the link fails, the autolinks stay
    // links ("[see https://x.io here][99]", doc-39). Bracket
    // autolinks <...> above are unaffected and are never demoted:
    // marked renders them as links even inside a formed link
    // ("[simple table **parse <https://x.io> stable**](...)", doc-08).
    // Extended autolinks are off only while inside a raw <a> tag
    // (see insideAnchor above). One more guard (autolinkBarred): a URL
    // must not swallow the "]" of a link that will form.
    const extOk = !insideAnchor;
    if (extOk && c === "w" && s.startsWith("www.", i)) {
      const prev = i > 0 ? s[i - 1] : " ";
      if (
        i === 0 || isUnicodeSpaceChar(prev) || prev === "*" || prev === "_" ||
        prev === "~" || prev === "("
      ) {
        const ext = matchExtendedLink(s, i, 4);
        if (ext && !autolinkBarred(i, ext.end)) {
          flushText();
          tokens.push(ext.node);
          i = ext.end;
          continue;
        }
      }
    }
    if (extOk && (c === "h" || c === "H" || c === "f" || c === "F") && hasKnownScheme(s, i)) {
      const ext = matchExtendedLink(s, i, 0);
      if (ext && !autolinkBarred(i, ext.end)) {
        flushText();
        tokens.push(ext.node);
        i = ext.end;
        continue;
      }
    }
    // Email autolink: only tried at the start of a local-part run.
    // Fast run-start check: a run starts unless the previous source
    // char is an email-local char kept as text. Letters, digits and
    // non-delimiter local punctuation are always text, and whitespace
    // is always a boundary, so only "*", "_" and "~" (which may have
    // become emphasis delimiters) need the tokenized check.
    // Gate on "@" after the local run first: the backward scan for
    // open "_" delimiters is O(tokens) and must not run for every word
    // (matchMailLink returns null without "@" anyway).
    if (extOk && isMailLocalChar(c)) {
      let runStart;
      if (i === 0) {
        runStart = true;
      } else {
        const prev = s.charCodeAt(i - 1);
        if (prev === 42 || prev === 95 || prev === 126) {
          runStart = atMailRunStart();
        } else if (
          prev === 32 || prev === 10 || prev === 9 ||
          !isMailLocalChar(s[i - 1])
        ) {
          runStart = true;
        } else {
          runStart = false;
        }
      }
      if (runStart) {
        let j = i;
        while (j < n && isMailLocalChar(s[j])) j++;
        if (j < n && s[j] === "@") {
          // Lengths of opening "_" delimiters seen so far in this run,
          // so a "_" run after the domain can be recognised as the
          // closing delimiter (see parseMailDomain).
          let openUnderscoreLens = null;
          for (let k = tokens.length - 1; k >= 0; k--) {
            const it = tokens[k];
            if (it.t === "delim" && it.ch === "_" && it.canOpen) {
              if (!openUnderscoreLens) openUnderscoreLens = new Set();
              openUnderscoreLens.add(it.len);
            }
          }
          const em = matchMailLink(s, i, openUnderscoreLens);
          if (em && !autolinkBarred(i, em.end)) {
            flushText();
            tokens.push(em.node);
            i = em.end;
            continue;
          }
        }
      }
    }
    // Scheme:email autolink: only tried at the start of a lowercase word.
    // Gate on ":" after the word first: the regex in matchSchemeMail
    // must not run for every word (it returns null without ":" anyway).
    if (extOk && c >= "a" && c <= "z" && (i === 0 || !isSchemeLetter(s[i - 1]))) {
      let j = i;
      while (j < n && isSchemeLetter(s[j])) j++;
      if (j < n && s[j] === ":") {
        const se = matchSchemeMail(s, i);
        if (se && !autolinkBarred(i, se.end)) {
          flushText();
          tokens.push(se.node);
          i = se.end;
          continue;
        }
      }
    }

    // --- newlines: hard break (two trailing spaces) or soft break -----
    if (c === "\n") {
      let trailing = 0;
      let k = textBuf.length - 1;
      while (k >= 0 && textBuf.charCodeAt(k) === 32) {
        trailing++;
        k--;
      }
      if (trailing >= 2) {
        textBuf = textBuf.slice(0, textBuf.length - trailing);
        flushText();
        tokens.push({ t: "br" });
        i++;
        // A hard break strips the leading whitespace of the next line.
        while (i < n && (s[i] === " " || s[i] === "\t")) i++;
      } else {
        pushText("\n");
        i++;
      }
      continue;
    }

    // --- ordinary character ---------------------------------------------
    pushText(c);
    i++;
  }
  flushText();
  // Any "[" left over (active or deactivated) is literal text.
  closeLeftoverBrackets(tokens);
  return tokens;
}

function closeLeftoverBrackets(tokens) {
  for (let k = 0; k < tokens.length; k++) {
    const item = tokens[k];
    if (item.t === "open") {
      tokens[k] = { t: "text", s: (item.bang ? "!" : "") + "[" };
    } else if (item.t === "link" || item.t === "image") {
      closeLeftoverBrackets(item.children);
    }
  }
}

// --- entities ------------------------------------------------------------
// Returns {kind:'named', text, end} for &name; (any name passes through
// unchanged), {kind:'numeric', decoded, end} for a valid numeric reference,
// or null when the & is not an entity at all.
function scanEntity(s, i) {
  const n = s.length;
  if (s[i + 1] === "#") {
    let j = i + 2;
    let hex = false;
    if (s[j] === "x" || s[j] === "X") {
      hex = true;
      j++;
    }
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      const ok = hex
        ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
        : c >= 48 && c <= 57;
      if (!ok) break;
      j++;
    }
    if (j === start || j >= n || s[j] !== ";") return null;
    const body = (hex ? "x" : "") + s.slice(start, j);
    const decoded = decodeNumericEntity(body);
    if (decoded === null) return null;
    return { kind: "numeric", decoded, end: j + 1 };
  }
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    ) {
      j++;
    } else break;
  }
  if (j === i + 1 || j >= n || s[j] !== ";") return null;
  return { kind: "named", text: s.slice(i, j + 1), end: j + 1 };
}

// --- <...> autolinks ------------------------------------------------------
function isMailLocalChar(c) {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  if (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  ) {
    return true;
  }
  return ".!#$%&'*+/=?^_`{|}~-".indexOf(c) >= 0;
}

function isSchemeLetter(c) {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || c === "+" || c === "." || c === "-"
  );
}

// Bracket autolink email: local@domain (no dot required in the domain).
function checkBracketMail(text) {
  const at = text.indexOf("@");
  if (at <= 0) return false;
  for (let k = 0; k < at; k++) {
    if (!isMailLocalChar(text[k])) return false;
  }
  const domain = text.slice(at + 1);
  if (domain.length === 0) return false;
  const labels = domain.split(".");
  for (const label of labels) {
    if (label.length === 0) return false;
    if (!isAlnumChar(label[0]) || !isAlnumChar(label[label.length - 1])) return false;
    for (let k = 1; k < label.length - 1; k++) {
      const ch = label[k];
      if (!isAlnumChar(ch) && ch !== "-") return false;
    }
  }
  return true;
}

function matchAngleLink(s, i) {
  const n = s.length;
  let gt = i + 1;
  while (gt < n) {
    const c = s[gt];
    const code = s.charCodeAt(gt);
    if (c === ">") break;
    if (c === "<" || code <= 32 || code === 127) return null;
    gt++;
  }
  if (gt >= n) return null;
  const content = s.slice(i + 1, gt);
  if (content.length === 0) return null;
  // Scheme form: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:rest (scheme is 2-32 chars).
  const colon = content.indexOf(":");
  if (colon >= 2 && colon <= 32) {
    const scheme = content.slice(0, colon);
    if (/^[a-zA-Z][a-zA-Z0-9+.-]+$/.test(scheme)) {
      return {
        node: {
          t: "link", href: content, title: null, auto: true,
          children: [{ t: "text", s: content }],
        },
        end: gt + 1,
      };
    }
  }
  if (checkBracketMail(content)) {
    return {
      node: {
        t: "link", href: "mailto:" + content, title: null, auto: true,
        children: [{ t: "text", s: content }],
      },
      end: gt + 1,
    };
  }
  return null;
}

// --- raw inline HTML -------------------------------------------------------
const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*/;

function matchRawTag(s, i) {
  const n = s.length;
  // Comment.
  if (s.startsWith("<!--", i)) {
    if (s.startsWith("<!-->", i)) return { text: "<!-->", end: i + 5 };
    if (s.startsWith("<!--->", i)) return { text: "<!--->", end: i + 6 };
    const close = s.indexOf("-->", i + 4);
    if (close < 0) return null;
    // The comment ends at the first "-->"; "--" may appear inside it.
    return { text: s.slice(i, close + 3), end: close + 3 };
  }
  // Processing instruction.
  if (s.startsWith("<?", i)) {
    const close = s.indexOf("?>", i + 2);
    if (close < 0) return null;
    return { text: s.slice(i, close + 2), end: close + 2 };
  }
  // Declaration <!A ...>.
  if (s.startsWith("<!", i) && i + 2 < n && /[a-zA-Z]/.test(s[i + 2])) {
    const close = s.indexOf(">", i + 2);
    if (close < 0) return null;
    return { text: s.slice(i, close + 1), end: close + 1 };
  }
  // CDATA.
  if (s.startsWith("<![CDATA[", i)) {
    const close = s.indexOf("]]>", i + 9);
    if (close < 0) return null;
    return { text: s.slice(i, close + 3), end: close + 3 };
  }
  // Closing tag.
  if (s.startsWith("</", i)) {
    const m = TAG_NAME_RE.exec(s.slice(i + 2));
    if (!m) return null;
    let j = i + 2 + m[0].length;
    while (j < n && (s[j] === " " || s[j] === "\t" || s[j] === "\n")) j++;
    if (j >= n || s[j] !== ">") return null;
    return { text: s.slice(i, j + 1), end: j + 1 };
  }
  // Open tag.
  const m = TAG_NAME_RE.exec(s.slice(i + 1));
  if (!m) return null;
  let j = i + 1 + m[0].length;
  while (true) {
    // Whitespace before an attribute, "/>", or ">".
    let k = j;
    while (k < n && (s[k] === " " || s[k] === "\t" || s[k] === "\n" || s[k] === "\r" || s[k] === "\f")) k++;
    if (k < n && s[k] === ">") return { text: s.slice(i, k + 1), end: k + 1 };
    if (k < n && s[k] === "/" && k + 1 < n && s[k + 1] === ">") {
      return { text: s.slice(i, k + 2), end: k + 2 };
    }
    if (k === j) return null; // Expected whitespace or ">".
    j = k;
    // Attribute name.
    if (j >= n) return null;
    const attrStart = /[a-zA-Z_:]/.test(s[j]);
    if (!attrStart) return null;
    j++;
    while (j < n && /[a-zA-Z0-9_.:-]/.test(s[j])) j++;
    // Optional = value.
    let v = j;
    while (v < n && (s[v] === " " || s[v] === "\t" || s[v] === "\n")) v++;
    if (v < n && s[v] === "=") {
      v++;
      while (v < n && (s[v] === " " || s[v] === "\t" || s[v] === "\n")) v++;
      if (v >= n) return null;
      if (s[v] === '"' || s[v] === "'") {
        const q = s[v];
        v++;
        while (v < n && s[v] !== q) v++;
        if (v >= n) return null;
        v++;
      } else {
        while (v < n) {
          const ch = s[v];
          if (
            ch === " " || ch === "\t" || ch === "\n" || ch === '"' ||
            ch === "'" || ch === "=" || ch === "<" || ch === ">" || ch === "`"
          ) {
            break;
          }
          v++;
        }
        if (v === j) return null;
      }
      j = v;
    }
    // Loop for the next attribute.
    if (j >= n) return null;
  }
}

// --- extended autolinks (GFM) ----------------------------------------------
// Trim a matched extended URL: drop a trailing entity-like &...;, strip
// trailing punctuation, then balance parentheses. Repeats until stable.
const ENTITY_TAIL_RE = /^&(?:[A-Za-z0-9]+|#\d+|#[xX][0-9a-fA-F]+);$/;
function trimUrl(t) {
  let changed = true;
  while (changed) {
    changed = false;
    if (t.length > 0 && t.charCodeAt(t.length - 1) === 59) {
      const amp = t.lastIndexOf("&");
      if (amp >= 0 && ENTITY_TAIL_RE.test(t.slice(amp))) {
        t = t.slice(0, amp);
        changed = true;
        continue;
      }
    }
    if (t.length > 0) {
      const last = t.charCodeAt(t.length - 1);
      if (
        last === 63 || last === 33 || last === 46 || last === 44 ||
        last === 58 || last === 59 || last === 42 || last === 95 || last === 126
      ) {
        t = t.slice(0, -1);
        changed = true;
        continue;
      }
    }
    // Paren balancing, stack-based (not count-based):
    // - a "(" with no matching ")" later ends the URL there;
    // - a trailing ")" is dropped only if it is unmatched (no "("
    //   before it that it closes); a matched trailing ")" is kept,
    //   e.g. "...page=4)](./docs/create.md)" keeps its final ")",
    //   while a lone trailing ")" in "foo)" is dropped. A ")"
    //   with no matching "(" is ordinary URL text and is kept
    //   when it is not trailing (e.g. "foo)bar" stays whole).
    {
      const stack = [];
      const matchedClose = new Set();
      for (let k = 0; k < t.length; k++) {
        if (t[k] === "(") stack.push(k);
        else if (t[k] === ")") {
          if (stack.length > 0) {
            stack.pop();
            matchedClose.add(k);
          }
        }
      }
      if (stack.length > 0) {
        t = t.slice(0, stack[0]);
        changed = true;
        continue;
      }
      while (
        t.length > 0 &&
        t.charCodeAt(t.length - 1) === 41 &&
        !matchedClose.has(t.length - 1)
      ) {
        t = t.slice(0, -1);
        changed = true;
      }
    }
  }
  return t;
}

function isUrlByte(c) {
  const code = c.charCodeAt(0);
  return code > 32 && c !== "<" && code !== 127;
}

// Does s start with http://, https:// or ftp:// (any case) at i?
function hasKnownScheme(s, i) {
  const rest = s.slice(i, i + 8).toLowerCase();
  return (
    rest.startsWith("http://") || rest.startsWith("https://") ||
    rest.startsWith("ftp://")
  );
}

// Match a www. or scheme:// extended autolink starting at i.
// prefixLen is 4 for "www." (the domain starts after it) and 0 for a
// scheme:// URL (the whole match, scheme included, starts at i).
function matchExtendedLink(s, i, prefixLen) {
  const n = s.length;
  let dstart = i + prefixLen;
  if (prefixLen === 0) {
    const m = /^(?:https?|ftp):\/\//i.exec(s.slice(i));
    if (!m) return null;
    dstart = i + m[0].length;
  }
  if (dstart >= n) return null;
  const first = s[dstart];
  const fc = first.charCodeAt(0);
  const firstOk =
    (fc >= 48 && fc <= 57) || (fc >= 65 && fc <= 90) ||
    (fc >= 97 && fc <= 122) || first === "-" || first === "_";
  if (!firstOk) return null;
  let j = dstart + 1;
  while (j < n) {
    const c = s[j];
    const code = s.charCodeAt(j);
    if (
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) || c === "." || c === "-" || c === "_"
    ) {
      j++;
    } else break;
  }
  // The rest of the URL: anything but whitespace, "<", or control chars.
  while (j < n && isUrlByte(s[j])) j++;
  let text = s.slice(i, j);
  text = trimUrl(text);
  if (text.length === 0) return null;
  const href = prefixLen === 4 ? "http://" + text : text;
  return {
    node: {
      t: "link", href, title: null, auto: true, ext: true,
      children: [{ t: "text", s: text }],
    },
    end: i + text.length,
  };
}

// Parse an email domain starting at i (right after "@").
// Returns the end offset of the domain, or -1 if invalid. The domain needs
// at least one dot; the first label is any run of [A-Za-z0-9_-], later
// labels must end in an alphanumeric; if the character after the domain is
// [A-Za-z0-9_-], the last dot-group is dropped and the check repeats.
function parseMailDomain(s, i, openUnderscoreLens) {
  const n = s.length;
  const ends = [];
  let j = i;
  // First label: [A-Za-z0-9_-]+.
  const firstStart = j;
  while (j < n) {
    const c = s[j];
    const code = s.charCodeAt(j);
    if (
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) || c === "-" || c === "_"
    ) {
      j++;
    } else break;
  }
  if (j === firstStart) return -1;
  ends.push(j);
  // Dot-groups.
  while (j < n && s[j] === ".") {
    let k = j + 1;
    const labelStart = k;
    while (k < n) {
      const c = s[k];
      const code = s.charCodeAt(k);
      if (
        (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) || c === "-" || c === "_"
      ) {
        k++;
      } else break;
    }
    // Trim trailing - / _ (label must end alphanumeric).
    let labelEnd = k;
    while (labelEnd > labelStart) {
      const c = s[labelEnd - 1];
      if (c === "-" || c === "_") labelEnd--;
      else break;
    }
    if (labelEnd === labelStart) break; // Empty label: no more groups.
    ends.push(labelEnd);
    j = k;
  }
  if (ends.length < 2) return -1;
  // Lookahead: the character after the domain must not be [A-Za-z0-9_-].
  while (ends.length >= 2) {
    const end = ends[ends.length - 1];
    if (end < n) {
      const c = s[end];
      const code = s.charCodeAt(end);
      const inSet =
        (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) || c === "-" || c === "_";
      if (inSet) {
        // A "_" run after the domain does not force a backtrack when
        // its length exactly matches an opening "_" delimiter seen
        // earlier in this run (e.g. "__...because@mark.example.com__"
        // or "_..._"): the run is the closing delimiter, a boundary,
        // not part of the address. Otherwise it is address text and
        // the group is dropped, as in "foo@bar.baz.com_".
        if (c === "_" && openUnderscoreLens) {
          let run = 0;
          while (end + run < n && s[end + run] === "_") run++;
          if (openUnderscoreLens.has(run)) return end;
        }
        ends.pop();
        continue;
      }
    }
    return end;
  }
  return -1;
}

// Match a plain email autolink starting at i (start of the local part).
function matchMailLink(s, i, openUnderscoreLens) {
  const n = s.length;
  let j = i;
  while (j < n && isMailLocalChar(s[j])) j++;
  if (j === i || j >= n || s[j] !== "@") return null;
  const domainEnd = parseMailDomain(s, j + 1, openUnderscoreLens);
  if (domainEnd < 0) return null;
  const text = s.slice(i, domainEnd);
  return {
    node: {
      t: "link", href: "mailto:" + text, title: null, auto: true, ext: true,
      children: [{ t: "text", s: text }],
    },
    end: domainEnd,
  };
}

// Match a scheme:email autolink starting at i (start of a lowercase word).
// After the email, one path segment of [A-Za-z0-9.@]+ may follow.
function matchSchemeMail(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && isSchemeLetter(s[j])) j++;
  const scheme = s.slice(i, j);
  if (scheme.length < 2) return null;
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;
  if (j >= n || s[j] !== ":") return null;
  let k = j + 1;
  const localStart = k;
  while (k < n && isMailLocalChar(s[k])) k++;
  if (k === localStart || k >= n || s[k] !== "@") return null;
  const domainEnd = parseMailDomain(s, k + 1);
  if (domainEnd < 0) return null;
  let end = domainEnd;
  if (end < n && s[end] === "/") {
    let m = end + 1;
    while (m < n) {
      const c = s[m];
      const code = s.charCodeAt(m);
      if (
        (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) || c === "." || c === "@"
      ) {
        m++;
      } else break;
    }
    if (m > end + 1) end = m;
  }
  let text = s.slice(i, end);
  // Strip trailing punctuation from the path segment.
  while (text.length > 0) {
    const last = text.charCodeAt(text.length - 1);
    if (
      last === 63 || last === 33 || last === 46 || last === 44 ||
      last === 58 || last === 59 || last === 42 || last === 95 || last === 126
    ) {
      text = text.slice(0, -1);
    } else break;
  }
  if (text.length === 0) return null;
  return {
    node: {
      t: "link", href: text, title: null, auto: true, ext: true,
      children: [{ t: "text", s: text }],
    },
    end: i + text.length,
  };
}

// --- link suffix parsing ---------------------------------------------------
// Parses what may follow a "]" in the source string s at offset pos.
// Returns null (not a link), or:
//   {kind:'inline', href, title, end}
//   {kind:'ref', label, end}        full reference [text][label]
//   {kind:'collapsed', end}         [text][]
//   {kind:'shortcut', end}          [text] with no suffix
function skipSpaces(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
    else break;
  }
  return i;
}

function parseLinkTail(s, pos) {
  const n = s.length;
  // The "(" or "[" must immediately follow the "]": no whitespace
  // (a space or newline means this is not an inline link or a full
  // reference link, and the caller falls back to the shortcut form).
  let i = pos;
  if (i < n && s[i] === "(") {
    i++;
    i = skipSpaces(s, i);
    let dest = "";
    if (i < n && s[i] === "<") {
      let j = i + 1;
      let ok = false;
      while (j < n) {
        const c = s[j];
        if (c === "\n") return null;
        if (c === "<") return null;
        if (c === ">") {
          ok = true;
          break;
        }
        if (c === "\\" && j + 1 < n) {
          const d = s[j + 1];
          const dc = d.charCodeAt(0);
          if (dc < 128 && ASCII_PUNCT_BITS[dc] === 1) {
            dest += d;
            j += 2;
            continue;
          }
        }
        dest += c;
        j++;
      }
      if (!ok) return null;
      i = j + 1;
    } else {
      let depth = 0;
      let j = i;
      while (j < n) {
        const c = s[j];
        const code = s.charCodeAt(j);
        if (c === " " || c === "\t" || c === "\n" || c === "\r" || code < 32) break;
        if (c === "\\" && j + 1 < n) {
          const d = s[j + 1];
          const dc = d.charCodeAt(0);
          if (dc < 128 && ASCII_PUNCT_BITS[dc] === 1) {
            dest += d;
            j += 2;
            continue;
          }
        }
        if (c === "(") {
          depth++;
          dest += c;
          j++;
          continue;
        }
        if (c === ")") {
          if (depth === 0) break;
          depth--;
          dest += c;
          j++;
          continue;
        }
        dest += c;
        j++;
      }
      if (j === i) {
        // An empty destination is allowed: [link]().
        dest = "";
      }
      i = j;
    }
    i = skipSpaces(s, i);
    let title = null;
    if (i < n && (s[i] === '"' || s[i] === "'" || s[i] === "(")) {
      const q = s[i];
      const closeQ = q === "(" ? ")" : q;
      let j = i + 1;
      let ok = false;
      while (j < n) {
        const c = s[j];
        if (c === closeQ) {
          ok = true;
          break;
        }
        if (c === "\\" && j + 1 < n) {
          const d = s[j + 1];
          const dc = d.charCodeAt(0);
          if (dc < 128 && ASCII_PUNCT_BITS[dc] === 1) {
            title = (title === null ? "" : title) + d;
            j += 2;
            continue;
          }
        }
        title = (title === null ? "" : title) + c;
        j++;
      }
      if (!ok) return null;
      i = j + 1;
      i = skipSpaces(s, i);
    }
    if (i >= n || s[i] !== ")") return null;
    return { kind: "inline", href: dest, title, end: i + 1 };
  }
  if (i < n && s[i] === "[") {
    // A link label must not contain an unescaped "["; escaped brackets
    // are kept raw (labels are matched on their raw text).
    let j = i + 1;
    let label = "";
    while (j < n) {
      const c = s[j];
      if (c === "\\" && j + 1 < n) {
        const d = s[j + 1];
        if (d === "[" || d === "]") {
          label += c + d;
          j += 2;
          continue;
        }
        label += c;
        j++;
        continue;
      }
      if (c === "[") return null;
      if (c === "]") break;
      label += c;
      j++;
    }
    if (j >= n || s[j] !== "]") return null;
    if (label === "") return { kind: "collapsed", end: j + 1 };
    return { kind: "ref", label, end: j + 1 };
  }
  return { kind: "shortcut", end: pos };
}

// Does any node (or a descendant) contain an explicit link? A link's
// text may hold images, emphasis and autolinks, but not another
// explicitly-written link.
function hasNestedLink(nodes) {
  for (const node of nodes) {
    if (node.t === "link" && !node.auto) return true;
    if (node.children && hasNestedLink(node.children)) return true;
  }
  return false;
}

// Demote extended autolinks that are direct children of a link that
// has just formed back to plain text: marked renders no link inside
// a link, so "[see https://x.io here](u)" keeps the URL as text,
// whether the URL sits before an inner "]" or after one ("[a
// ![b](img) https://x.io c](u)"). Bracket autolinks (no ext flag)
// are left alone — marked keeps them as links inside a formed link
// (doc-08). Nested link/image children are not walked: an autolink
// inside one already got its fate when that child formed, and an
// image's alt text is plain text either way.
function demoteExtendedLinks(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    if (node.t === "link" && node.ext) {
      nodes[k] = { t: "text", s: collectText(node.children) };
    }
  }
}

// Probed 16 Nov 2026 (probe79/80/81): a link does not form when its
// text contains a code span whose content includes a backtick and
// there is any content after that code span before the closing `]`
// (even just spaces, another code span, or emphasis). When the
// backtick-containing code span is the last item in the link text,
// the link forms normally.
function hasBacktickTail(nodes) {
  for (let k = 0; k < nodes.length - 1; k++) {
    const node = nodes[k];
    if (node.t === "code" && typeof node.s === "string" && node.s.includes("`")) return true;
  }
  return false;
}

// Plain text of a list of nodes (used for image alt text and link labels).
// Delimiter and bracket tokens are included raw: labels are computed from
// the scanned tokens, before emphasis runs.
export function collectText(nodes) {
  let out = "";
  for (const node of nodes) {
    switch (node.t) {
      case "text":
        out += node.s;
        break;
      case "code":
        out += node.s;
        break;
      case "html":
        out += node.s;
        break;
      case "br":
        out += "\n";
        break;
      case "delim":
        out += node.ch.repeat(node.len);
        break;
      case "open":
        out += (node.bang ? "!" : "") + "[";
        break;
      case "close":
        out += "]";
        break;
      case "link":
      case "em":
      case "strong":
      case "del":
        out += collectText(node.children);
        break;
      case "image":
        out += collectText(node.children);
        break;
      default:
        break;
    }
  }
  return out;
}

// Hidden spans for emphasis (probed 16 Nov 2026, doc-09): marked
// masks an inline string before looking for emphasis closers, by
// pairing backtick runs left to right — a run pairs with the nearest
// later run of exactly the same length, and the text between a pair
// is hidden, so a "*" / "_" delimiter inside it cannot close (an
// opener inside it still can: it pairs with a later visible closer,
// e.g. "[docs ``url`](u) and _a_ here `code` and b_" forms an <em>
// spanning the code span). An escaped backtick reached directly is
// masked and is not a run, but one reached as the closer of an
// earlier run does count (the "[docs ``url`](u) and _em_ here \`"
// case). "~" delimiters are never hidden (del forms normally).
// Returns absolute [start, end) source ranges of the paired spans
// within s[lo, hi).
function maskedBacktickRanges(s, lo, hi) {
  // Fast path: no backtick in the range, no spans (native scan).
  if (s.indexOf("`", lo) < 0 || s.indexOf("`", lo) >= hi) return [];
  // Collect maximal backtick runs in the range.
  const runs = [];
  let i = lo;
  while (i < hi) {
    if (s[i] === "`") {
      let j = i;
      while (j < hi && s[j] === "`") j++;
      runs.push({ start: i, end: j, len: j - i });
      i = j;
    } else {
      i++;
    }
  }
  const spans = [];
  let k = 0;
  while (k < runs.length) {
    const r = runs[k];
    // An escaped run (odd number of backslashes before it) is masked
    // and cannot open a pair — unless an earlier run already claimed
    // it as its closer (handled by the partner search below, which
    // does not check escaping).
    let b = r.start - 1;
    let slashes = 0;
    while (b >= lo && s[b] === "\\") {
      slashes++;
      b--;
    }
    if (slashes % 2 === 1) {
      k++;
      continue;
    }
    let j = k + 1;
    while (j < runs.length && runs[j].len !== r.len) j++;
    if (j < runs.length) {
      spans.push([r.start, runs[j].end]);
      k = j + 1;
    } else {
      k++;
    }
  }
  return spans;
}

// --- emphasis --------------------------------------------------------------
// Delimiter-stack algorithm (CommonMark). Closers are processed left to
// right; each looks back through the stack of openers for the first match
// with the same character that is not an "odd match" (the rule of 3s: the
// sum of the two lengths is divisible by 3 while neither length is). A
// match of two or more delimiters on both sides is strong, otherwise em.
// A "~" pair is a <del> and needs one or two tildes, the same number on
// each side (a run of three or more never forms a <del>).
// Link and image nodes are opaque here; their children are processed first.
// s is the source of this inline string and ls/le its range within it:
// a link's text is masked against its label alone (marked tokenizes a
// link's text separately), so the recursion passes each node's ls/le.
export function resolveEmphasis(tokens, s, ls, le) {
  for (const item of tokens) {
    if (item.t === "link" || item.t === "image") {
      // Autolinks carry no ls/le (their children hold no delimiters);
      // fall back to this level's range for them.
      resolveEmphasis(
        item.children,
        s,
        item.ls === undefined ? ls : item.ls,
        item.le === undefined ? le : item.le,
      );
    }
  }
  // Pre-pass (probed 16 Nov 2026, doc-09): a "*" / "_" delimiter
  // whose source position lies inside a hidden span (see
  // maskedBacktickRanges) cannot close emphasis. Only canClose is
  // cleared — the delimiter may still open, and pair with a later
  // visible closer. Delimiters outside any span are untouched, and
  // "~" is never touched.
  const spans = maskedBacktickRanges(s, ls, le);
  if (spans.length > 0) {
    for (const it of tokens) {
      if (
        it.t === "delim" &&
        (it.ch === "*" || it.ch === "_") &&
        it.canClose &&
        typeof it.pos === "number"
      ) {
        for (const sp of spans) {
          if (it.pos > sp[0] && it.pos < sp[1]) {
            it.canClose = false;
            break;
          }
        }
      }
    }
  }
  const stack = []; // Delim tokens that can open, in encounter order.
  const bottom = { "*": -1, "_": -1, "~": -1 };
  // Strict rule-of-3s flag, per character: once a delimiter that can
  // both open and close has been used as a closer, the rule of 3s
  // applies strictly to later pairs of that character (even when
  // neither side can both open and close), until a match by a
  // close-only delimiter clears it again. This is what makes
  // "**a *b*c* d**" form a <strong> (the "*" after "c" may not take
  // one delimiter from the "**" opener) while "**a *b* c* d**" nests
  // <em>s instead. The flag is scoped: it only applies to an opener
  // that was already open when the both-closer matched (its seq is at
  // most oddStrictCutoff); an opener created after that match starts a
  // fresh emphasis region and is not blocked by it. Without the scope,
  // a completed <em> earlier in a paragraph would wrongly block a
  // later independent nesting such as "*using *type guide in**".
  const oddStrict = { "*": false, "_": false, "~": false };
  const oddStrictCutoff = { "*": -1, "_": -1, "~": -1 };
  // Length of the both-closer that set the strict flag (see below).
  const oddStrictLen = { "*": 0, "_": 0, "~": 0 };
  let ci = 0;
  while (ci < tokens.length) {
    const item = tokens[ci];
    if (item.t !== "delim") {
      ci++;
      continue;
    }
    const d = item;
    if (d.canClose) {
      let found = -1;
      let oddSkipped = -1;
      for (let k = stack.length - 1; k > bottom[d.ch]; k--) {
        const o = stack[k];
        if (o.ch !== d.ch) continue;
        if (d.ch === "~" && (o.len !== d.len || o.len > 2)) continue;
        // The rule of 3s applies when one of the two delimiters can
        // both open and close emphasis, or while the strict flag for
        // this character is set (see above) and the opener predates
        // the both-closer match that set it; otherwise a pair whose
        // lengths sum to a multiple of 3 still matches. While strict,
        // the pair is blocked when the opener sums with the length of
        // the both-closer itself to a multiple of 3 and either the
        // pair also sums to a multiple of 3 or the closer is a single
        // delimiter: that keeps "*a **b**c*" literal (1 + 2 is a
        // multiple of 3, closer length 1) while "*a *b*c*" still
        // nests (its both-closer has length 1) and "*changes
        // *else*returns**" still forms its outer <em> (the closer
        // has length 2 and 1 + 2 is a multiple of 3 only via the
        // pair sum, not via the both-closer length 1).
        const eitherBoth =
          (o.canOpen && o.canClose) || (d.canOpen && d.canClose);
        const strict =
          oddStrict[d.ch] && o.seq <= oddStrictCutoff[d.ch];
        const sumMod3 = (o.len + d.len) % 3 === 0;
        const strictSumMod3 =
          (o.len + oddStrictLen[d.ch]) % 3 === 0;
        const odd =
          (eitherBoth && sumMod3 && o.len % 3 !== 0) ||
          (strict &&
            o.len % 3 !== 0 &&
            ((sumMod3 && (d.len === 1 || strictSumMod3)) ||
              (d.len === 1 && strictSumMod3)));
        if (odd) {
          if (oddSkipped < 0) oddSkipped = k;
          continue;
        }
        found = k;
        break;
      }
      if (found >= 0) {
        const opener = stack[found];
        const use =
          d.ch === "~" ? opener.len : opener.len >= 2 && d.len >= 2 ? 2 : 1;
        const oi = tokens.indexOf(opener);
        const children = tokens.slice(oi + 1, ci);
        // Delimiters wrapped inside the new node can no longer open.
        for (const child of children) {
          if (child.t === "delim") child.dead = true;
        }
        const tag = d.ch === "~" ? "del" : use === 2 ? "strong" : "em";
        const node = { t: tag, children };
        const replacement = [];
        let leftoverOpener = null;
        let leftoverCloser = null;
        if (opener.len > use) {
          leftoverOpener = {
            t: "delim", ch: d.ch, len: opener.len - use,
            canOpen: opener.canOpen, canClose: opener.canClose,
            seq: opener.seq,
          };
          replacement.push(leftoverOpener);
        }
        replacement.push(node);
        if (d.len > use) {
          leftoverCloser = {
            t: "delim", ch: d.ch, len: d.len - use,
            canOpen: d.canOpen, canClose: d.canClose,
            seq: d.seq,
          };
          // A leftover closer delimiter goes INSIDE the new node only
          // for a "*" <strong> (use 2) when the text immediately
          // before the closer run directly follows an inner
          // emphasis/link/code node with no space (e.g. "**a *b*c***"
          // -> "<strong>a <em>b</em>c*</strong>"); it stays outside
          // for "_" ("__a *b*c___" -> leftover outside), for <em>
          // ("*a `code`c**" -> leftover outside), and when the
          // preceding text starts with a space or is plain text
          // ("**a *b* c***", "**foo***" -> leftover outside).
          // Probed 16 Nov 2026.
          const before = tokens[ci - 1];
          const before2 = ci >= 2 ? tokens[ci - 2] : null;
          if (
            d.ch === "*" &&
            use === 2 &&
            !leftoverCloser.canOpen &&
            before &&
            before.t === "text" &&
            before.s !== "" &&
            before.s.charCodeAt(0) !== 32 &&
            before.s.charCodeAt(0) !== 9 &&
            before2 &&
            (before2.t === "em" || before2.t === "strong")
          ) {
            children.push(leftoverCloser);
            leftoverCloser = null;
          } else {
            replacement.push(leftoverCloser);
          }
        }
        tokens.splice(oi, ci - oi + 1, ...replacement);
        // Rebuild the stack: drop the opener and anything now inside
        // the node; keep the leftover opener at the opener's place.
        const kept = [];
        for (let k = 0; k < stack.length; k++) {
          if (k === found) {
            if (leftoverOpener) kept.push(leftoverOpener);
            continue;
          }
          if (!stack[k].dead) kept.push(stack[k]);
        }
        stack.length = 0;
        for (const s2 of kept) stack.push(s2);
        bottom[d.ch] = -1;
        // A closer that can both open and close switches the rule of
        // 3s to strict for this character, scoped to the openers that
        // were already on the stack when it matched — but only when
        // the opener it matched was open-only. When the opener was
        // itself a both-delimiter (as in "*foo**bar**baz*", where the
        // inner ** can both open and close), the flag is left alone
        // and the outer pair still matches. A close-only closer
        // clears the flag again.
        if (d.canOpen && d.canClose && !opener.canClose) {
          oddStrict[d.ch] = true;
          oddStrictLen[d.ch] = d.len;
          let cutoff = -1;
          for (let k = stack.length - 1; k >= 0; k--) {
            if (stack[k].ch === d.ch) {
              cutoff = stack[k].seq;
              break;
            }
          }
          oddStrictCutoff[d.ch] = cutoff;
        } else if (!d.canOpen || !d.canClose) {
          oddStrict[d.ch] = false;
          oddStrictLen[d.ch] = 0;
          oddStrictCutoff[d.ch] = -1;
        }
        ci = oi + replacement.length - (leftoverCloser ? 1 : 0);
        continue;
      }
      // Note: no "bottom" advance here. The odd rule is evaluated per
      // (opener, closer) pair and depends on both lengths, so an
      // opener skipped by one closer (e.g. a length-1 closer failing
      // against a length-2 opener whose sum is a multiple of 3) may
      // still match a later closer of a different length (e.g. the
      // final "**" matching the outer "**" in "**removes example
      // *input **parse**parse* release**"). Advancing a per-character
      // bottom on an odd skip would wrongly block that later match.
    }
    if (d.canOpen) stack.push(d);
    ci++;
  }
  // Whatever is left over is literal text, anywhere in the tree.
  delimsToText(tokens);
}

// Turn leftover delimiter tokens into literal text, everywhere in the tree.
function delimsToText(tokens) {
  for (let k = 0; k < tokens.length; k++) {
    const item = tokens[k];
    if (item.t === "delim") {
      tokens[k] = { t: "text", s: item.ch.repeat(item.len) };
    } else if (item.children) {
      delimsToText(item.children);
    }
  }
}

// Parse one inline string into a list of nodes.
export function parseInlineText(s, refs) {
  if (s === "") return [];
  const tokens = tokenizeInline(s, refs);
  resolveEmphasis(tokens, s, 0, s.length);
  return tokens;
}

// Render inline nodes to HTML.
export function renderInlineNodes(nodes, out) {
  for (const node of nodes) {
    switch (node.t) {
      case "text":
        out.push(escapeAttr(node.s));
        break;
      case "code":
        out.push("<code>", escapeRaw(node.s), "</code>");
        break;
      case "html":
        out.push(node.s);
        break;
      case "br":
        out.push("<br>");
        break;
      case "em":
        out.push("<em>");
        renderInlineNodes(node.children, out);
        out.push("</em>");
        break;
      case "strong":
        out.push("<strong>");
        renderInlineNodes(node.children, out);
        out.push("</strong>");
        break;
      case "del":
        out.push("<del>");
        renderInlineNodes(node.children, out);
        out.push("</del>");
        break;
      case "link": {
        out.push('<a href="', sanitizeHref(node.href), '"');
        if (node.title !== null && node.title !== undefined) {
          out.push(' title="', escapeAttr(node.title), '"');
        }
        out.push(">");
        renderInlineNodes(node.children, out);
        out.push("</a>");
        break;
      }
      case "image": {
        out.push('<img src="', sanitizeHref(node.src), '" alt="');
        out.push(escapeAttr(collectText(node.children)));
        out.push('"');
        if (node.title !== null && node.title !== undefined) {
          out.push(' title="', escapeAttr(node.title), '"');
        }
        out.push(">");
        break;
      }
      default:
        break;
    }
  }
}

// Render inline nodes to a single HTML string.
export function inlineToHtml(s, refs) {
  const out = [];
  renderInlineNodes(parseInlineText(s, refs), out);
  return out.join("");
}
