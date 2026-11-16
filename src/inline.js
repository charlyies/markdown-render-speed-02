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
export function tokenizeInline(src, refs) {
  const len = src.length;
  const out = [];
  const openers = []; // indices into out of active "[" openers
  // Source index of a "]" that a code-span search stopped at because the
  // span was broken there (see the code-span search below); a later
  // backtick opener before that "]" may not search past it.
  let fenceAt = -1;
  let buf = "";
  let pos = 0;
  // Sequence number for emphasis delimiters, in encounter order; used by
  // resolveEmphasis to scope the strict rule-of-3s flag (see there).
  let seqNo = 0;

  function flushText() {
    if (buf !== "") {
      out.push({ t: "text", s: buf });
      buf = "";
    }
  }
  function pushText(str) {
    buf += str;
  }
  // A literal "&" that must always be escaped (from \& or &#38;) gets its
  // own text token, so it can never join up with a following "name;" and
  // look like a named entity when the run is escaped.
  function pushAmp() {
    flushText();
    out.push({ t: "text", s: "&" });
  }
  // Is position pos the start of an email local-part run? The raw
  // preceding character is not enough: "*" (and "_" / "~") is both an
  // email local character and an emphasis delimiter, so after "**"
  // the email does start even though src[pos-1] is "*". Use the tokenized
  // state instead: if pending text ends in a local character we are
  // mid-run; a just-closed delimiter / code / tag is a boundary.
  function atMailRunStart() {
    if (buf !== "") return !isMailLocalChar(buf[buf.length - 1]);
    if (out.length === 0) return true;
    const last = out[out.length - 1];
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
  function autolinkBarred(at, end) {
    if (openers.length === 0) return false;
    // First "]" inside the span (bounded scan — an unbounded
    // indexOf would run to the end of the string on every match).
    let k = -1;
    for (let p = at; p < end; p++) {
      if (src[p] === "]") {
        k = p;
        break;
      }
    }
    if (k < 0) return false;
    let oi = -1;
    for (let q = openers.length - 1; q >= 0; q--) {
      if (out[openers[q]].active) {
        oi = openers[q];
        break;
      }
    }
    if (oi < 0) return false;
    const opener = out[oi];
    const suffix = parseLinkTail(src, k + 1);
    let formed;
    if (suffix && suffix.kind === "inline") {
      formed = true;
    } else if (suffix && suffix.kind === "ref") {
      formed = !!refs.get(foldLinkLabel(suffix.label));
    } else {
      // Collapsed / shortcut / malformed suffix: shortcut fallback
      // on the raw label text.
      formed = !!refs.get(foldLinkLabel(src.slice(opener.end, k)));
    }
    if (!formed) return false;
    const children = out.slice(oi + 1);
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

  while (pos < len) {
    const c = src[pos];

    // --- backslash escapes / hard break -------------------------------
    if (c === "\\") {
      if (pos + 1 < len) {
        const d = src[pos + 1];
        if (d === "\n") {
          flushText();
          out.push({ t: "br" });
          pos += 2;
          // A hard break strips the leading whitespace of the next line.
          while (pos < len && (src[pos] === " " || src[pos] === "\t")) pos++;
          continue;
        }
        const dc = d.charCodeAt(0);
        if (dc < 128 && ASCII_PUNCT_BITS[dc] === 1) {
          if (d === "&") pushAmp();
          else pushText(d);
          pos += 2;
          continue;
        }
      }
      pushText("\\");
      pos++;
      continue;
    }

    // --- code spans ----------------------------------------------------
    if (c === "`") {
      let j = pos;
      while (j < len && src[j] === "`") j++;
      const ticks = j - pos;
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
        fenceAt >= 0 && pos < fenceAt ? fenceAt : len;
      while (k < searchEnd) {
        if (src[k] === "`") {
          let m = k;
          while (m < searchEnd && src[m] === "`") m++;
          if (m - k === ticks) {
            found = k;
            break;
          }
          sawOtherLen = true;
          k = m;
        } else if (
          src[k] === "]" &&
          sawOtherLen &&
          openers.some((idx) => out[idx].active) &&
          parseLinkTail(src, k + 1)
        ) {
          fenceAt = k;
          break;
        } else {
          k++;
        }
      }
      if (found >= 0) {
        let content = src.slice(j, found).replace(/\n/g, " ");
        if (
          content.length >= 2 &&
          content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32 &&
          content.trim() !== ""
        ) {
          content = content.slice(1, -1);
        }
        flushText();
        out.push({ t: "code", s: content });
        pos = found + ticks;
        continue;
      }
      pushText(src.slice(pos, j));
      pos = j;
      continue;
    }

    // --- < : autolinks and raw HTML ------------------------------------
    if (c === "<") {
      const auto = matchAngleLink(src, pos);
      if (auto) {
        flushText();
        out.push(auto.node);
        pos = auto.end;
        continue;
      }
      const tag = matchRawTag(src, pos);
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
        out.push({ t: "html", s: tag.text });
        pos = tag.end;
        continue;
      }
      pushText("<");
      pos++;
      continue;
    }

    // --- entities ------------------------------------------------------
    if (c === "&") {
      const ent = scanEntity(src, pos);
      if (ent) {
        if (ent.kind === "named") {
          pushText(ent.text);
        } else if (ent.decoded === "&") {
          pushAmp();
        } else {
          pushText(ent.decoded);
        }
        pos = ent.end;
        continue;
      }
      pushAmp();
      pos++;
      continue;
    }

    // --- images / links -------------------------------------------------
    // A "]" is resolved right here, while the suffix text ahead has not
    // been scanned yet, so no text run can ever straddle a link boundary.
    if (c === "!" && pos + 1 < len && src[pos + 1] === "[") {
      flushText();
      openers.push(out.length);
      out.push({ t: "open", bang: true, pos: pos + 1, end: pos + 2, active: true });
      pos += 2;
      continue;
    }
    if (c === "[") {
      flushText();
      openers.push(out.length);
      out.push({ t: "open", bang: false, pos, end: pos + 1, active: true });
      pos++;
      continue;
    }
    if (c === "]") {
      flushText();
      if (pos >= fenceAt) fenceAt = -1;
      let openerIdx = -1;
      for (let k = openers.length - 1; k >= 0; k--) {
        const oi = openers[k];
        if (out[oi].active) {
          openerIdx = oi;
          openers.splice(k, 1);
          break;
        }
      }
      if (openerIdx < 0) {
        pushText("]");
        pos++;
        continue;
      }
      const opener = out[openerIdx];
      const suffix = parseLinkTail(src, pos + 1);
      let href = null;
      let title = null;
      let failed = false;
      let isShortcut = false;
      if (!suffix) {
        // The inline link failed to parse (or the label was malformed):
        // fall back to the shortcut form, leaving the failed suffix as
        // literal text. A full reference label that simply is not
        // defined does NOT fall back (that case returns a "ref" suffix).
        const label = foldLinkLabel(src.slice(opener.end, pos));
        const ref = refs.get(label);
        if (ref && (opener.bang || !hasNestedLink(out.slice(openerIdx + 1)))) {
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
        const label = foldLinkLabel(src.slice(opener.end, pos));
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
        pos++;
        continue;
      }
      // A link cannot contain another link (an image's text may, its
      // link becomes part of the alt text).
      if (!opener.bang && hasNestedLink(out.slice(openerIdx + 1))) {
        opener.active = false;
        pushText("]");
        pos++;
        continue;
      }
      // A code span containing a backtick, with content after it in
      // the link text, prevents the link from forming (probe79/80/81);
      // marked also renders every emphasis delimiter in that link
      // text literally (probe82), so deactivate them all.
      if (hasBacktickTail(out.slice(openerIdx + 1))) {
        for (let k = openerIdx + 1; k < out.length; k++) {
          if (out[k].t === "delim") {
            out[k].canOpen = false;
            out[k].canClose = false;
          }
        }
        opener.active = false;
        pushText("]");
        pos++;
        continue;
      }
      const children = out.splice(openerIdx + 1);
      out.splice(openerIdx, 1);
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
      for (let k = openers.length - 1; k >= 0; k--) {
        if (openers[k] >= openerIdx) openers.splice(k, 1);
      }
      let node;
      // ls/le: source range of the link text, so emphasis inside it
      // can be masked against the label alone (marked tokenizes a
      // link's text separately from the surrounding text).
      if (opener.bang) {
        node = { t: "image", src: href, title, children, ls: opener.end, le: pos };
      } else {
        node = { t: "link", href, title, children, ls: opener.end, le: pos };
      }
      out.push(node);
      pos = isShortcut ? pos + 1 : suffix.end;
      continue;
    }

    // --- emphasis / strikethrough delimiters ---------------------------
    if (c === "*" || c === "_" || c === "~") {
      let j = pos;
      while (j < len && src[j] === c) j++;
      const runLen = j - pos;
      const before = pos > 0 ? src[pos - 1] : " ";
      const after = j < len ? src[j] : " ";
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
      out.push({ t: "delim", ch: c, len: runLen, canOpen, canClose, seq: seqNo++, pos });
      pos = j;
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
    if (extOk && c === "w" && src.startsWith("www.", pos)) {
      const prev = pos > 0 ? src[pos - 1] : " ";
      if (
        pos === 0 || isUnicodeSpaceChar(prev) || prev === "*" || prev === "_" ||
        prev === "~" || prev === "("
      ) {
        const ext = matchExtendedLink(src, pos, 4);
        if (ext && !autolinkBarred(pos, ext.end)) {
          flushText();
          out.push(ext.node);
          pos = ext.end;
          continue;
        }
      }
    }
    if (extOk && (c === "h" || c === "H" || c === "f" || c === "F") && hasKnownScheme(src, pos)) {
      const ext = matchExtendedLink(src, pos, 0);
      if (ext && !autolinkBarred(pos, ext.end)) {
        flushText();
        out.push(ext.node);
        pos = ext.end;
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
    // open "_" delimiters is O(out) and must not run for every word
    // (matchMailLink returns null without "@" anyway).
    if (extOk && isMailLocalChar(c)) {
      let runStart;
      if (pos === 0) {
        runStart = true;
      } else {
        const prev = src.charCodeAt(pos - 1);
        if (prev === 42 || prev === 95 || prev === 126) {
          runStart = atMailRunStart();
        } else if (
          prev === 32 || prev === 10 || prev === 9 ||
          !isMailLocalChar(src[pos - 1])
        ) {
          runStart = true;
        } else {
          runStart = false;
        }
      }
      if (runStart) {
        let j = pos;
        while (j < len && isMailLocalChar(src[j])) j++;
        if (j < len && src[j] === "@") {
          // Lengths of opening "_" delimiters seen so far in this run,
          // so a "_" run after the domain can be recognised as the
          // closing delimiter (see parseMailDomain).
          let openUnderscoreLens = null;
          for (let k = out.length - 1; k >= 0; k--) {
            const it = out[k];
            if (it.t === "delim" && it.ch === "_" && it.canOpen) {
              if (!openUnderscoreLens) openUnderscoreLens = new Set();
              openUnderscoreLens.add(it.len);
            }
          }
          const em = matchMailLink(src, pos, openUnderscoreLens);
          if (em && !autolinkBarred(pos, em.end)) {
            flushText();
            out.push(em.node);
            pos = em.end;
            continue;
          }
        }
      }
    }
    // Scheme:email autolink: only tried at the start of a lowercase word.
    // Gate on ":" after the word first: the regex in matchSchemeMail
    // must not run for every word (it returns null without ":" anyway).
    if (extOk && c >= "a" && c <= "z" && (pos === 0 || !isSchemeLetter(src[pos - 1]))) {
      let j = pos;
      while (j < len && isSchemeLetter(src[j])) j++;
      if (j < len && src[j] === ":") {
        const se = matchSchemeMail(src, pos);
        if (se && !autolinkBarred(pos, se.end)) {
          flushText();
          out.push(se.node);
          pos = se.end;
          continue;
        }
      }
    }

    // --- newlines: hard break (two trailing spaces) or soft break -----
    if (c === "\n") {
      let trailing = 0;
      let k = buf.length - 1;
      while (k >= 0 && buf.charCodeAt(k) === 32) {
        trailing++;
        k--;
      }
      if (trailing >= 2) {
        buf = buf.slice(0, buf.length - trailing);
        flushText();
        out.push({ t: "br" });
        pos++;
        // A hard break strips the leading whitespace of the next line.
        while (pos < len && (src[pos] === " " || src[pos] === "\t")) pos++;
      } else {
        pushText("\n");
        pos++;
      }
      continue;
    }

    // --- ordinary character ---------------------------------------------
    pushText(c);
    pos++;
  }
  flushText();
  // Any "[" left over (active or deactivated) is literal text.
  closeLeftoverBrackets(out);
  return out;
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
function scanEntity(src, at) {
  const total = src.length;
  let p = at + 1;
  if (src[p] === "#") {
    // Numeric reference: &#...; or &#x...;.
    p++;
    let hex = false;
    if (src[p] === "x" || src[p] === "X") {
      hex = true;
      p++;
    }
    const firstDigit = p;
    while (p < total) {
      const code = src.charCodeAt(p);
      const digitOk = hex
        ? (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)
        : code >= 48 && code <= 57;
      if (!digitOk) break;
      p++;
    }
    if (p === firstDigit || p >= total || src[p] !== ";") return null;
    const decoded = decodeNumericEntity((hex ? "x" : "") + src.slice(firstDigit, p));
    if (decoded === null) return null;
    return { kind: "numeric", decoded, end: p + 1 };
  }
  // Named reference: & + alphanumerics + ";".
  const nameStart = p;
  while (p < total) {
    const code = src.charCodeAt(p);
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      p++;
    } else break;
  }
  if (p === nameStart || p >= total || src[p] !== ";") return null;
  return { kind: "named", text: src.slice(at, p + 1), end: p + 1 };
}

// --- <...> autolinks ------------------------------------------------------
function isMailLocalChar(c) {
  if (c === undefined || c.length !== 1) return false;
  const code = c.charCodeAt(0);
  if (code < 128) {
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      return true;
    }
    return ".!#$%&'*+/=?^_`{|}~-".includes(c);
  }
  return false;
}

function isSchemeLetter(c) {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return true;
  if (code >= 65 && code <= 90) return true;
  if (code >= 97 && code <= 122) return true;
  return c === "+" || c === "." || c === "-";
}

// Bracket autolink email: local@domain (no dot required in the domain).
function checkBracketMail(text) {
  const at = text.indexOf("@");
  if (at <= 0) return false;
  for (let k = 0; k < at; k++) {
    if (!isMailLocalChar(text[k])) return false;
  }
  const domain = text.slice(at + 1);
  if (!domain) return false;
  for (const label of domain.split(".")) {
    const last = label.length - 1;
    if (last < 0) return false;
    if (!isAlnumChar(label[0]) || !isAlnumChar(label[last])) return false;
    for (let k = 1; k < last; k++) {
      if (!isAlnumChar(label[k]) && label[k] !== "-") return false;
    }
  }
  return true;
}

function matchAngleLink(src, at) {
  const total = src.length;
  let gt = at + 1;
  while (gt < total) {
    const ch = src[gt];
    const code = src.charCodeAt(gt);
    if (ch === ">") break;
    if (ch === "<" || code <= 32 || code === 127) return null;
    gt++;
  }
  if (gt >= total) return null;
  const content = src.slice(at + 1, gt);
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
  if (!checkBracketMail(content)) return null;
  return {
    node: {
      t: "link", href: "mailto:" + content, title: null, auto: true,
      children: [{ t: "text", s: content }],
    },
    end: gt + 1,
  };
}

// --- raw inline HTML -------------------------------------------------------
const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*/;

function matchRawTag(src, at) {
  const total = src.length;
  // Comment.
  if (src.startsWith("<!--", at)) {
    if (src.startsWith("<!-->", at)) return { text: "<!-->", end: at + 5 };
    if (src.startsWith("<!--->", at)) return { text: "<!--->", end: at + 6 };
    const close = src.indexOf("-->", at + 4);
    if (close < 0) return null;
    // The comment ends at the first "-->"; "--" may appear inside it.
    return { text: src.slice(at, close + 3), end: close + 3 };
  }
  // Processing instruction.
  if (src.startsWith("<?", at)) {
    const close = src.indexOf("?>", at + 2);
    if (close < 0) return null;
    return { text: src.slice(at, close + 2), end: close + 2 };
  }
  // Declaration <!A ...>.
  if (src.startsWith("<!", at) && at + 2 < total && /[a-zA-Z]/.test(src[at + 2])) {
    const close = src.indexOf(">", at + 2);
    if (close < 0) return null;
    return { text: src.slice(at, close + 1), end: close + 1 };
  }
  // CDATA.
  if (src.startsWith("<![CDATA[", at)) {
    const close = src.indexOf("]]>", at + 9);
    if (close < 0) return null;
    return { text: src.slice(at, close + 3), end: close + 3 };
  }
  // Closing tag.
  if (src.startsWith("</", at)) {
    const m = TAG_NAME_RE.exec(src.slice(at + 2));
    if (!m) return null;
    let p = at + 2 + m[0].length;
    while (p < total && (src[p] === " " || src[p] === "\t" || src[p] === "\n")) p++;
    if (p >= total || src[p] !== ">") return null;
    return { text: src.slice(at, p + 1), end: p + 1 };
  }
  // Open tag: name, then attributes until ">" or "/>".
  const m = TAG_NAME_RE.exec(src.slice(at + 1));
  if (!m) return null;
  let p = at + 1 + m[0].length;
  for (;;) {
    // Whitespace before an attribute, "/>", or ">".
    let q = p;
    while (q < total && (src[q] === " " || src[q] === "\t" || src[q] === "\n" || src[q] === "\r" || src[q] === "\f")) q++;
    if (q < total && src[q] === ">") return { text: src.slice(at, q + 1), end: q + 1 };
    if (q < total && src[q] === "/" && q + 1 < total && src[q + 1] === ">") {
      return { text: src.slice(at, q + 2), end: q + 2 };
    }
    if (q === p) return null; // Expected whitespace or ">".
    p = q;
    // Attribute name.
    if (p >= total || !/[a-zA-Z_:]/.test(src[p])) return null;
    p++;
    while (p < total && /[a-zA-Z0-9_.:-]/.test(src[p])) p++;
    // Optional = value.
    let v = p;
    while (v < total && (src[v] === " " || src[v] === "\t" || src[v] === "\n")) v++;
    if (v < total && src[v] === "=") {
      v++;
      while (v < total && (src[v] === " " || src[v] === "\t" || src[v] === "\n")) v++;
      if (v >= total) return null;
      if (src[v] === '"' || src[v] === "'") {
        const quote = src[v];
        v++;
        while (v < total && src[v] !== quote) v++;
        if (v >= total) return null;
        v++;
      } else {
        while (v < total) {
          const ch = src[v];
          if (
            ch === " " || ch === "\t" || ch === "\n" || ch === '"' ||
            ch === "'" || ch === "=" || ch === "<" || ch === ">" || ch === "`"
          ) {
            break;
          }
          v++;
        }
        if (v === p) return null;
      }
      p = v;
    }
    // Loop for the next attribute.
    if (p >= total) return null;
  }
}

// --- extended autolinks (GFM) ----------------------------------------------
// Trim a matched extended URL: drop a trailing entity-like &...;, strip
// trailing punctuation, then balance parentheses. Repeats until stable.
const ENTITY_TAIL_RE = /^&(?:[A-Za-z0-9]+|#\d+|#[xX][0-9a-fA-F]+);$/;
function trimUrl(t) {
  for (;;) {
    const noEntity = dropEntityTail(t);
    if (noEntity !== t) {
      t = noEntity;
      continue;
    }
    const noPunct = dropTrailingPunct(t);
    if (noPunct !== t) {
      t = noPunct;
      continue;
    }
    const balanced = balanceParens(t);
    if (balanced !== t) {
      t = balanced;
      continue;
    }
    return t;
  }
}

function dropEntityTail(t) {
  if (t.length === 0 || t.charCodeAt(t.length - 1) !== 59) return t;
  const amp = t.lastIndexOf("&");
  if (amp >= 0 && ENTITY_TAIL_RE.test(t.slice(amp))) return t.slice(0, amp);
  return t;
}

function dropTrailingPunct(t) {
  if (t.length === 0) return t;
  const last = t.charCodeAt(t.length - 1);
  if (
    last === 63 || last === 33 || last === 46 || last === 44 ||
    last === 58 || last === 59 || last === 42 || last === 95 || last === 126
  ) {
    return t.slice(0, -1);
  }
  return t;
}

// Paren balancing, stack-based (not count-based):
// - a "(" with no matching ")" later ends the URL there;
// - a trailing ")" is dropped only if it is unmatched (no "("
//   before it that it closes); a matched trailing ")" is kept,
//   e.g. "...page=4)](./docs/create.md)" keeps its final ")",
//   while a lone trailing ")" in "foo)" is dropped. A ")"
//   with no matching "(" is ordinary URL text and is kept
//   when it is not trailing (e.g. "foo)bar" stays whole).
function balanceParens(t) {
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
  if (stack.length > 0) return t.slice(0, stack[0]);
  let end = t.length;
  while (
    end > 0 &&
    t.charCodeAt(end - 1) === 41 &&
    !matchedClose.has(end - 1)
  ) {
    end--;
  }
  return t.slice(0, end);
}

function isUrlByte(c) {
  const code = c.charCodeAt(0);
  if (code <= 32 || code === 127) return false;
  return c !== "<";
}

// Does src start with http://, https:// or ftp:// (any case) at at?
function hasKnownScheme(src, at) {
  const head = src.slice(at, at + 8).toLowerCase();
  return (
    head.startsWith("http://") || head.startsWith("https://") ||
    head.startsWith("ftp://")
  );
}

// Match a www. or scheme:// extended autolink starting at at.
// prefixLen is 4 for "www." (the domain starts after it) and 0 for a
// scheme:// URL (the whole match, scheme included, starts at at).
function matchExtendedLink(src, at, prefixLen) {
  const total = src.length;
  let domainStart = at + prefixLen;
  if (prefixLen === 0) {
    const m = /^(?:https?|ftp):\/\//i.exec(src.slice(at));
    if (!m) return null;
    domainStart = at + m[0].length;
  }
  if (domainStart >= total) return null;
  const first = src[domainStart];
  const fc = first.charCodeAt(0);
  const firstOk =
    (fc >= 48 && fc <= 57) || (fc >= 65 && fc <= 90) ||
    (fc >= 97 && fc <= 122) || first === "-" || first === "_";
  if (!firstOk) return null;
  let p = domainStart + 1;
  while (p < total) {
    const c = src[p];
    const code = src.charCodeAt(p);
    if (
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) || c === "." || c === "-" || c === "_"
    ) {
      p++;
    } else break;
  }
  // The rest of the URL: anything but whitespace, "<", or control chars.
  while (p < total && isUrlByte(src[p])) p++;
  const text = trimUrl(src.slice(at, p));
  if (text.length === 0) return null;
  const href = prefixLen === 4 ? "http://" + text : text;
  return {
    node: {
      t: "link", href, title: null, auto: true, ext: true,
      children: [{ t: "text", s: text }],
    },
    end: at + text.length,
  };
}

// Scan one domain label ([A-Za-z0-9_-]+) starting at from; returns the
// index just past it, or from when there is no label character there.
function scanDomainLabel(src, from) {
  const total = src.length;
  let p = from;
  while (p < total) {
    const c = src[p];
    const code = src.charCodeAt(p);
    if (
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) || c === "-" || c === "_"
    ) {
      p++;
    } else break;
  }
  return p;
}

function isDomainChar(c) {
  const code = c.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || c === "-" || c === "_"
  );
}

// Parse an email domain starting at at (right after "@").
// Returns the end offset of the domain, or -1 if invalid. The domain needs
// at least one dot; the first label is any run of [A-Za-z0-9_-], later
// labels must end in an alphanumeric; if the character after the domain is
// [A-Za-z0-9_-], the last dot-group is dropped and the check repeats.
function parseMailDomain(src, at, openUnderscoreLens) {
  const total = src.length;
  const ends = [];
  let p = scanDomainLabel(src, at);
  if (p === at) return -1;
  ends.push(p);
  // Dot-groups.
  while (p < total && src[p] === ".") {
    const labelStart = p + 1;
    const labelEndRaw = scanDomainLabel(src, labelStart);
    // Trim trailing - / _ (label must end alphanumeric).
    let labelEnd = labelEndRaw;
    while (labelEnd > labelStart) {
      const c = src[labelEnd - 1];
      if (c === "-" || c === "_") labelEnd--;
      else break;
    }
    if (labelEnd === labelStart) break; // Empty label: no more groups.
    ends.push(labelEnd);
    p = labelEndRaw;
  }
  if (ends.length < 2) return -1;
  // Lookahead: the character after the domain must not be [A-Za-z0-9_-].
  while (ends.length >= 2) {
    const end = ends[ends.length - 1];
    if (end < total && isDomainChar(src[end])) {
      // A "_" run after the domain does not force a backtrack when
      // its length exactly matches an opening "_" delimiter seen
      // earlier in this run (e.g. "__...because@mark.example.com__"
      // or "_..._"): the run is the closing delimiter, a boundary,
      // not part of the address. Otherwise it is address text and
      // the group is dropped, as in "foo@bar.baz.com_".
      if (src[end] === "_" && openUnderscoreLens) {
        let run = 0;
        while (end + run < total && src[end + run] === "_") run++;
        if (openUnderscoreLens.has(run)) return end;
      }
      ends.pop();
      continue;
    }
    return end;
  }
  return -1;
}

// Match a plain email autolink starting at at (start of the local part).
function matchMailLink(src, at, openUnderscoreLens) {
  const total = src.length;
  let p = at;
  while (p < total && isMailLocalChar(src[p])) p++;
  if (p === at || p >= total || src[p] !== "@") return null;
  const domainEnd = parseMailDomain(src, p + 1, openUnderscoreLens);
  if (domainEnd < 0) return null;
  const text = src.slice(at, domainEnd);
  return {
    node: {
      t: "link", href: "mailto:" + text, title: null, auto: true, ext: true,
      children: [{ t: "text", s: text }],
    },
    end: domainEnd,
  };
}

// Match a scheme:email autolink starting at at (start of a lowercase word).
// After the email, one path segment of [A-Za-z0-9.@]+ may follow.
function matchSchemeMail(src, at) {
  const total = src.length;
  let p = at;
  while (p < total && isSchemeLetter(src[p])) p++;
  const scheme = src.slice(at, p);
  if (scheme.length < 2) return null;
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;
  if (p >= total || src[p] !== ":") return null;
  let q = p + 1;
  const localStart = q;
  while (q < total && isMailLocalChar(src[q])) q++;
  if (q === localStart || q >= total || src[q] !== "@") return null;
  const domainEnd = parseMailDomain(src, q + 1);
  if (domainEnd < 0) return null;
  let end = domainEnd;
  if (end < total && src[end] === "/") {
    let m = end + 1;
    while (m < total) {
      const c = src[m];
      const code = src.charCodeAt(m);
      if (
        (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) || c === "." || c === "@"
      ) {
        m++;
      } else break;
    }
    if (m > end + 1) end = m;
  }
  let text = src.slice(at, end);
  // Strip trailing punctuation from the path segment.
  for (;;) {
    if (text.length === 0) break;
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
    end: at + text.length,
  };
}

// --- link suffix parsing ---------------------------------------------------
// Parses what may follow a "]" in the source string src at offset pos.
// Returns null (not a link), or:
//   {kind:'inline', href, title, end}
//   {kind:'ref', label, end}        full reference [text][label]
//   {kind:'collapsed', end}         [text][]
//   {kind:'shortcut', end}          [text] with no suffix
function skipSpaces(src, at) {
  const total = src.length;
  let p = at;
  while (p < total) {
    const c = src[p];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") p++;
    else break;
  }
  return p;
}

function parseLinkTail(src, pos) {
  const total = src.length;
  // The "(" or "[" must immediately follow the "]": no whitespace
  // (a space or newline means this is not an inline link or a full
  // reference link, and the caller falls back to the shortcut form).
  let i = pos;
  if (i < total && src[i] === "(") {
    i++;
    i = skipSpaces(src, i);
    const destRes = readDestination(src, i);
    if (destRes === null) return null;
    i = destRes.next;
    i = skipSpaces(src, i);
    let title = null;
    if (i < total && (src[i] === '"' || src[i] === "'" || src[i] === "(")) {
      const titleRes = readTitle(src, i);
      if (titleRes === null) return null;
      title = titleRes.title;
      i = skipSpaces(src, titleRes.next);
    }
    if (i >= total || src[i] !== ")") return null;
    return { kind: "inline", href: destRes.dest, title, end: i + 1 };
  }
  if (i < total && src[i] === "[") {
    // A link label must not contain an unescaped "["; escaped brackets
    // are kept raw (labels are matched on their raw text).
    let j = i + 1;
    let label = "";
    while (j < total) {
      const c = src[j];
      if (c === "\\" && j + 1 < total) {
        const d = src[j + 1];
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
    if (j >= total || src[j] !== "]") return null;
    if (label === "") return { kind: "collapsed", end: j + 1 };
    return { kind: "ref", label, end: j + 1 };
  }
  return { kind: "shortcut", end: pos };
}

// Read a link destination starting at at (just past the "(" and its
// whitespace). Returns {dest, next} (next is just past the destination)
// or null when the destination is malformed.
function readDestination(src, at) {
  const total = src.length;
  if (at < total && src[at] === "<") {
    let dest = "";
    let j = at + 1;
    let ok = false;
    while (j < total) {
      const c = src[j];
      if (c === "\n" || c === "<") return null;
      if (c === ">") {
        ok = true;
        break;
      }
      if (c === "\\" && j + 1 < total) {
        const d = src[j + 1];
        if (d.charCodeAt(0) < 128 && ASCII_PUNCT_BITS[d.charCodeAt(0)] === 1) {
          dest += d;
          j += 2;
          continue;
        }
      }
      dest += c;
      j++;
    }
    if (!ok) return null;
    return { dest, next: j + 1 };
  }
  let dest = "";
  let depth = 0;
  let j = at;
  while (j < total) {
    const c = src[j];
    const code = src.charCodeAt(j);
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || code < 32) break;
    if (c === "\\" && j + 1 < total) {
      const d = src[j + 1];
      if (d.charCodeAt(0) < 128 && ASCII_PUNCT_BITS[d.charCodeAt(0)] === 1) {
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
  // An empty destination is allowed: [link]().
  return { dest, next: j };
}

// Read a link title starting at at (on its opening quote). Returns
// {title, next} (next is just past the closing quote) or null when the
// title never closes.
function readTitle(src, at) {
  const total = src.length;
  const q = src[at];
  const closeQ = q === "(" ? ")" : q;
  let title = null;
  let j = at + 1;
  let ok = false;
  while (j < total) {
    const c = src[j];
    if (c === closeQ) {
      ok = true;
      break;
    }
    if (c === "\\" && j + 1 < total) {
      const d = src[j + 1];
      if (d.charCodeAt(0) < 128 && ASCII_PUNCT_BITS[d.charCodeAt(0)] === 1) {
        title = (title === null ? "" : title) + d;
        j += 2;
        continue;
      }
    }
    title = (title === null ? "" : title) + c;
    j++;
  }
  if (!ok) return null;
  return { title, next: j + 1 };
}

// Does any node (or a descendant) contain an explicit link? A link's
// text may hold images, emphasis and autolinks, but not another
// explicitly-written link.
function hasNestedLink(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
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
  const last = nodes.length - 1;
  for (let k = 0; k < last; k++) {
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
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    const kind = node.t;
    if (kind === "text" || kind === "code" || kind === "html") {
      out += node.s;
    } else if (kind === "br") {
      out += "\n";
    } else if (kind === "delim") {
      out += node.ch.repeat(node.len);
    } else if (kind === "open") {
      out += (node.bang ? "!" : "") + "[";
    } else if (kind === "close") {
      out += "]";
    } else if (node.children) {
      out += collectText(node.children);
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
function maskedBacktickRanges(src, lo, hi) {
  // Fast path: no backtick in the range, no spans (native scan).
  const firstTick = src.indexOf("`", lo);
  if (firstTick < 0 || firstTick >= hi) return [];
  // Collect maximal backtick runs in the range.
  const runs = [];
  for (let p = lo; p < hi;) {
    if (src[p] !== "`") {
      p++;
      continue;
    }
    let q = p;
    while (q < hi && src[q] === "`") q++;
    runs.push({ start: p, end: q, len: q - p });
    p = q;
  }
  const spans = [];
  for (let k = 0; k < runs.length;) {
    const run = runs[k];
    // An escaped run (odd number of backslashes before it) is masked
    // and cannot open a pair — unless an earlier run already claimed
    // it as its closer (handled by the partner search below, which
    // does not check escaping).
    let b = run.start - 1;
    let slashes = 0;
    while (b >= lo && src[b] === "\\") {
      slashes++;
      b--;
    }
    if (slashes % 2 === 1) {
      k++;
      continue;
    }
    let partner = k + 1;
    while (partner < runs.length && runs[partner].len !== run.len) partner++;
    if (partner >= runs.length) {
      k++;
      continue;
    }
    spans.push([run.start, runs[partner].end]);
    k = partner + 1;
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
// Delimiter-stack algorithm (CommonMark). Closers are processed left to
// right; each looks back through the stack of openers for the first match
// with the same character that is not an "odd match" (the rule of 3s: the
// sum of the two lengths is divisible by 3 while neither length is). A
// match of two or more delimiters on both sides is strong, otherwise em.
// A "~" pair is a <del> and needs one or two tildes, the same number on
// each side (a run of three or more never forms a <del>).
// Link and image nodes are opaque here; their children are processed first.
// src is the source of this inline string and lo/hi its range within it:
// a link's text is masked against its label alone (marked tokenizes a
// link's text separately), so the recursion passes each node's ls/le.
export function resolveEmphasis(seq, src, lo, hi) {
  for (const item of seq) {
    if (item.t === "link" || item.t === "image") {
      // Autolinks carry no ls/le (their children hold no delimiters);
      // fall back to this level's range for them.
      resolveEmphasis(
        item.children,
        src,
        item.ls === undefined ? lo : item.ls,
        item.le === undefined ? hi : item.le,
      );
    }
  }
  // Pre-pass (probed 16 Nov 2026, doc-09): a "*" / "_" delimiter
  // whose source position lies inside a hidden span (see
  // maskedBacktickRanges) cannot close emphasis. Only canClose is
  // cleared — the delimiter may still open, and pair with a later
  // visible closer. Delimiters outside any span are untouched, and
  // "~" is never touched.
  const spans = maskedBacktickRanges(src, lo, hi);
  if (spans.length > 0) {
    for (const it of seq) {
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
  const openers = []; // Delim tokens that can open, in encounter order.
  const floor = { "*": -1, "_": -1, "~": -1 };
  // Strict rule-of-3s flag, per character: once a delimiter that can
  // both open and close has been used as a closer, the rule of 3s
  // applies strictly to later pairs of that character (even when
  // neither side can both open and close), until a match by a
  // close-only delimiter clears it again. This is what makes
  // "**a *b*c* d**" form a <strong> (the "*" after "c" may not take
  // one delimiter from the "**" opener) while "**a *b* c* d**" nests
  // <em>s instead. The flag is scoped: it only applies to an opener
  // that was already open when the both-closer matched (its seq is at
  // most strictCut); an opener created after that match starts a
  // fresh emphasis region and is not blocked by it. Without the scope,
  // a completed <em> earlier in a paragraph would wrongly block a
  // later independent nesting such as "*using *type guide in**".
  const strict3 = { "*": false, "_": false, "~": false };
  const strictCut = { "*": -1, "_": -1, "~": -1 };
  // Length of the both-closer that set the strict flag (see below).
  const strictLen = { "*": 0, "_": 0, "~": 0 };
  let pos = 0;
  while (pos < seq.length) {
    const item = seq[pos];
    if (item.t !== "delim") {
      pos++;
      continue;
    }
    const closer = item;
    if (closer.canClose) {
      let matchIdx = -1;
      for (let k = openers.length - 1; k > floor[closer.ch]; k--) {
        const opener = openers[k];
        if (opener.ch !== closer.ch) continue;
        if (closer.ch === "~" && (opener.len !== closer.len || opener.len > 2)) continue;
        if (oddPair(opener, closer, strict3, strictCut, strictLen)) continue;
        matchIdx = k;
        break;
      }
      if (matchIdx >= 0) {
        const opener = openers[matchIdx];
        const take =
          closer.ch === "~" ? opener.len : opener.len >= 2 && closer.len >= 2 ? 2 : 1;
        const openIdx = seq.indexOf(opener);
        const inner = seq.slice(openIdx + 1, pos);
        // Delimiters wrapped inside the new node can no longer open.
        for (const child of inner) {
          if (child.t === "delim") child.dead = true;
        }
        const tag = closer.ch === "~" ? "del" : take === 2 ? "strong" : "em";
        const node = { t: tag, children: inner };
        const splice = [];
        let spareOpen = null;
        let spareClose = null;
        if (opener.len > take) {
          spareOpen = {
            t: "delim", ch: closer.ch, len: opener.len - take,
            canOpen: opener.canOpen, canClose: opener.canClose,
            seq: opener.seq,
          };
          splice.push(spareOpen);
        }
        splice.push(node);
        if (closer.len > take) {
          spareClose = {
            t: "delim", ch: closer.ch, len: closer.len - take,
            canOpen: closer.canOpen, canClose: closer.canClose,
            seq: closer.seq,
          };
          if (leftoverGoesInside(seq, pos, closer, take)) {
            inner.push(spareClose);
            spareClose = null;
          } else {
            splice.push(spareClose);
          }
        }
        seq.splice(openIdx, pos - openIdx + 1, ...splice);
        // Rebuild the stack: drop the opener and anything now inside
        // the node; keep the spare opener at the opener's place.
        const survivors = [];
        for (let k = 0; k < openers.length; k++) {
          if (k === matchIdx) {
            if (spareOpen) survivors.push(spareOpen);
            continue;
          }
          if (!openers[k].dead) survivors.push(openers[k]);
        }
        openers.length = 0;
        for (const s2 of survivors) openers.push(s2);
        floor[closer.ch] = -1;
        // A closer that can both open and close switches the rule of
        // 3s to strict for this character, scoped to the openers that
        // were already on the stack when it matched — but only when
        // the opener it matched was open-only. When the opener was
        // itself a both-delimiter (as in "*foo**bar**baz*", where the
        // inner ** can both open and close), the flag is left alone
        // and the outer pair still matches. A close-only closer
        // clears the flag again.
        if (closer.canOpen && closer.canClose && !opener.canClose) {
          strict3[closer.ch] = true;
          strictLen[closer.ch] = closer.len;
          let cutoff = -1;
          for (let k = openers.length - 1; k >= 0; k--) {
            if (openers[k].ch === closer.ch) {
              cutoff = openers[k].seq;
              break;
            }
          }
          strictCut[closer.ch] = cutoff;
        } else if (!closer.canOpen || !closer.canClose) {
          strict3[closer.ch] = false;
          strictLen[closer.ch] = 0;
          strictCut[closer.ch] = -1;
        }
        pos = openIdx + splice.length - (spareClose ? 1 : 0);
        continue;
      }
      // Note: no "floor" advance here. The odd rule is evaluated per
      // (opener, closer) pair and depends on both lengths, so an
      // opener skipped by one closer (e.g. a length-1 closer failing
      // against a length-2 opener whose sum is a multiple of 3) may
      // still match a later closer of a different length (e.g. the
      // final "**" matching the outer "**" in "**removes example
      // *input **parse**parse* release**"). Advancing a per-character
      // floor on an odd skip would wrongly block that later match.
    }
    if (closer.canOpen) openers.push(closer);
    pos++;
  }
  // Whatever is left over is literal text, anywhere in the tree.
  delimsToText(seq);
}

// Is (opener, closer) an "odd match" under the rule of 3s?
// The rule applies when one of the two delimiters can both open and
// close emphasis, or while the strict flag for this character is set
// (see resolveEmphasis) and the opener predates the both-closer match
// that set it; otherwise a pair whose lengths sum to a multiple of 3
// still matches. While strict, the pair is blocked when the opener
// sums with the length of the both-closer itself to a multiple of 3
// and either the pair also sums to a multiple of 3 or the closer is a
// single delimiter: that keeps "*a **b**c*" literal (1 + 2 is a
// multiple of 3, closer length 1) while "*a *b*c*" still nests (its
// both-closer has length 1) and "*changes *else*returns**" still
// forms its outer <em> (the closer has length 2 and 1 + 2 is a
// multiple of 3 only via the pair sum, not via the both-closer
// length 1).
function oddPair(opener, closer, strict3, strictCut, strictLen) {
  const eitherBoth =
    (opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose);
  const strict =
    strict3[closer.ch] && opener.seq <= strictCut[closer.ch];
  const sumMod3 = (opener.len + closer.len) % 3 === 0;
  const strictSumMod3 =
    (opener.len + strictLen[closer.ch]) % 3 === 0;
  return (
    (eitherBoth && sumMod3 && opener.len % 3 !== 0) ||
    (strict &&
      opener.len % 3 !== 0 &&
      ((sumMod3 && (closer.len === 1 || strictSumMod3)) ||
        (closer.len === 1 && strictSumMod3)))
  );
}

// Does a leftover closer delimiter go INSIDE the new emphasis node?
// Only for a "*" <strong> (take 2) when the text immediately before the
// closer run directly follows an inner emphasis/link/code node with no
// space (e.g. "**a *b*c***" -> "<strong>a <em>b</em>c*</strong>"); it
// stays outside for "_" ("__a *b*c___" -> leftover outside), for <em>
// ("*a `code`c**" -> leftover outside), and when the preceding text
// starts with a space or is plain text ("**a *b* c***", "**foo***" ->
// leftover outside). Probed 16 Nov 2026.
function leftoverGoesInside(seq, pos, closer, take) {
  if (closer.ch !== "*" || take !== 2 || closer.canOpen) return false;
  const before = seq[pos - 1];
  const before2 = pos >= 2 ? seq[pos - 2] : null;
  return (
    before &&
    before.t === "text" &&
    before.s !== "" &&
    before.s.charCodeAt(0) !== 32 &&
    before.s.charCodeAt(0) !== 9 &&
    before2 &&
    (before2.t === "em" || before2.t === "strong")
  );
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
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    const kind = node.t;
    if (kind === "text") {
      out.push(escapeAttr(node.s));
    } else if (kind === "code") {
      out.push("<code>", escapeRaw(node.s), "</code>");
    } else if (kind === "html") {
      out.push(node.s);
    } else if (kind === "br") {
      out.push("<br>");
    } else if (kind === "em" || kind === "strong" || kind === "del") {
      out.push("<" + kind + ">");
      renderInlineNodes(node.children, out);
      out.push("</" + kind + ">");
    } else if (kind === "link") {
      out.push('<a href="', sanitizeHref(node.href), '"');
      if (node.title !== null && node.title !== undefined) {
        out.push(' title="', escapeAttr(node.title), '"');
      }
      out.push(">");
      renderInlineNodes(node.children, out);
      out.push("</a>");
    } else if (kind === "image") {
      out.push('<img src="', sanitizeHref(node.src), '" alt="');
      out.push(escapeAttr(collectText(node.children)));
      out.push('"');
      if (node.title !== null && node.title !== undefined) {
        out.push(' title="', escapeAttr(node.title), '"');
      }
      out.push(">");
    }
  }
}

// Render inline nodes to a single HTML string.
export function inlineToHtml(s, refs) {
  const out = [];
  renderInlineNodes(parseInlineText(s, refs), out);
  return out.join("");
}
