// parse.js — a from-scratch CommonMark 0.31.2 + GFM 0.29 markdown parser.
//
// Written for the make.fun markdown-render-speed-02 competition. It renders
// exactly the HTML that marked 18.1.3 produces with its default options
// (gfm on, breaks off, pedantic off, async off), dependency-free.
//
// Design: a block parser (line-based, container aware, tab aware) builds a
// small AST; a separate inline parser turns each block's raw text into HTML
// with a delimiter-stack emphasis algorithm and CommonMark link resolution.
// No input is ever special-cased: everything is computed from the markdown.

// ---------------------------------------------------------------------------
// Character classes and small helpers
// ---------------------------------------------------------------------------
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
// bracket autolinks are unaffected. (Probed 16 Nov 2026.) Reset at the
// start of each parse() call.
let inLink = false;
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Escape < > " ' and & (but leave a well-formed entity reference alone:
// &name; &#123; &#x1a; are passed through unchanged).
const RE_ATTR_ESC = /[<>"']|&(?!(?:[A-Za-z0-9]+|#\d+|#[xX][0-9a-fA-F]+);)/g;
function escAttr(s) {
  return s.replace(RE_ATTR_ESC, (c) => ESC_MAP[c]);
}

// Escape everything, including &. Used for code spans / code blocks.
const RE_ALL_ESC = /[&<>"']/g;
function escAll(s) {
  return s.replace(RE_ALL_ESC, (c) => ESC_MAP[c]);
}

// ASCII punctuation lookup (code unit -> boolean), built once.
const ASCII_PUNCT = new Uint8Array(128);
for (const c of "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~") ASCII_PUNCT[c.charCodeAt(0)] = 1;

// CommonMark defines a Unicode punctuation character as an ASCII
// punctuation character or a character in the Unicode P (punctuation)
// or S (symbol) general category.
const RE_UNICODE_PUNCT = /[\p{P}\p{S}]/u;
function isPunct(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return ASCII_PUNCT[code] === 1;
  return RE_UNICODE_PUNCT.test(ch);
}

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

// Unicode whitespace (CommonMark's definition): space, tab, newline, form
// feed, carriage return, plus the Unicode space separators.
function isUnicodeSpace(ch) {
  if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") return true;
  const code = ch.charCodeAt(0);
  return (
    code === 0x00a0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000
  );
}

function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function isAlphaNum(ch) {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

// Encode a URL the way marked does: encodeURI, then escape for an attribute.
function cleanHref(href) {
  let cleaned;
  try {
    cleaned = encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
  return escAttr(cleaned);
}

// Normalize a link label: trim, collapse every run of whitespace to one
// space, case-fold.
function normalizeLabel(label) {
  // Unicode case folding (not just lowercasing): sharp s folds to "ss"
  // and the Greek final sigma folds to sigma, matching CommonMark.
  return label
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ẞ/g, "ss")
    .replace(/ς/g, "σ");
}

// Decode one numeric character reference. `body` is the text after "&#"
// (e.g. "65" or "x41" or "X1F600"). Returns the decoded string, or null if
// this is not a valid reference (wrong digit count, empty, or a stray ";").
function decodeNumericRef(body) {
  let value = 0;
  if (body.charCodeAt(0) === 120 || body.charCodeAt(0) === 88) {
    // hex: 1-6 digits
    const hex = body.slice(1);
    if (hex.length < 1 || hex.length > 6) return null;
    for (let i = 0; i < hex.length; i++) {
      const c = hex.charCodeAt(i);
      let d;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (c >= 65 && c <= 70) d = c - 55;
      else if (c >= 97 && c <= 102) d = c - 87;
      else return null;
      value = value * 16 + d;
    }
  } else {
    // decimal: 1-7 digits
    if (body.length < 1 || body.length > 7) return null;
    for (let i = 0; i < body.length; i++) {
      const c = body.charCodeAt(i);
      if (c < 48 || c > 57) return null;
      value = value * 10 + (c - 48);
    }
  }
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return "�";
  }
  return String.fromCodePoint(value);
}

// ---------------------------------------------------------------------------
// Inline parsing
//
// A block's raw text is scanned into items (text runs, code spans, raw HTML,
// delimiter runs, bracket openers/closers, autolinks). Links are resolved
// next (a "]" looks back for its "[" and parses the suffix from the source),
// then emphasis is resolved with a delimiter stack. The result is a list of
// nodes that render to HTML. Link text is re-parsed recursively, so emphasis
// and links inside link text work, while emphasis can never span a link
// boundary (the link node is opaque to the outer emphasis pass).
// ---------------------------------------------------------------------------

// Node types:
//   {t:'text', s}             plain text (escapes processed, entities decoded)
//   {t:'code', s}             code span content (raw)
//   {t:'html', s}             raw inline HTML (as-is)
//   {t:'br'}                  hard break
//   {t:'link', href, title, children}
//   {t:'image', src, title, alt}
//   {t:'em'|'strong'|'del', children}

// Scan a raw inline string into items. Items used only while resolving:
//   {t:'delim', ch, len, canOpen, canClose}
//   {t:'open', bang, pos, end, active}   pos/end are source offsets of "["
//   {t:'close', pos, end}                pos/end are source offsets of "]"
// Autolinks are emitted directly as link nodes during the scan.
function scanInline(s, refs) {
  const n = s.length;
  const items = [];
  const openers = []; // indices into items of active "[" openers
  // source index of the most recent "]" processed (link close attempt);
  // used to tell link text apart from a link suffix (see extOk below)
  let lastClosePos = -1;
  // source index of a "]" that a code-span search stopped at because
  // the span was broken there (see the code-span search below); a
  // later backtick opener before that "]" may not search past it
  let codeSpanBoundary = -1;
  let buf = "";
  let i = 0;
  // sequence number for emphasis delimiters, in encounter order; used
  // by processEmphasis to scope the strict rule-of-3s flag (see there)
  let delimSeq = 0;

  function flush() {
    if (buf !== "") {
      items.push({ t: "text", s: buf });
      buf = "";
    }
  }
  function addText(str) {
    buf += str;
  }
  // A literal "&" that must always be escaped (from \& or &#38;) gets its
  // own text item, so it can never join up with a following "name;" and
  // look like a named entity when the run is escaped.
  function addAmp() {
    flush();
    items.push({ t: "text", s: "&" });
  }
  // Is position i the start of an email local-part run? The raw
  // preceding character is not enough: "*" (and "_" / "~") is both an
  // email local character and an emphasis delimiter, so after "**"
  // the email does start even though s[i-1] is "*". Use the tokenized
  // state instead: if pending text ends in a local character we are
  // mid-run; a just-closed delimiter / code / tag is a boundary.
  function atEmailRunStart() {
    if (buf !== "") return !isEmailLocalChar(buf[buf.length - 1]);
    if (items.length === 0) return true;
    const last = items[items.length - 1];
    if (last.t === "text") {
      return (
        last.s.length === 0 ||
        !isEmailLocalChar(last.s[last.s.length - 1])
      );
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
          flush();
          items.push({ t: "br" });
          i += 2;
          // a hard break strips the leading whitespace of the next line
          while (i < n && (s[i] === " " || s[i] === "\t")) i++;
          continue;
        }
        const dc = d.charCodeAt(0);
        if (dc < 128 && ASCII_PUNCT[dc] === 1) {
          if (d === "&") addAmp();
          else addText(d);
          i += 2;
          continue;
        }
      }
      addText("\\");
      i++;
      continue;
    }

    // --- code spans ----------------------------------------------------
    if (c === "`") {
      let j = i;
      while (j < n && s[j] === "`") j++;
      const ticks = j - i;
      // find a matching run of exactly the same length
      let k = j;
      let found = -1;
      // a backtick run of a different length than the opener, seen
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
        codeSpanBoundary >= 0 && i < codeSpanBoundary ? codeSpanBoundary : n;
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
          openers.some((idx) => items[idx].active) &&
          parseLinkSuffix(s, k + 1)
        ) {
          codeSpanBoundary = k;
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
        flush();
        items.push({ t: "code", s: content });
        i = found + ticks;
        continue;
      }
      addText(s.slice(i, j));
      i = j;
      continue;
    }

    // --- < : autolinks and raw HTML ------------------------------------
    if (c === "<") {
      const auto = matchBracketAutolink(s, i);
      if (auto) {
        flush();
        items.push(auto.node);
        i = auto.end;
        continue;
      }
      const tag = matchHtmlTag(s, i);
      if (tag) {
        // an <a> open tag enters "inside a link", which suppresses
        // extended autolinks; a clean </a> leaves it. Only an <a>
        // whose tag name is followed by a literal space counts: a
        // bare <a>, a self-closing <a/>, and <a\n...> / <a\t...> do
        // not. (Probed 16 Nov 2026.)
        const t = tag.text;
        if (t[1] !== "/" && t[1] !== "!" && t[1] !== "?") {
          let k = 1;
          while (k < t.length && /[A-Za-z0-9-]/.test(t[k])) k++;
          if (t.slice(1, k).toLowerCase() === "a" && t[k] === " ") {
            inLink = true;
          }
        } else if (t.toLowerCase() === "</a>") {
          inLink = false;
        }
        flush();
        items.push({ t: "html", s: tag.text });
        i = tag.end;
        continue;
      }
      addText("<");
      i++;
      continue;
    }

    // --- entities ------------------------------------------------------
    if (c === "&") {
      const ent = matchEntity(s, i);
      if (ent) {
        if (ent.kind === "named") {
          addText(ent.text);
        } else if (ent.decoded === "&") {
          addAmp();
        } else {
          addText(ent.decoded);
        }
        i = ent.end;
        continue;
      }
      addAmp();
      i++;
      continue;
    }

    // --- images / links -------------------------------------------------
    // A "]" is resolved right here, while the suffix text ahead has not
    // been scanned yet, so no text run can ever straddle a link boundary.
    if (c === "!" && i + 1 < n && s[i + 1] === "[") {
      flush();
      openers.push(items.length);
      items.push({ t: "open", bang: true, pos: i + 1, end: i + 2, active: true });
      i += 2;
      continue;
    }
    if (c === "[") {
      flush();
      openers.push(items.length);
      items.push({ t: "open", bang: false, pos: i, end: i + 1, active: true });
      i++;
      continue;
    }
    if (c === "]") {
      flush();
      lastClosePos = i;
      if (i >= codeSpanBoundary) codeSpanBoundary = -1;
      let openerIdx = -1;
      for (let k = openers.length - 1; k >= 0; k--) {
        const oi = openers[k];
        if (items[oi].active) {
          openerIdx = oi;
          openers.splice(k, 1);
          break;
        }
      }
      if (openerIdx < 0) {
        addText("]");
        i++;
        continue;
      }
      const opener = items[openerIdx];
      const suffix = parseLinkSuffix(s, i + 1);
      let href = null;
      let title = null;
      let failed = false;
      let isShortcut = false;
      if (!suffix) {
        // the inline link failed to parse (or the label was malformed):
        // fall back to the shortcut form, leaving the failed suffix as
        // literal text. A full reference label that simply is not
        // defined does NOT fall back (that case returns a "ref" suffix).
        const label = normalizeLabel(s.slice(opener.end, i));
        const ref = refs.get(label);
        if (ref && (opener.bang || !containsLink(items.slice(openerIdx + 1)))) {
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
        const ref = refs.get(normalizeLabel(suffix.label));
        if (!ref) failed = true;
        else {
          href = ref.href;
          title = ref.title;
        }
      } else {
        // collapsed / shortcut: the label is the raw source text of
        // the link text (escapes kept), not the rendered plain text
        const label = normalizeLabel(s.slice(opener.end, i));
        const ref = refs.get(label);
        if (!ref) failed = true;
        else {
          href = ref.href;
          title = ref.title;
        }
      }
      if (failed) {
        opener.active = false;
        addText("]");
        i++;
        continue;
      }
      // a link cannot contain another link (an image's text may, its
      // link becomes part of the alt text)
      if (!opener.bang && containsLink(items.slice(openerIdx + 1))) {
        opener.active = false;
        addText("]");
        i++;
        continue;
      }
      // a code span containing a backtick, with content after it in
      // the link text, prevents the link from forming (probe79/80/81);
      // marked also renders every emphasis delimiter in that link
      // text literally (probe82), so deactivate them all.
      if (hasBacktickCodeSpanTail(items.slice(openerIdx + 1))) {
        for (let k = openerIdx + 1; k < items.length; k++) {
          if (items[k].t === "delim") {
            items[k].canOpen = false;
            items[k].canClose = false;
          }
        }
        opener.active = false;
        addText("]");
        i++;
        continue;
      }
      const children = items.splice(openerIdx + 1);
      items.splice(openerIdx, 1);
      // every opener still on the stack past this one was inside the
      // link text; drop them (they are deactivated openers now)
      for (let k = openers.length - 1; k >= 0; k--) {
        if (openers[k] >= openerIdx) openers.splice(k, 1);
      }
      let node;
      if (opener.bang) {
        node = { t: "image", src: href, title, children };
      } else {
        node = { t: "link", href, title, children };
      }
      items.push(node);
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
      const beforeWs = isUnicodeSpace(before);
      const afterWs = isUnicodeSpace(after);
      const beforePunct = isPunct(before);
      const afterPunct = isPunct(after);
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
      flush();
      items.push({ t: "delim", ch: c, len, canOpen, canClose, seq: delimSeq++ });
      i = j;
      continue;
    }

    // --- extended autolinks (GFM) ---------------------------------------
    // They do not form inside link text: an opener that was pushed
    // after the most recent "]" (so the URL lies between that "["
    // and its closing "]") means the URL stays plain text. But once
    // a "]" has been seen since the opener was pushed, the text is in
    // a link suffix (or after a failed link), and autolinks form
    // normally even though an outer "[" is still open (e.g. the
    // "https://sub.domain.example.io)]" in doc-08). Bracket autolinks
    // above are unaffected: they form inside link text and do not
    // block the outer link.
    let inLinkText = false;
    for (let k = openers.length - 1; k >= 0; k--) {
      const it = items[openers[k]];
      if (it.active && it.pos > lastClosePos) {
        inLinkText = true;
        break;
      }
    }
    // extended autolinks are also off while inside an <a> (see
    // inLink above)
    const extOk = !inLinkText && !inLink;
    if (extOk && c === "w" && s.startsWith("www.", i)) {
      const prev = i > 0 ? s[i - 1] : " ";
      if (
        i === 0 || isUnicodeSpace(prev) || prev === "*" || prev === "_" ||
        prev === "~" || prev === "("
      ) {
        const ext = matchExtendedUrl(s, i, 4);
        if (ext) {
          flush();
          items.push(ext.node);
          i = ext.end;
          continue;
        }
      }
    }
    if (extOk && (c === "h" || c === "H" || c === "f" || c === "F") && isSchemeUrl(s, i)) {
      const ext = matchExtendedUrl(s, i, 0);
      if (ext) {
        flush();
        items.push(ext.node);
        i = ext.end;
        continue;
      }
    }
    // email autolink: only tried at the start of a local-part run
    if (extOk && isEmailLocalChar(c) && atEmailRunStart()) {
      // lengths of opening "_" delimiters seen so far in this run,
      // so a "_" run after the domain can be recognised as the
      // closing delimiter (see parseEmailDomain)
      let openUnderscoreLens = null;
      for (let k = items.length - 1; k >= 0; k--) {
        const it = items[k];
        if (it.t === "delim" && it.ch === "_" && it.canOpen) {
          if (!openUnderscoreLens) openUnderscoreLens = new Set();
          openUnderscoreLens.add(it.len);
        }
      }
      const em = matchEmail(s, i, openUnderscoreLens);
      if (em) {
        flush();
        items.push(em.node);
        i = em.end;
        continue;
      }
    }
    // scheme:email autolink: only tried at the start of a lowercase word
    if (extOk && c >= "a" && c <= "z" && (i === 0 || !isSchemeChar(s[i - 1]))) {
      const se = matchSchemeEmail(s, i);
      if (se) {
        flush();
        items.push(se.node);
        i = se.end;
        continue;
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
        flush();
        items.push({ t: "br" });
        i++;
        // a hard break strips the leading whitespace of the next line
        while (i < n && (s[i] === " " || s[i] === "\t")) i++;
      } else {
        addText("\n");
        i++;
      }
      continue;
    }

    // --- ordinary character ---------------------------------------------
    addText(c);
    i++;
  }
  flush();
  // any "[" left over (active or deactivated) is literal text
  finalizeOpens(items);
  return items;
}

// Turn leftover "[" opener items into literal text, everywhere in the tree.
function finalizeOpens(items) {
  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    if (item.t === "open") {
      items[k] = { t: "text", s: (item.bang ? "!" : "") + "[" };
    } else if (item.t === "link" || item.t === "image") {
      finalizeOpens(item.children);
    }
  }
}

// --- entities ------------------------------------------------------------
// Returns {kind:'named', text, end} for &name; (any name passes through
// unchanged), {kind:'numeric', decoded, end} for a valid numeric reference,
// or null when the & is not an entity at all.
function matchEntity(s, i) {
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
    const decoded = decodeNumericRef(body);
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
function isEmailLocalChar(c) {
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

function isSchemeChar(c) {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || c === "+" || c === "." || c === "-"
  );
}

// Bracket autolink email: local@domain (no dot required in the domain).
function matchBracketEmail(text) {
  const at = text.indexOf("@");
  if (at <= 0) return false;
  for (let k = 0; k < at; k++) {
    if (!isEmailLocalChar(text[k])) return false;
  }
  const domain = text.slice(at + 1);
  if (domain.length === 0) return false;
  const labels = domain.split(".");
  for (const label of labels) {
    if (label.length === 0) return false;
    if (!isAlphaNum(label[0]) || !isAlphaNum(label[label.length - 1])) return false;
    for (let k = 1; k < label.length - 1; k++) {
      const ch = label[k];
      if (!isAlphaNum(ch) && ch !== "-") return false;
    }
  }
  return true;
}

function matchBracketAutolink(s, i) {
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
  // scheme form: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:rest (scheme is 2-32 chars)
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
  if (matchBracketEmail(content)) {
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
const RE_TAGNAME = /^[a-zA-Z][a-zA-Z0-9-]*/;

function matchHtmlTag(s, i) {
  const n = s.length;
  // comment
  if (s.startsWith("<!--", i)) {
    if (s.startsWith("<!-->", i)) return { text: "<!-->", end: i + 5 };
    if (s.startsWith("<!--->", i)) return { text: "<!--->", end: i + 6 };
    const close = s.indexOf("-->", i + 4);
    if (close < 0) return null;
    // the comment ends at the first "-->"; "--" may appear inside it
    return { text: s.slice(i, close + 3), end: close + 3 };
  }
  // processing instruction
  if (s.startsWith("<?", i)) {
    const close = s.indexOf("?>", i + 2);
    if (close < 0) return null;
    return { text: s.slice(i, close + 2), end: close + 2 };
  }
  // declaration <!A ...>
  if (s.startsWith("<!", i) && i + 2 < n && /[a-zA-Z]/.test(s[i + 2])) {
    const close = s.indexOf(">", i + 2);
    if (close < 0) return null;
    return { text: s.slice(i, close + 1), end: close + 1 };
  }
  // CDATA
  if (s.startsWith("<![CDATA[", i)) {
    const close = s.indexOf("]]>", i + 9);
    if (close < 0) return null;
    return { text: s.slice(i, close + 3), end: close + 3 };
  }
  // closing tag
  if (s.startsWith("</", i)) {
    const m = RE_TAGNAME.exec(s.slice(i + 2));
    if (!m) return null;
    let j = i + 2 + m[0].length;
    while (j < n && (s[j] === " " || s[j] === "\t" || s[j] === "\n")) j++;
    if (j >= n || s[j] !== ">") return null;
    return { text: s.slice(i, j + 1), end: j + 1 };
  }
  // open tag
  const m = RE_TAGNAME.exec(s.slice(i + 1));
  if (!m) return null;
  let j = i + 1 + m[0].length;
  while (true) {
    // whitespace before an attribute, "/>", or ">"
    let k = j;
    while (k < n && (s[k] === " " || s[k] === "\t" || s[k] === "\n" || s[k] === "\r" || s[k] === "\f")) k++;
    if (k < n && s[k] === ">") return { text: s.slice(i, k + 1), end: k + 1 };
    if (k < n && s[k] === "/" && k + 1 < n && s[k + 1] === ">") {
      return { text: s.slice(i, k + 2), end: k + 2 };
    }
    if (k === j) return null; // expected whitespace or ">"
    j = k;
    // attribute name
    if (j >= n) return null;
    const ac = s.charCodeAt(j);
    const attrStart = /[a-zA-Z_:]/.test(s[j]);
    if (!attrStart) return null;
    j++;
    while (j < n && /[a-zA-Z0-9_.:-]/.test(s[j])) j++;
    // optional = value
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
          const code = s.charCodeAt(v);
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
    // loop for the next attribute
    if (j >= n) return null;
  }
}

// --- extended autolinks (GFM) ----------------------------------------------
// Trim a matched extended URL: drop a trailing entity-like &...;, strip
// trailing punctuation, then balance parentheses. Repeats until stable.
const RE_ENTITY_TAIL = /^&(?:[A-Za-z0-9]+|#\d+|#[xX][0-9a-fA-F]+);$/;
function trimExtendedUrl(t) {
  let changed = true;
  while (changed) {
    changed = false;
    if (t.length > 0 && t.charCodeAt(t.length - 1) === 59) {
      const amp = t.lastIndexOf("&");
      if (amp >= 0 && RE_ENTITY_TAIL.test(t.slice(amp))) {
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

function isUrlChar(c) {
  const code = c.charCodeAt(0);
  return code > 32 && c !== "<" && code !== 127;
}

// Does s start with http://, https:// or ftp:// (any case) at i?
function isSchemeUrl(s, i) {
  const rest = s.slice(i, i + 8).toLowerCase();
  return (
    rest.startsWith("http://") || rest.startsWith("https://") ||
    rest.startsWith("ftp://")
  );
}

// Match a www. or scheme:// extended autolink starting at i.
// prefixLen is 4 for "www." (the domain starts after it) and 0 for a
// scheme:// URL (the whole match, scheme included, starts at i).
function matchExtendedUrl(s, i, prefixLen) {
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
  // the rest of the URL: anything but whitespace, "<", or control chars
  while (j < n && isUrlChar(s[j])) j++;
  let text = s.slice(i, j);
  text = trimExtendedUrl(text);
  if (text.length === 0) return null;
  const shown = prefixLen === 4 ? text : text;
  const href = prefixLen === 4 ? "http://" + text : text;
  return {
    node: {
      t: "link", href, title: null, auto: true,
      children: [{ t: "text", s: shown }],
    },
    end: i + text.length,
  };
}

// Parse an email domain starting at i (right after "@").
// Returns the end offset of the domain, or -1 if invalid. The domain needs
// at least one dot; the first label is any run of [A-Za-z0-9_-], later
// labels must end in an alphanumeric; if the character after the domain is
// [A-Za-z0-9_-], the last dot-group is dropped and the check repeats.
function parseEmailDomain(s, i, openUnderscoreLens) {
  const n = s.length;
  const ends = [];
  let j = i;
  // first label: [A-Za-z0-9_-]+
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
  // dot-groups
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
    // trim trailing - / _ (label must end alphanumeric)
    let labelEnd = k;
    while (labelEnd > labelStart) {
      const c = s[labelEnd - 1];
      if (c === "-" || c === "_") labelEnd--;
      else break;
    }
    if (labelEnd === labelStart) break; // empty label: no more groups
    ends.push(labelEnd);
    j = k;
  }
  if (ends.length < 2) return -1;
  // lookahead: the character after the domain must not be [A-Za-z0-9_-]
  while (ends.length >= 2) {
    const end = ends[ends.length - 1];
    if (end < n) {
      const c = s[end];
      const code = s.charCodeAt(end);
      const inSet =
        (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) || c === "-" || c === "_";
      if (inSet) {
        // a "_" run after the domain does not force a backtrack when
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
function matchEmail(s, i, openUnderscoreLens) {
  const n = s.length;
  let j = i;
  while (j < n && isEmailLocalChar(s[j])) j++;
  if (j === i || j >= n || s[j] !== "@") return null;
  const domainEnd = parseEmailDomain(s, j + 1, openUnderscoreLens);
  if (domainEnd < 0) return null;
  const text = s.slice(i, domainEnd);
  return {
    node: {
      t: "link", href: "mailto:" + text, title: null, auto: true,
      children: [{ t: "text", s: text }],
    },
    end: domainEnd,
  };
}

// Match a scheme:email autolink starting at i (start of a lowercase word).
// After the email, one path segment of [A-Za-z0-9.@]+ may follow.
function matchSchemeEmail(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && isSchemeChar(s[j])) j++;
  const scheme = s.slice(i, j);
  if (scheme.length < 2) return null;
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;
  if (j >= n || s[j] !== ":") return null;
  let k = j + 1;
  const localStart = k;
  while (k < n && isEmailLocalChar(s[k])) k++;
  if (k === localStart || k >= n || s[k] !== "@") return null;
  const domainEnd = parseEmailDomain(s, k + 1);
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
  // strip trailing punctuation from the path segment
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
      t: "link", href: text, title: null, auto: true,
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
function skipWs(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
    else break;
  }
  return i;
}

function parseLinkSuffix(s, pos) {
  const n = s.length;
  // the "(" or "[" must immediately follow the "]": no whitespace
  // (a space or newline means this is not an inline link or a full
  // reference link, and the caller falls back to the shortcut form)
  let i = pos;
  if (i < n && s[i] === "(") {
    i++;
    i = skipWs(s, i);
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
          if (dc < 128 && ASCII_PUNCT[dc] === 1) {
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
          if (dc < 128 && ASCII_PUNCT[dc] === 1) {
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
        // an empty destination is allowed: [link]()
        dest = "";
      }
      i = j;
    }
    i = skipWs(s, i);
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
          if (dc < 128 && ASCII_PUNCT[dc] === 1) {
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
      i = skipWs(s, i);
    }
    if (i >= n || s[i] !== ")") return null;
    return { kind: "inline", href: dest, title, end: i + 1 };
  }
  if (i < n && s[i] === "[") {
    // a link label must not contain an unescaped "["; escaped brackets
    // are kept raw (labels are matched on their raw text)
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
function containsLink(nodes) {
  for (const node of nodes) {
    if (node.t === "link" && !node.auto) return true;
    if (node.children && containsLink(node.children)) return true;
  }
  return false;
}

// Probed 16 Nov 2026 (probe79/80/81): a link does not form when its
// text contains a code span whose content includes a backtick and
// there is any content after that code span before the closing `]`
// (even just spaces, another code span, or emphasis). When the
// backtick-containing code span is the last item in the link text,
// the link forms normally.
function hasBacktickCodeSpanTail(nodes) {
  for (let k = 0; k < nodes.length - 1; k++) {
    const node = nodes[k];
    if (node.t === "code" && typeof node.s === "string" && node.s.includes("`")) return true;
  }
  return false;
}

// Plain text of a list of nodes (used for image alt text and link labels).
// Delimiter and bracket items are included raw: labels are computed from
// the scanned items, before emphasis runs.
function plainText(nodes) {
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
        out += plainText(node.children);
        break;
      case "image":
        out += plainText(node.children);
        break;
      default:
        break;
    }
  }
  return out;
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
function processEmphasis(items) {
  for (const item of items) {
    if (item.t === "link" || item.t === "image") {
      processEmphasis(item.children);
    }
  }
  // Pre-pass (probed 16 Nov 2026, probe86/87/88): a link or image whose
  // text holds a literal backtick, followed later in the same inline
  // string by a code span, suppresses emphasis delimiters between
  // them — marked leaves those delimiters literal. A proper code span
  // (even one whose content holds a backtick) does not trigger this;
  // only a backtick sitting in a text node does. The code span may be
  // nested inside a later link or image (its position is that node's).
  // The suppression runs only up to the FIRST code span after the
  // link: once a code span has intervened, later emphasis is normal
  // again (doc-07: a `lib/main.js` span before the emphasis lets it
  // form).
  const hasLiteralBacktick = (node) => {
    if (!node.children) return false;
    for (const c of node.children) {
      if (c.t === "text" && typeof c.s === "string" && c.s.includes("`")) return true;
      if ((c.t === "link" || c.t === "image") && hasLiteralBacktick(c)) return true;
    }
    return false;
  };
  const hasCodeSpan = (node) => {
    if (!node.children) return false;
    for (const c of node.children) {
      if (c.t === "code") return true;
      if ((c.t === "link" || c.t === "image") && hasCodeSpan(c)) return true;
    }
    return false;
  };
  let minBroken = -1;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if ((it.t === "link" || it.t === "image") && hasLiteralBacktick(it)) {
      minBroken = k;
      break;
    }
  }
  let firstCode = -1;
  if (minBroken >= 0) {
    for (let k = minBroken + 1; k < items.length; k++) {
      const it = items[k];
      if (it.t === "code" || ((it.t === "link" || it.t === "image") && hasCodeSpan(it))) {
        firstCode = k;
        break;
      }
    }
  }
  if (minBroken >= 0 && firstCode > minBroken) {
    for (let k = minBroken + 1; k < firstCode; k++) {
      const it = items[k];
      if (it.t === "delim" && (it.ch === "*" || it.ch === "_")) {
        it.canOpen = false;
        it.canClose = false;
      }
    }
  }
  const stack = []; // delim items that can open, in encounter order
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
  // length of the both-closer that set the strict flag (see below)
  const oddStrictLen = { "*": 0, "_": 0, "~": 0 };
  let ci = 0;
  while (ci < items.length) {
    const item = items[ci];
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
        const oi = items.indexOf(opener);
        const children = items.slice(oi + 1, ci);
        // delimiters wrapped inside the new node can no longer open
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
          const before = items[ci - 1];
          const before2 = ci >= 2 ? items[ci - 2] : null;
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
        items.splice(oi, ci - oi + 1, ...replacement);
        // rebuild the stack: drop the opener and anything now inside
        // the node; keep the leftover opener at the opener's place
        const kept = [];
        for (let k = 0; k < stack.length; k++) {
          if (k === found) {
            if (leftoverOpener) kept.push(leftoverOpener);
            continue;
          }
          if (!stack[k].dead) kept.push(stack[k]);
        }
        stack.length = 0;
        for (const s of kept) stack.push(s);
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
  // whatever is left over is literal text, anywhere in the tree
  convertDelims(items);
}

// Turn leftover delimiter items into literal text, everywhere in the tree.
function convertDelims(items) {
  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    if (item.t === "delim") {
      items[k] = { t: "text", s: item.ch.repeat(item.len) };
    } else if (item.children) {
      convertDelims(item.children);
    }
  }
}

// Parse one inline string into a list of nodes.
function parseInline(s, refs) {
  if (s === "") return [];
  const items = scanInline(s, refs);
  processEmphasis(items);
  return items;
}

// Render inline nodes to HTML.
function renderInline(nodes, out) {
  for (const node of nodes) {
    switch (node.t) {
      case "text":
        out.push(escAttr(node.s));
        break;
      case "code":
        out.push("<code>", escAll(node.s), "</code>");
        break;
      case "html":
        out.push(node.s);
        break;
      case "br":
        out.push("<br>");
        break;
      case "em":
        out.push("<em>");
        renderInline(node.children, out);
        out.push("</em>");
        break;
      case "strong":
        out.push("<strong>");
        renderInline(node.children, out);
        out.push("</strong>");
        break;
      case "del":
        out.push("<del>");
        renderInline(node.children, out);
        out.push("</del>");
        break;
      case "link": {
        out.push('<a href="', cleanHref(node.href), '"');
        if (node.title !== null && node.title !== undefined) {
          out.push(' title="', escAttr(node.title), '"');
        }
        out.push(">");
        renderInline(node.children, out);
        out.push("</a>");
        break;
      }
      case "image": {
        out.push('<img src="', cleanHref(node.src), '" alt="');
        out.push(escAttr(plainText(node.children)));
        out.push('"');
        if (node.title !== null && node.title !== undefined) {
          out.push(' title="', escAttr(node.title), '"');
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
function inlineHtml(s, refs) {
  const out = [];
  renderInline(parseInline(s, refs), out);
  return out.join("");
}

// ---------------------------------------------------------------------------
// Block parsing
//
// Line-based, container aware, tab aware. Each line is processed with a
// cursor (index, visual column, partially-consumed tab remainder) so tabs
// expand the way CommonMark requires, including tabs that are only partly
// consumed by an indent. The open blocks live on a stack; every line first
// matches the open containers, then either continues the open leaf or
// starts new blocks.
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "base", "basefont", "blockquote", "body",
  "caption", "center", "col", "colgroup", "dd", "details", "dialog", "dir",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header",
  "hr", "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem",
  "nav", "noframes", "ol", "optgroup", "option", "p", "param", "search",
  "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
  "title", "tr", "track", "ul",
]);

function isLeafType(t) {
  return (
    t === "para" || t === "heading" || t === "code" || t === "html" ||
    t === "hr" || t === "table"
  );
}

function isAsciiPunctChar(c) {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return code < 128 && ASCII_PUNCT[code] === 1;
}

// Split a table row line into cells: split on unescaped "|", trim cells,
// drop an empty first/last cell (from a leading/trailing pipe). An
// escaped "\|" does not split and becomes a literal "|" in the cell text
// (so it renders as "|" even inside a code span); other escapes are kept
// for the inline parser.
function splitTableRow(line) {
  const cells = [];
  let cur = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === "\\" && i + 1 < n && isAsciiPunctChar(line[i + 1])) {
      if (line[i + 1] === "|") cur += "|";
      else cur += c + line[i + 1];
      i += 2;
      continue;
    }
    if (c === "|") {
      cells.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].trim();
  if (cells.length > 0 && cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

class BlockParser {
  constructor(input) {
    this.input = input.replace(/\r\n?/g, "\n");
    this.lines = this.input.split("\n");
    this.refs = new Map();
    this.root = { t: "doc", children: [] };
    this.stack = [this.root];
    this.s = "";
    this.i = 0;
    this.col = 0;
    this.partial = 0;
  }

  tip() {
    return this.stack[this.stack.length - 1];
  }

  // --- line cursor -------------------------------------------------------
  saveCursor() {
    return { i: this.i, col: this.col, partial: this.partial };
  }
  restoreCursor(c) {
    this.i = c.i;
    this.col = c.col;
    this.partial = c.partial;
  }
  peek() {
    if (this.partial > 0) return " ";
    return this.i < this.s.length ? this.s[this.i] : "";
  }
  // Advance up to n columns of whitespace; returns columns advanced.
  advance(n) {
    let adv = 0;
    while (adv < n) {
      if (this.partial > 0) {
        const take = Math.min(this.partial, n - adv);
        this.partial -= take;
        this.col += take;
        adv += take;
        continue;
      }
      if (this.i >= this.s.length) break;
      const ch = this.s[this.i];
      if (ch === " ") {
        this.i++;
        this.col++;
        adv++;
      } else if (ch === "\t") {
        const w = 4 - (this.col % 4);
        const take = Math.min(w, n - adv);
        this.i++;
        this.col += take;
        adv += take;
        if (take < w) this.partial = w - take;
      } else break;
    }
    return adv;
  }
  rest() {
    return (this.partial > 0 ? " ".repeat(this.partial) : "") + this.s.slice(this.i);
  }
  isBlankFromCursor() {
    let i = this.i;
    while (i < this.s.length) {
      const ch = this.s[i];
      if (ch === " " || ch === "\t") i++;
      else return false;
    }
    return true;
  }

  // Is the current line (after the matched containers) blank? A line is
  // blank if it is empty, or whitespace-only and terminated, or
  // whitespace-only and lazy (a container failed), or whitespace-only
  // inside a list item. A whitespace-only line that is the last line of
  // the input, is not lazy, and is not inside a list item is paragraph
  // content (its whitespace is kept). Inside a blockquote the line is
  // content when it is the quote's last line (the next line does not
  // match the quote), because the quote's inner source ends there
  // without a trailing newline.
  isBlankLine(failedContainer) {
    const rest = this.rest();
    if (rest === "") return true;
    if (!/^[ \t]*$/.test(rest)) return false;
    if (failedContainer) return true;
    if (this.tip().t !== "para") return true;
    let inQuote = false;
    for (let k = 1; k < this.stack.length; k++) {
      if (this.stack[k].t === "item") return true;
      if (this.stack[k].t === "quote") inQuote = true;
    }
    if (inQuote) {
      if (this.lineIndex + 1 >= this.lines.length) return false;
      return this.nextLineMatchesContainers();
    }
    return this.lineIndex !== this.lines.length - 1;
  }
  indentAtCursor() {
    const save = this.saveCursor();
    const n = this.advance(1000000);
    this.restoreCursor(save);
    return n;
  }

  // --- main loop ---------------------------------------------------------
  parse() {
    for (let li = 0; li < this.lines.length; li++) {
      this.lineIndex = li;
      this.s = this.lines[li];
      this.i = 0;
      this.col = 0;
      this.partial = 0;
      // columns consumed by phase-1 list-item matching on this line;
      // list-item indents are relative to the cursor after the enclosing
      // blockquotes, so a new item's columns are measured from the
      // cursor minus what the open items already consumed
      this.itemIndentConsumed = 0;
      this.processLine();
    }
    while (this.stack.length > 1) {
      const block = this.tip();
      if (block.t === "html") {
        // at the end of the input inside a container, an HTML block has
        // no trailing newline (the container's inner source ends without
        // one); at the top level the input's own trailing newline counts
        for (let k = 1; k < this.stack.length - 1; k++) {
          const t = this.stack[k].t;
          if (t === "quote" || t === "item") {
            block.lastTerminated = false;
            break;
          }
        }
      }
      this.closeTip();
    }
    return this.root;
  }

  processLine() {
    // Phase 1: match the open containers, outermost first. Lists always
    // match (they consume no columns); quotes and items are matched
    // against the line; a leaf ends the container run.
    let containerIdx = 1;
    while (containerIdx < this.stack.length) {
      const b = this.stack[containerIdx];
      if (b.t === "list") {
        containerIdx++;
        continue;
      }
      if (b.t !== "quote" && b.t !== "item") break;
      if (b.t === "quote") {
        if (!this.tryBlockquote()) break;
      } else {
        const beforeCol = this.col;
        if (!this.tryItem(b)) break;
        this.itemIndentConsumed += this.col - beforeCol;
      }
      containerIdx++;
    }
    const failedContainer =
      containerIdx < this.stack.length &&
      (this.stack[containerIdx].t === "quote" || this.stack[containerIdx].t === "item");
    // the innermost container this line matched: a blank line only
    // marks that container (and its descendants) as ending blank, not
    // the ancestors above it (a blank line inside a quote or sublist
    // does not loosen the enclosing list)
    this.blankContainer = this.stack[containerIdx - 1];
    const blank = this.isBlankLine(failedContainer);
    if (failedContainer && !blank) {
      const tip = this.tip();
      if (tip.t === "code" && tip.fenced) {
        // A fenced code block's lines are literal: they do not need to
        // match a list item's indent. But a line that fails to match a
        // blockquote is outside the quote, so the block inside it ends.
        // Probed 16 Nov 2026 (probe72): the list-item leniency only
        // applies once the block already has a non-blank content line;
        // an empty block ends on the first non-matching line instead
        // (the line becomes a new block outside, and a fence line
        // opens a new code block).
        const failed = this.stack[containerIdx];
        // The leniency only applies when every failed container is a
        // list item: if any failed container is a blockquote, the line
        // is outside the quote and the block ends (doc-36: the line
        // fails an outer item AND the inner quote; the quote failure
        // wins). containerIdx is the outermost failure, so scan the
        // whole failed range up to the tip.
        let failedQuote = false;
        for (let k = containerIdx; k < this.stack.length - 1; k++) {
          if (this.stack[k].t === "quote") {
            failedQuote = true;
            break;
          }
        }
        if (failed && failed.t === "item" && !failedQuote && /[^\n]/.test(tip.lit)) {
          if (this.isClosingFence(tip)) {
            this.closeTip();
            return;
          }
          this.addCodeLine(tip);
          return;
        }
      }
      if (tip.t === "para") {
        // Lazy continuation. A line that does not match the paragraph's
        // containers is added to the paragraph only if it starts no block:
        // any block start closes the containers instead. Two exceptions:
        // a type-7 HTML block closes the paragraph but stays inside the
        // innermost container, and a table delimiter applies to a
        // paragraph whose parent is a list item (not a blockquote).
        const html = this.matchHtmlBlock();
        if (html && html.kind === 7) {
          this.closeTip();
          this.addNode(html);
          this.stack.push(html);
          return;
        }
        if (!html && !this.lineStartsAnyBlock()) {
          const parent = this.stack[this.stack.length - 2];
          if (this.isTableDelimiter() && parent.t === "item") {
            this.convertTable();
            return;
          }
          const para = this.tip();
          // a lazy "=" setext line inside a blockquote, following another
          // lazy line, is padded to four spaces (marked's blockquote
          // setext fixup: "\n {0,3}(=+...)" -> "\n    $1")
          if (/^[ \t]*=+[ \t]*$/.test(this.rest()) && para.hasLazyLine && parent.t === "quote") {
            para.lines.push("    " + this.rest().trimStart());
            return;
          }
          // a lazy line indented by 4 or more columns loses 4 columns
          if (this.indentAtCursor() >= 4) this.advance(4);
          para.hasLazyLine = true;
          this.addParaLine();
          return;
        }
        // otherwise fall through: close the unmatched containers
      } else if (tip.t === "table") {
        // Lazy table row: a row line that starts no block joins the table
        // even though it does not match the table's containers.
        if (!this.lineStartsNewBlock()) {
          this.addTableRow(tip);
          return;
        }
      }
    }
    if (failedContainer) {
      // an HTML block closed by a container failure has no trailing
      // newline
      for (let k = containerIdx; k < this.stack.length; k++) {
        if (this.stack[k].t === "html") this.stack[k].lastTerminated = false;
      }
      this.closeTo(containerIdx);
    }
    // a non-blank line ends the blank run for every block it belongs
    // to: a blank line only loosens a list when no content follows it
    // inside the same item
    if (!blank) {
      for (const b of this.stack) b.lastLineBlank = false;
    }
    this.processFresh();
  }

  // Does the line at the cursor start any block (ATX, fence, HTML block of
  // any type, thematic break, list item, blockquote)?
  lineStartsAnyBlock() {
    const save = this.saveCursor();
    if (this.matchAtx() || this.matchFence() || this.matchHtmlBlock()) {
      this.restoreCursor(save);
      return true;
    }
    if (this.isThematicBreak()) {
      this.restoreCursor(save);
      return true;
    }
    if (this.matchListItem()) {
      this.restoreCursor(save);
      return true;
    }
    if (this.matchBlockquoteStart()) {
      this.restoreCursor(save);
      return true;
    }
    this.restoreCursor(save);
    return false;
  }

  closeTo(idx) {
    while (this.stack.length > idx) this.closeTip();
  }

  closeTip() {
    const block = this.stack.pop();
    this.finalize(block);
    if (block.t === "para" && block.lines.length === 0) {
      const parent = this.tip();
      const at = parent.children.indexOf(block);
      if (at >= 0) parent.children.splice(at, 1);
    }
  }

  finalize(block) {
    if (block.t === "para") this.finalizePara(block);
    else if (block.t === "list") this.finalizeList(block);
    else if (block.t === "code") {
      if (block.fenced) {
        // a fenced code block keeps its trailing blank lines: they are
        // inside the fences. The lit already ends with "\n" when the
        // last line is blank, so only a terminated non-blank last line
        // needs the renderer's extra newline. A block whose lit is
        // empty (a single empty line between the fences) renders empty,
        // not as one newline. (Probed 16 Nov 2026.)
        block.lastTerminated =
          block.lit !== "" &&
          !block.lit.endsWith("\n") &&
          block.lastLineTerminated === true;
        return;
      }
      // Trailing blank lines do not belong to an indented code block,
      // unless the block holds nothing but blank lines (then they are
      // its content).
      const lines = block.lit.split("\n");
      let lastNonBlank = -1;
      for (let k = lines.length - 1; k >= 0; k--) {
        if (!/^[ \t]*$/.test(lines[k])) {
          lastNonBlank = k;
          break;
        }
      }
      if (lastNonBlank >= 0) {
        lines.length = lastNonBlank + 1;
        block.lit = lines.join("\n");
        block.lastTerminated = block.lastContentTerminated === true;
      } else {
        block.lastTerminated = block.lastLineTerminated === true;
      }
    }
  }

  finalizePara(para) {
    this.extractRefDefs(para);
  }

  // Consume leading link reference definitions from a paragraph's lines,
  // registering them (the first definition of a label wins).
  extractRefDefs(para) {
    const lines = para.lines;
    let i = 0;
    while (i < lines.length) {
      const res = this.tryParseRefDef(lines, i);
      if (!res) break;
      const key = normalizeLabel(res.label);
      if (!this.refs.has(key)) {
        this.refs.set(key, { href: res.href, title: res.title });
      }
      i = res.nextLine;
    }
    para.lines = lines.slice(i);
  }

  finalizeList(list) {
    let tight = true;
    const items = list.children;
    for (let k = 0; k < items.length; k++) {
      const item = items[k];
      if (item.looseInner) {
        tight = false;
        break;
      }
      if (item.lastLineBlank && k + 1 < items.length) {
        tight = false;
        break;
      }
      for (let j = 0; j < item.children.length; j++) {
        const child = item.children[j];
        if (child.lastLineBlank && j + 1 < item.children.length) {
          tight = false;
          break;
        }
      }
      if (!tight) break;
    }
    list.tight = tight;
  }

  // --- container matching --------------------------------------------------
  tryBlockquote() {
    if (this.isBlankFromCursor()) {
      // a blank line only matches if it carries the ">" marker; a blank
      // line without it ends the blockquote
      const save = this.saveCursor();
      this.advance(3);
      if (this.peek() === ">") {
        this.i++;
        this.col++;
        const p = this.peek();
        if (p === " " || p === "\t") this.advance(1);
        return true;
      }
      this.restoreCursor(save);
      return false;
    }
    const save = this.saveCursor();
    this.advance(3);
    if (this.peek() === ">") {
      this.i++;
      this.col++;
      const p = this.peek();
      if (p === " " || p === "\t") this.advance(1);
      return true;
    }
    this.restoreCursor(save);
    return false;
  }

  tryItem(item) {
    if (this.isBlankFromCursor()) return true;
    // an empty item is closed by a blank line: indented content after
    // it belongs to the enclosing block, not to the item
    if (item.children.length === 0 && item.lastLineBlank) return false;
    // the item's indent is relative to the cursor after the enclosing
    // blockquotes (the same containers can consume a different number
    // of columns on different lines); outer items already consumed
    // part of it
    const need = (item.contentIndent - item.baseCol) - this.itemIndentConsumed;
    if (need <= 0) return true;
    const save = this.saveCursor();
    if (this.advance(need) === need) return true;
    this.restoreCursor(save);
    return false;
  }

  // --- fresh line processing ----------------------------------------------
  processFresh() {
    while (true) {
      const tip = this.tip();
      if (tip.t === "code" && tip.fenced) {
        if (this.isClosingFence(tip)) {
          this.closeTip();
          return;
        }
        this.addCodeLine(tip);
        return;
      }
      if (tip.t === "html") {
        if ((tip.kind === 6 || tip.kind === 7) && this.isBlankFromCursor()) {
          // a trailing blank line at the very end of the input belongs
          // to the block
          if (this.lineIndex === this.lines.length - 1) {
            tip.lit += "\n" + this.rest();
            tip.lastTerminated = false;
          }
          this.closeTip();
          // fall through: the blank line is processed below
        } else {
          const ends = tip.kind <= 5 && this.htmlEndOnLine(tip);
          this.addHtmlLine(tip);
          if (ends) {
            tip.lastTerminated = this.htmlEndsWithNewline();
            this.closeTip();
          }
          return;
        }
      }
      if (tip.t === "code" && !tip.fenced) {
        if (this.isBlankFromCursor() || this.indentAtCursor() >= 4) {
          this.addCodeLine(tip);
          return;
        }
        this.closeTip();
        continue;
      }
      if (tip.t === "table") {
        // A whitespace-only line ends the table -- except one whose
        // indent is exactly 4 columns, which is an empty row (a lone
        // tab, or a space plus a tab, both measure 4 columns).
        if (this.isBlankFromCursor() && this.indentAtCursor() !== 4) {
          this.closeTip();
          continue;
        }
        if (this.lineStartsNewBlock()) {
          this.closeTip();
          continue;
        }
        this.addTableRow(tip);
        return;
      }
      if (this.isBlankLine(false)) {
        this.handleBlankLine();
        return;
      }
      if (tip.t === "para") {
        // a setext underline or table delimiter is only recognised after
        // leading link reference definitions are removed; definitions
        // whose title may still be on the next line are left alone here
        // (they are extracted when the paragraph is finalised)
        const level = this.isSetextLine();
        const isTable = level === 0 && this.isTableDelimiter();
        if (level > 0 || isTable) {
          this.extractRefDefs(tip);
          if (tip.lines.length === 0) {
            this.closeTip();
            continue;
          }
        }
        if (level > 0) {
          this.convertSetext(level);
          return;
        }
        if (isTable) {
          this.convertTable();
          return;
        }
      }
      const atx = this.matchAtx();
      if (atx) {
        this.closeLeaf();
        this.closeLists();
        this.addNode(atx);
        return;
      }
      const fence = this.matchFence();
      if (fence) {
        this.closeLeaf();
        this.closeLists();
        this.addNode(fence);
        this.stack.push(fence);
        return;
      }
      const html = this.matchHtmlBlock();
      if (html) {
        if (html.kind === 7 && tip.t === "para") {
          // a type-7 block cannot interrupt a paragraph: fall through to
          // the paragraph continuation below
        } else {
          this.closeLeaf();
          this.closeLists();
          this.addNode(html);
          if (!(html.kind <= 5 && this.htmlEndOnLine(html))) {
            this.stack.push(html);
          }
          return;
        }
      }
      if (this.isThematicBreak()) {
        this.closeLeaf();
        this.closeLists();
        this.addNode({ t: "hr", children: [] });
        return;
      }
      const listSave = this.saveCursor();
      const item = this.matchListItem();
      if (item) {
        // An ordered list starting with a number other than 1 cannot
        // interrupt a paragraph -- unless the paragraph sits inside a
        // list item, where a nested list of any start number may
        // follow it (an empty item never interrupts a paragraph).
        const tipParent =
          this.stack.length >= 2 ? this.stack[this.stack.length - 2] : null;
        const inItem = tipParent !== null && tipParent.t === "item";
        if (
          this.tip().t === "para" &&
          (item.blank || (item.ordered && item.start !== 1 && !inItem))
        ) {
          // cannot interrupt a paragraph: the line is paragraph text
          this.restoreCursor(listSave);
          this.addParaLine();
          return;
        }
        this.startListItem(item);
        // an empty item (marker with no content) has nothing more on
        // this line; continuing would treat the consumed marker line as
        // a blank line and wrongly loosen the list
        if (item.blank) return;
        continue;
      }
      if (this.matchBlockquoteStart()) {
        this.closeLeaf();
        this.closeLists();
        const quote = { t: "quote", children: [] };
        this.addNode(quote);
        this.stack.push(quote);
        continue;
      }
      if (tip.t !== "para" && this.indentAtCursor() >= 4) {
        this.closeLeaf();
        this.closeLists();
        const code = { t: "code", fenced: false, info: "", lit: "", started: false };
        this.addNode(code);
        this.stack.push(code);
        this.addCodeLine(code);
        return;
      }
      if (tip.t === "para") {
        this.addParaLine();
        return;
      }
      this.closeLeaf();
      this.closeLists();
      const para = { t: "para", lines: [this.expandParaTabs(this.rest())], hasLazyLine: false };
      this.addNode(para);
      this.stack.push(para);
      return;
    }
  }

  closeLeaf() {
    if (isLeafType(this.tip().t)) this.closeTip();
  }

  // Close any open lists: a new block that is not a list item cannot be a
  // direct child of a list, it belongs to the list's parent.
  closeLists() {
    while (this.tip().t === "list") this.closeTip();
  }

  addNode(node) {
    node.open = true;
    node.lastLineBlank = false;
    if (node.children === undefined) node.children = [];
    const parent = this.tip();
    // a blank line since the parent's previous child means this child
    // is separated from it by a blank line: the enclosing list is loose
    if (parent.t === "item" && parent.blankPending && parent.children.length > 0) {
      parent.looseInner = true;
    }
    parent.blankPending = false;
    parent.children.push(node);
  }

  handleBlankLine() {
    // A truly empty line marks every open block as ending blank; a line
    // that only looks blank inside its innermost container (e.g. "  >"
    // inside a quote) marks just that container and its descendants.
    // A blank line inside a quote or sublist must not loosen the
    // enclosing list, but a blank line between two items of a list must.
    let start;
    if (/^[ \t]*$/.test(this.s)) {
      start = 0;
    } else {
      start = this.stack.indexOf(this.blankContainer);
      if (start < 0) start = 0;
    }
    for (let k = start; k < this.stack.length; k++) {
      this.stack[k].lastLineBlank = true;
      this.stack[k].blankPending = true;
    }
    if (isLeafType(this.tip().t)) this.closeTip();
  }

  addParaLine() {
    this.tip().lines.push(this.expandParaTabs(this.rest()));
  }

  // Expand leading tabs in a paragraph line's content. Probed 16 Nov
  // 2026 (probe89/90): a tab at the start of the content expands to
  // spaces up to the next multiple of 4, with the column counted from
  // the innermost container — a blockquote counts from 2 (identical
  // for 1, 2 and 3 levels, and regardless of leading indent), a list
  // item from the absolute column; at the top level the raw tab is
  // preserved. Only leading whitespace is expanded; a tab in the
  // middle of the line stays a literal tab.
  expandParaTabs(text) {
    let inner = null;
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const b = this.stack[k];
      if (b.t === "quote" || b.t === "item") {
        inner = b.t;
        break;
      }
    }
    if (!inner) return text;
    let col = inner === "quote" ? 2 : this.col;
    let k = 0;
    let out = "";
    while (k < text.length) {
      const ch = text[k];
      if (ch === " ") {
        out += " ";
        col++;
        k++;
      } else if (ch === "\t") {
        const w = 4 - (col % 4);
        out += " ".repeat(w);
        col += w;
        k++;
      } else break;
    }
    return out + text.slice(k);
  }

  addCodeLine(block) {
    const indent = block.fenced ? block.fenceIndent : 4;
    // The rule depends on the INNERMOST container (probed 16 Nov 2026):
    // - innermost is a blockquote: the expansion is done on the line
    //   after the container markers are stripped but BEFORE the fence
    //   indent is removed, with the column counter starting at 2
    //   (identical for 1, 2 and 3 levels of blockquote; probe56),
    //   and the fence indent is then stripped from the expanded text;
    // - innermost is a list item: the tab is expanded on the absolute
    //   column (the item's content indent counts: a tab at absolute
    //   col 13 becomes 3 spaces), after the fence indent is stripped.
    //   This holds whether the item is inside a quote (doc-02) or on
    //   its own (doc-01). At the top level the raw tab is preserved,
    //   and the indent may consume (part of) a tab, which advance()
    //   handles via `partial`.
    let inner = null;
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const b = this.stack[k];
      if (b.t === "quote" || b.t === "item") {
        inner = b.t;
        break;
      }
    }
    let text;
    if (inner === "quote") {
      text = this.rest();
      if (text.indexOf("\t") >= 0) {
        let out = "";
        let col = 2;
        for (let k = 0; k < text.length; k++) {
          const ch = text[k];
          if (ch === "\t") {
            const w = 4 - (col % 4);
            out += " ".repeat(w);
            col += w;
          } else {
            out += ch;
            col++;
          }
        }
        text = out;
      }
      // the fence indent is stripped from the expanded text — except
      // for tilde fences, which never strip it (probe93/94)
      const isTilde = block.fenced && block.fenceChar === "~";
      let cut = 0;
      if (!isTilde) {
        while (cut < indent && cut < text.length && text[cut] === " ") cut++;
      }
      text = text.slice(cut);
      this.advance(indent);
    } else if (inner === "item") {
      const beforeI = this.i;
      // a tilde fence never strips its indent (probe93/94)
      if (!(block.fenced && block.fenceChar === "~")) this.advance(indent);
      // Probed 16 Nov 2026 (probe75): in a FENCED code block, when the
      // fence-indent strip partially consumes a tab, marked drops the
      // whole tab — the remainder is not kept as spaces. But a
      // remainder left over from container matching (no tab consumed
      // by this strip) is kept, so only drop it when this advance
      // crossed a tab. Indented code keeps the remainder (cm-005/007).
      if (block.fenced && this.partial > 0 && this.s.slice(beforeI, this.i).includes("\t")) this.partial = 0;
      text = this.rest();
      if (text.indexOf("\t") >= 0) {
        let out = "";
        let col = this.col;
        for (let k = 0; k < text.length; k++) {
          const ch = text[k];
          if (ch === "\t") {
            const w = 4 - (col % 4);
            out += " ".repeat(w);
            col += w;
          } else {
            out += ch;
            col++;
          }
        }
        text = out;
      }
    } else {
      const beforeI = this.i;
      // a tilde fence never strips its indent (probe93/94)
      if (!(block.fenced && block.fenceChar === "~")) this.advance(indent);
      // see the item branch: a tab partially consumed by the
      // fence-indent strip is dropped whole (fenced code only)
      if (block.fenced && this.partial > 0 && this.s.slice(beforeI, this.i).includes("\t")) this.partial = 0;
      text = this.rest();
    }
    if (block.started) block.lit += "\n";
    else block.started = true;
    block.lit += text;
    block.lastLineTerminated = this.lineTerminated();
    // remember whether the last non-blank line was terminated: trailing
    // blank lines are stripped from a code block when it closes
    if (!/^[ \t]*$/.test(text)) block.lastContentTerminated = this.lineTerminated();
  }

  lineTerminated() {
    // every line except the last line of the input is terminated
    return this.lineIndex < this.lines.length - 1;
  }

  // An HTML block's text ends with a newline only if this line is
  // terminated and the next line is not a blank line with more content
  // after it (a blank line ends the block without a trailing newline).
  htmlLineTerminated(kind) {
    if (!this.lineTerminated()) return false;
    const next = this.lineIndex + 1;
    if (next >= this.lines.length - 1) return true;
    const line = this.lines[next];
    // Probed 16 Nov 2026 (probe76/77): for kind <= 5 blocks a
    // whitespace-only (non-empty) next line keeps the trailing
    // newline; only a truly empty line drops it. Kind 6/7 blocks
    // drop it after any whitespace-only line.
    if (kind !== undefined && kind <= 5) return line !== "";
    return !/^[ \t]*$/.test(line);
  }

  // The HTML block just ended on the current line (its end marker was
  // found). A trailing newline is included only if the next line is
  // non-blank and stays inside the block's containers; at the end of the
  // input it is included only at the top level.
  htmlEndsWithNewline() {
    const next = this.lineIndex + 1;
    if (next >= this.lines.length) return false;
    const line = this.lines[next];
    if (next === this.lines.length - 1 && /^[ \t]*$/.test(line)) {
      // the final line is blank: the block runs to the end of the input,
      // whose trailing newline counts only at the top level
      return !this.stackHasContainer();
    }
    // Probed 16 Nov 2026 (probe76/77): a truly empty next line drops
    // the trailing newline, but a whitespace-only (non-empty) line
    // keeps it for kind <= 5 blocks (comment, PI, CDATA, declaration,
    // script/pre/style) — it falls through to the container check.
    if (line === "") return false;
    return this.nextLineMatchesContainers();
  }

  stackHasContainer() {
    for (let k = 1; k < this.stack.length; k++) {
      const t = this.stack[k].t;
      if (t === "quote" || t === "item") return true;
    }
    return false;
  }

  // Would the next line match every container the HTML block sits in?
  // (Simulates phase-1 container matching on the next line.)
  nextLineMatchesContainers() {
    const saveS = this.s;
    const saveI = this.i;
    const saveCol = this.col;
    const savePartial = this.partial;
    const saveLineIndex = this.lineIndex;
    this.lineIndex = this.lineIndex + 1;
    this.s = this.lines[this.lineIndex];
    this.i = 0;
    this.col = 0;
    this.partial = 0;
    let ok = true;
    for (let k = 1; k < this.stack.length - 1; k++) {
      const b = this.stack[k];
      if (b.t === "list") continue;
      if (b.t === "quote") {
        if (!this.tryBlockquote()) {
          ok = false;
          break;
        }
      } else if (b.t === "item") {
        if (!this.tryItem(b)) {
          ok = false;
          break;
        }
      } else break;
    }
    this.s = saveS;
    this.i = saveI;
    this.col = saveCol;
    this.partial = savePartial;
    this.lineIndex = saveLineIndex;
    return ok;
  }

  addHtmlLine(block) {
    if (block.started) block.lit += "\n";
    else block.started = true;
    block.lit += this.rest();
    block.lastTerminated = this.htmlLineTerminated(block.kind);
  }

  addTableRow(table) {
    table.rows.push(this.rest());
  }

  // --- block starts ---------------------------------------------------------
  matchAtx() {
    const save = this.saveCursor();
    this.advance(3);
    let hashes = 0;
    while (this.peek() === "#") {
      this.i++;
      this.col++;
      hashes++;
      if (hashes > 6) {
        this.restoreCursor(save);
        return null;
      }
    }
    if (hashes === 0) {
      this.restoreCursor(save);
      return null;
    }
    const after = this.peek();
    if (after !== "" && after !== " " && after !== "\t") {
      this.restoreCursor(save);
      return null;
    }
    // The heading text is the rest of the line. A closing sequence is a
    // run of "#" at the end preceded by whitespace; the whitespace may be
    // the space(s) right after the opening hashes, so check it before
    // stripping the leading whitespace ("# #" is an empty heading).
    let text = this.rest().replace(/[ \t]+$/, "");
    const m = /[ \t]+#+$/.exec(text);
    if (m) text = text.slice(0, m.index);
    text = text.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    return { t: "heading", level: hashes, text };
  }

  matchFence() {
    const save = this.saveCursor();
    const indent = this.advance(3);
    const ch = this.peek();
    if (ch !== "`" && ch !== "~") {
      this.restoreCursor(save);
      return null;
    }
    let len = 0;
    while (this.peek() === ch) {
      this.i++;
      this.col++;
      len++;
    }
    if (len < 3) {
      this.restoreCursor(save);
      return null;
    }
    const info = this.rest();
    if (ch === "`" && info.indexOf("`") >= 0) {
      this.restoreCursor(save);
      return null;
    }
    return {
      t: "code", fenced: true, fenceChar: ch, fenceLen: len,
      fenceIndent: indent, info: info.replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""),
      lit: "", started: false,
    };
  }

  isClosingFence(tip) {
    const save = this.saveCursor();
    this.advance(3);
    let len = 0;
    while (this.peek() === tip.fenceChar) {
      this.i++;
      this.col++;
      len++;
    }
    const ok = len >= tip.fenceLen && this.isBlankFromCursor();
    if (!ok) this.restoreCursor(save);
    return ok;
  }

  matchHtmlBlock() {
    const save = this.saveCursor();
    this.advance(3);
    if (this.peek() !== "<") {
      this.restoreCursor(save);
      return null;
    }
    const rest = this.s.slice(this.i);
    const lower = rest.toLowerCase();
    let kind = 0;
    let endTag = null;
    if (/^<(script|pre|style|textarea)([\s>]|$)/.test(lower)) {
      kind = 1;
      endTag = lower.match(/^<(\w+)/)[1];
    } else if (rest.startsWith("<!--")) {
      kind = 2;
      endTag = "-->";
    } else if (rest.startsWith("<?")) {
      kind = 3;
      endTag = "?>";
    } else if (/^<![a-zA-Z]/.test(rest)) {
      kind = 4;
      endTag = ">";
    } else if (rest.startsWith("<![CDATA[")) {
      kind = 5;
      endTag = "]]>";
    } else {
      // Type 6: an open or close tag of a block tag. Only the tag name
      // matters; the tag need not be complete on this line (it may span
      // lines or never close). Type 7: a complete tag alone on the line.
      const name = this.tagNameAtCursor();
      if (name !== null && BLOCK_TAGS.has(name)) {
        kind = 6;
      } else {
        const tag = this.parseTagAtCursor();
        if (tag && tag.complete) {
          kind = 7;
        } else {
          this.restoreCursor(save);
          return null;
        }
      }
    }
    // Note: a type-7 block cannot interrupt a paragraph; that is the
    // caller's job (processFresh suppresses it, the lazy branch in
    // processLine handles it specially).
    // The literal is the whole line from after the container prefixes,
    // including up to three spaces of indent.
    this.restoreCursor(save);
    const node = { t: "html", kind, endTag, lit: this.rest(), started: true };
    node.lastTerminated = this.htmlLineTerminated(kind);
    return node;
  }

  // The tag name at the cursor ("<" ["/"] letter (letter|digit|"-")*),
  // followed by a space, tab, ">", "/", or end of line. Null if the line
  // does not start with a tag.
  tagNameAtCursor() {
    const s = this.s;
    let j = this.i;
    if (s[j] !== "<") return null;
    j++;
    if (s[j] === "/") j++;
    if (j >= s.length || !/[a-zA-Z]/.test(s[j])) return null;
    const start = j;
    j++;
    while (j < s.length && /[a-zA-Z0-9-]/.test(s[j])) j++;
    const name = s.slice(start, j).toLowerCase();
    const after = j >= s.length ? "" : s[j];
    if (after !== "" && after !== " " && after !== "\t" && after !== ">" && after !== "/") {
      return null;
    }
    return name;
  }

  // Parse an open or close tag at the cursor. Returns
  // {name, complete} where complete means the tag ends and only whitespace
  // follows on the line. Returns null if there is no tag here.
  parseTagAtCursor() {
    const s = this.s;
    const n = s.length;
    let j = this.i;
    if (s[j] !== "<") return null;
    j++;
    let isClose = false;
    if (s[j] === "/") {
      isClose = true;
      j++;
    }
    const nameStart = j;
    if (j >= n || !/[a-zA-Z]/.test(s[j])) return null;
    j++;
    while (j < n && /[a-zA-Z0-9-]/.test(s[j])) j++;
    const name = s.slice(nameStart, j).toLowerCase();
    if (isClose) {
      // a closing tag takes no attributes: only whitespace, then ">"
      let k = j;
      while (k < n && (s[k] === " " || s[k] === "\t" || s[k] === "\n")) k++;
      if (k < n && s[k] === ">") {
        return { name, complete: this.isBlankFromIndex(k + 1) };
      }
      return null;
    }
    while (true) {
      let k = j;
      while (k < n && (s[k] === " " || s[k] === "\t" || s[k] === "\n")) k++;
      if (k < n && s[k] === ">") {
        return { name, complete: this.isBlankFromIndex(k + 1) };
      }
      if (k < n && s[k] === "/" && k + 1 < n && s[k + 1] === ">") {
        return { name, complete: this.isBlankFromIndex(k + 2) };
      }
      if (k === j) return null;
      j = k;
      if (j >= n || !/[a-zA-Z_:]/.test(s[j])) return null;
      j++;
      while (j < n && /[a-zA-Z0-9_.:-]/.test(s[j])) j++;
      let v = j;
      while (v < n && (s[v] === " " || s[v] === "\t")) v++;
      if (v < n && s[v] === "=") {
        v++;
        while (v < n && (s[v] === " " || s[v] === "\t")) v++;
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
        }
        j = v;
      }
      if (j >= n) return null;
    }
  }

  isBlankFromIndex(idx) {
    for (let k = idx; k < this.s.length; k++) {
      const ch = this.s[k];
      if (ch !== " " && ch !== "\t") return false;
    }
    return true;
  }

  htmlEndOnLine(block) {
    if (block.kind === 1) {
      return this.s.toLowerCase().includes("</" + block.endTag);
    }
    return this.s.includes(block.endTag);
  }

  isThematicBreak() {
    const save = this.saveCursor();
    this.advance(3);
    const ch = this.peek();
    if (ch !== "*" && ch !== "-" && ch !== "_") {
      this.restoreCursor(save);
      return false;
    }
    let count = 0;
    while (true) {
      const p = this.peek();
      if (p === ch) {
        this.i++;
        this.col++;
        count++;
      } else if (p === " " || p === "\t") {
        this.advance(1);
      } else break;
    }
    const ok = count >= 3 && this.isBlankFromCursor();
    if (!ok) this.restoreCursor(save);
    return ok;
  }

  isSetextLine() {
    const save = this.saveCursor();
    this.advance(3);
    const ch = this.peek();
    if (ch !== "=" && ch !== "-") {
      this.restoreCursor(save);
      return 0;
    }
    while (this.peek() === ch) {
      this.i++;
      this.col++;
    }
    if (this.isBlankFromCursor()) {
      this.restoreCursor(save);
      return ch === "=" ? 1 : 2;
    }
    this.restoreCursor(save);
    return 0;
  }

  convertSetext(level) {
    const para = this.tip();
    // a heading's content has leading and trailing whitespace stripped
    const text = para.lines
      .join("\n")
      .replace(/^[ \t]+/, "")
      .replace(/[ \t]+$/, "");
    const heading = { t: "heading", level, text };
    const parent = this.stack[this.stack.length - 2];
    const at = parent.children.indexOf(para);
    parent.children[at] = heading;
    this.stack.pop();
  }

  isTableDelimiter() {
    const tip = this.tip();
    if (tip.t !== "para" || tip.lines.length === 0) return false;
    if (this.indentAtCursor() >= 4) return false;
    const headerCells = splitTableRow(tip.lines[tip.lines.length - 1]);
    const save = this.saveCursor();
    this.advance(3);
    const delimCells = splitTableRow(this.rest());
    this.restoreCursor(save);
    if (delimCells.length !== headerCells.length) return false;
    for (const cell of delimCells) {
      if (!/^:?-+:?$/.test(cell)) return false;
    }
    return true;
  }

  convertTable() {
    const para = this.tip();
    const headerLine = para.lines[para.lines.length - 1];
    const headerCells = splitTableRow(headerLine);
    const delimCells = splitTableRow(this.rest());
    const align = delimCells.map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return null;
    });
    const table = {
      t: "table", header: headerCells, align, rows: [],
    };
    const parent = this.stack[this.stack.length - 2];
    const at = parent.children.indexOf(para);
    if (para.lines.length > 1) {
      para.lines = para.lines.slice(0, -1);
      parent.children.splice(at + 1, 0, table);
    } else {
      parent.children[at] = table;
    }
    this.stack.pop();
    this.stack.push(table);
  }

  // Does the line at the cursor start a block that ends a table?
  lineStartsNewBlock() {
    const save = this.saveCursor();
    // a whitespace-only line starts no block (not even indented code,
    // which needs content); this matters for table rows, where a lone
    // tab (4 columns) is an empty row rather than a new block
    if (this.isBlankFromCursor()) {
      this.restoreCursor(save);
      return false;
    }
    if (this.matchAtx() || this.matchFence() || this.matchHtmlBlock()) {
      this.restoreCursor(save);
      return true;
    }
    if (this.isThematicBreak()) {
      this.restoreCursor(save);
      return true;
    }
    const item = this.matchListItem();
    if (item) {
      this.restoreCursor(save);
      return true;
    }
    if (this.matchBlockquoteStart()) {
      this.restoreCursor(save);
      return true;
    }
    if (this.indentAtCursor() >= 4) {
      this.restoreCursor(save);
      return true;
    }
    this.restoreCursor(save);
    return false;
  }

  matchListItem() {
    const save = this.saveCursor();
    // the marker and content columns are relative to the cursor position
    // after the enclosing containers: the same containers can consume a
    // different number of columns on different lines (e.g. ">>" vs
    // "> > "), so absolute columns do not compare across lines. The
    // cursor is already past the indents of the open items, so those
    // are subtracted back out.
    const baseCol = this.col - this.itemIndentConsumed;
    this.advance(3);
    const markerCol = this.col;
    const ch = this.peek();
    let bullet = null;
    let ordered = false;
    let start = 0;
    let delim = "";
    let width = 0;
    if (ch === "-" || ch === "+" || ch === "*") {
      bullet = ch;
      width = 1;
      this.i++;
      this.col++;
    } else if (ch >= "0" && ch <= "9") {
      let num = 0;
      let digits = 0;
      let j = this.i;
      while (j < this.s.length && this.s[j] >= "0" && this.s[j] <= "9") {
        if (digits >= 9) {
          this.restoreCursor(save);
          return null;
        }
        num = num * 10 + (this.s.charCodeAt(j) - 48);
        digits++;
        j++;
      }
      if (digits === 0) {
        this.restoreCursor(save);
        return null;
      }
      const d = this.s[j];
      if (d !== "." && d !== ")") {
        this.restoreCursor(save);
        return null;
      }
      ordered = true;
      start = num;
      delim = d;
      width = digits + 1;
      this.i = j + 1;
      this.col += digits + 1;
    } else {
      this.restoreCursor(save);
      return null;
    }
    const after = this.peek();
    if (after !== "" && after !== " " && after !== "\t") {
      this.restoreCursor(save);
      return null;
    }
    const afterMarker = this.saveCursor();
    let spaces = 0;
    while (this.peek() === " " || this.peek() === "\t") {
      this.advance(1);
      spaces++;
    }
    const blank = this.peek() === "";
    let contentIndent;
    if (blank) {
      contentIndent = markerCol + width + 1;
    } else if (spaces >= 1 && spaces <= 4) {
      contentIndent = markerCol + width + spaces;
    } else {
      contentIndent = markerCol + width + 1;
      this.restoreCursor(afterMarker);
      this.advance(1);
    }
    return {
      bullet, ordered, start, delim,
      markerCol, width, contentIndent,
      // the cursor after the enclosing containers, for the relative
      // content indent used when the item is matched on later lines
      baseCol,
      blank, cursor: this.saveCursor(),
    };
  }

  // The new item is a sibling of the deepest open item whose content
  // indent is greater than the marker column, and nested inside any item
  // whose content indent is less than or equal to it.
  startListItem(item) {
    this.closeLeaf();
    while (true) {
      const tip = this.tip();
      if (tip.t === "item") {
        if (item.markerCol >= tip.contentIndent) break;
        this.closeTip();
        continue;
      }
      if (tip.t === "list") {
        if (this.listMatches(tip, item)) {
          this.addItemToList(tip, item);
          return;
        }
        this.closeTip();
        continue;
      }
      break;
    }
    const list = {
      t: "list", ordered: item.ordered, start: item.start,
      delim: item.delim, bullet: item.bullet, tight: true, children: [],
    };
    this.addNode(list);
    this.stack.push(list);
    this.addItemToList(list, item);
  }

  listMatches(list, item) {
    return (
      (item.ordered && list.ordered && list.delim === item.delim) ||
      (!item.ordered && !list.ordered && list.bullet === item.bullet)
    );
  }

  addItemToList(list, item) {
    const itemNode = {
      t: "item", contentIndent: item.contentIndent, baseCol: item.baseCol,
      checked: null, children: [],
    };
    list.children.push(itemNode);
    this.stack.push(itemNode);
    // the marker and its following spaces are consumed on this line,
    // so a nested item matched later on the same line measures its
    // columns from the same base
    this.itemIndentConsumed += item.contentIndent - item.baseCol;
    // task list marker: [ ], [x], [X] followed by space/tab/EOL
    const rest = this.rest();
    if (
      rest.length >= 3 && rest[0] === "[" && rest[2] === "]" &&
      (rest[1] === " " || rest[1] === "x" || rest[1] === "X")
    ) {
      const after = rest.length === 3 ? "" : rest[3];
      if (after === "" || after === " " || after === "\t") {
        itemNode.checked = rest[1] !== " ";
        this.i += 3;
        this.col += 3;
        if (after === " " || after === "\t") this.advance(1);
      }
    }
  }

  matchBlockquoteStart() {
    const save = this.saveCursor();
    this.advance(3);
    if (this.peek() === ">") {
      this.i++;
      this.col++;
      const p = this.peek();
      if (p === " " || p === "\t") this.advance(1);
      return true;
    }
    this.restoreCursor(save);
    return false;
  }

  // --- link reference definitions -------------------------------------------
  tryParseRefDef(lines, startIdx) {
    let li = startIdx;
    let line = lines[li];
    let pos = 0;
    let col = 0;
    // indent before the label: at most 3 columns
    while (pos < line.length) {
      const ch = line[pos];
      if (ch === " ") {
        col++;
        pos++;
        if (col > 3) return null;
      } else if (ch === "\t") {
        col += 4 - (col % 4);
        pos++;
        if (col > 3) return null;
      } else break;
    }
    if (line[pos] !== "[") return null;
    // label: may span lines; newlines inside it count as spaces.
    // A label must not contain an unescaped "[". Escapes are kept
    // raw: labels are matched on their raw text.
    let label = "";
    pos++;
    let closed = false;
    let curLi = li;
    let curLine = line;
    let j = pos;
    while (true) {
      if (j >= curLine.length) {
        if (curLi + 1 >= lines.length) break;
        label += "\n";
        curLi++;
        curLine = lines[curLi];
        j = 0;
        continue;
      }
      const ch = curLine[j];
      if (ch === "\\" && j + 1 < curLine.length && isAsciiPunctChar(curLine[j + 1])) {
        label += ch + curLine[j + 1];
        j += 2;
        continue;
      }
      if (ch === "[") return null;
      if (ch === "]") {
        closed = true;
        j++;
        break;
      }
      label += ch;
      j++;
    }
    if (!closed || normalizeLabel(label) === "") return null;
    li = curLi;
    line = curLine;
    pos = j;
    if (line[pos] !== ":") return null;
    pos++;
    // Skip whitespace, possibly onto a following line. The destination
    // and the title may be indented by any amount on a following line.
    // Returns 1 if a non-space character was found, 0 if the paragraph's
    // lines are exhausted.
    const skipWs = () => {
      while (true) {
        while (pos < line.length && (line[pos] === " " || line[pos] === "\t")) pos++;
        if (pos < line.length) return 1;
        if (li + 1 >= lines.length) return 0;
        li++;
        line = lines[li];
        pos = 0;
      }
    };
    if (skipWs() === 0) return null; // no destination
    // destination
    let href = "";
    if (line[pos] === "<") {
      pos++;
      let ok = false;
      while (pos < line.length) {
        const ch = line[pos];
        if (ch === "<") return null;
        if (ch === ">") {
          ok = true;
          pos++;
          break;
        }
        if (ch === "\\" && pos + 1 < line.length && isAsciiPunctChar(line[pos + 1])) {
          href += line[pos + 1];
          pos += 2;
          continue;
        }
        href += ch;
        pos++;
      }
      if (!ok) return null;
    } else {
      let depth2 = 0;
      const start = pos;
      while (pos < line.length) {
        const ch = line[pos];
        if (ch === " " || ch === "\t") break;
        if (ch === "\\" && pos + 1 < line.length && isAsciiPunctChar(line[pos + 1])) {
          href += line[pos + 1];
          pos += 2;
          continue;
        }
        if (ch === "(") {
          depth2++;
          href += ch;
          pos++;
          continue;
        }
        if (ch === ")") {
          if (depth2 === 0) break;
          depth2--;
          href += ch;
          pos++;
          continue;
        }
        href += ch;
        pos++;
      }
      if (pos === start) return null;
    }
    // Optional title. It must be preceded by whitespace (a space, tab, or
    // newline) and may sit on the same line or the next one; it may span
    // lines. A following line that is not a title simply ends the def.
    let title = null;
    const afterDestLi = li;
    const afterDestPos = pos;
    // a title right after the destination, with no whitespace, is junk
    if (line[pos] === '"' || line[pos] === "'" || line[pos] === "(") return null;
    if (skipWs() === 1) {
      const ch = line[pos];
      if (ch === '"' || ch === "'" || ch === "(") {
        const titleStartLi = li;
        const res = this.parseRefTitle(lines, li, pos);
        if (!res) {
          // a title that never closes: backtrack to the dest-only def
          // when the title started on a later line than the destination
          if (titleStartLi !== afterDestLi) {
            return { label, href, title: null, nextLine: afterDestLi + 1 };
          }
          return null;
        }
        title = res.title;
        li = res.li;
        line = lines[li];
        pos = res.pos;
        // after the title only whitespace may follow on the same line
        let p = pos;
        while (p < line.length && (line[p] === " " || line[p] === "\t")) p++;
        if (p < line.length) {
          // junk after the title: backtrack to the dest-only def when
          // the title started on a later line than the destination
          if (titleStartLi !== afterDestLi) {
            return { label, href, title: null, nextLine: afterDestLi + 1 };
          }
          return null;
        }
      } else if (li !== afterDestLi) {
        // the next line is not a title: the def ends at the destination
        li = afterDestLi;
        line = lines[li];
        pos = afterDestPos;
      } else {
        return null; // junk on the same line after the destination
      }
    }
    return { label, href, title, nextLine: li + 1 };
  }

  // Parse a link title starting at (li, pos) on the given lines. The
  // title may span lines. Returns {title, li, pos} (pos just after the
  // closing quote) or null.
  parseRefTitle(lines, li, pos) {
    const q = lines[li][pos];
    const closeQ = q === "(" ? ")" : q;
    let t = "";
    let j = pos + 1;
    let curLi = li;
    let curLine = lines[curLi];
    while (true) {
      if (j >= curLine.length) {
        if (curLi + 1 >= lines.length) return null;
        t += "\n";
        curLi++;
        curLine = lines[curLi];
        j = 0;
        continue;
      }
      const ch = curLine[j];
      if (ch === closeQ) {
        return { title: t, li: curLi, pos: j + 1 };
      }
      if (ch === "\\" && j + 1 < curLine.length && isAsciiPunctChar(curLine[j + 1])) {
        t += curLine[j + 1];
        j += 2;
        continue;
      }
      t += ch;
      j++;
    }
  }

}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(nodes, refs, out, tight) {
  for (const node of nodes) renderBlock(node, refs, out, tight);
}

function renderBlock(node, refs, out, tight) {
  switch (node.t) {
    case "para": {
      const text = node.lines.join("\n");
      if (tight) {
        out.push(inlineHtml(text, refs));
      } else {
        out.push("<p>", inlineHtml(text, refs), "</p>\n");
      }
      break;
    }
    case "heading": {
      out.push(
        "<h", String(node.level), ">",
        inlineHtml(node.text, refs),
        "</h", String(node.level), ">\n",
      );
      break;
    }
    case "code": {
      if (node.fenced) {
        const lang = fencedLanguage(node.info);
        out.push(
          "<pre><code",
          lang ? ' class="language-' + escAttr(lang) + '"' : "",
          ">", escAll(node.lit),
          node.lastTerminated ? "\n" : "",
          "</code></pre>\n",
        );
      } else {
        out.push(
          "<pre><code>", escAll(node.lit),
          node.lastTerminated ? "\n" : "",
          "</code></pre>\n",
        );
      }
      break;
    }
    case "html": {
      out.push(node.lit);
      if (node.lastTerminated) out.push("\n");
      break;
    }
    case "hr": {
      out.push("<hr>\n");
      break;
    }
    case "quote": {
      out.push("<blockquote>\n");
      renderBlocks(node.children, refs, out, false);
      out.push("</blockquote>\n");
      break;
    }
    case "list": {
      if (node.ordered) {
        out.push(node.start !== 1 ? `<ol start="${node.start}">\n` : "<ol>\n");
      } else {
        out.push("<ul>\n");
      }
      renderBlocks(node.children, refs, out, node.tight);
      out.push(node.ordered ? "</ol>\n" : "</ul>\n");
      break;
    }
    case "item": {
      out.push("<li>");
      const checkbox =
        node.checked === null
          ? null
          : node.checked
            ? '<input checked="" disabled="" type="checkbox"> '
            : '<input disabled="" type="checkbox"> ';
      if (
        checkbox !== null &&
        !tight &&
        node.children.length > 0 &&
        node.children[0].t === "para"
      ) {
        // in a loose list the checkbox sits inside the first <p>
        const first = node.children[0];
        out.push("<p>", checkbox, inlineHtml(first.lines.join("\n"), refs), "</p>\n");
        for (let k = 1; k < node.children.length; k++) {
          renderBlock(node.children[k], refs, out, tight);
        }
      } else {
        if (checkbox !== null) out.push(checkbox);
        renderBlocks(node.children, refs, out, tight);
      }
      out.push("</li>\n");
      break;
    }
    case "table": {
      out.push("<table>\n<thead>\n<tr>\n");
      for (let k = 0; k < node.header.length; k++) {
        const a = node.align[k];
        out.push("<th", a ? ` align="${a}"` : "", ">", inlineHtml(node.header[k], refs), "</th>\n");
      }
      out.push("</tr>\n</thead>\n");
      if (node.rows.length > 0) {
        out.push("<tbody>");
        for (const row of node.rows) {
          const cells = splitTableRow(row);
          out.push("<tr>\n");
          for (let k = 0; k < node.header.length; k++) {
            const a = node.align[k];
            const cell = k < cells.length ? cells[k] : "";
            out.push("<td", a ? ` align="${a}"` : "", ">", inlineHtml(cell, refs), "</td>\n");
          }
          out.push("</tr>\n");
        }
        out.push("</tbody>");
      }
      out.push("</table>\n");
      break;
    }
    default:
      break;
  }
}

// The language of a fenced code block: the first word of the info string,
// with backslash escapes processed.
function fencedLanguage(info) {
  let end = 0;
  while (end < info.length && info[end] !== " " && info[end] !== "\t") end++;
  const word = info.slice(0, end);
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === "\\" && i + 1 < word.length && isAsciiPunctChar(word[i + 1])) {
      out += word[i + 1];
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

export function parse(markdown) {
  inLink = false;
  const parser = new BlockParser(markdown);
  const doc = parser.parse();
  const out = [];
  renderBlocks(doc.children, parser.refs, out, false);
  return out.join("");
}
