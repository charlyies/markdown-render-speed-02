// src/text.js — character classification, escaping and small text codecs
// shared by the inline scanner and the block builder.
//
// Nothing here knows about markdown structure: these are the primitives
// both layers build on. Escaping follows marked 18.1.3: attribute text
// keeps well-formed entity references intact, code text escapes every
// "&", and URLs go through encodeURI before attribute escaping.

export const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Escape < > " ' and & — but leave a well-formed reference alone, so
// "&copy;" and "&#169;" survive while a bare "&" becomes "&amp;".
const ATTR_ESC_RE = /[<>\"']|&(?!(?:[A-Za-z0-9]+|#\d+|#[xX][0-9a-fA-F]+);)/g;
export function escapeAttr(value) {
  return value.replace(ATTR_ESC_RE, (ch) => HTML_ESCAPES[ch]);
}

// Escape everything, including &. Used for code spans and code blocks,
// where no entity decoding happens at all.
const RAW_ESC_RE = /[&<>\"']/g;
export function escapeRaw(value) {
  return value.replace(RAW_ESC_RE, (ch) => HTML_ESCAPES[ch]);
}

// ASCII punctuation lookup, indexed by code unit, built once at load.
export const ASCII_PUNCT_BITS = new Uint8Array(128);
for (const ch of "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~") {
  ASCII_PUNCT_BITS[ch.charCodeAt(0)] = 1;
}

// A Unicode punctuation character is an ASCII punctuation character or
// one in the Unicode P (punctuation) or S (symbol) general categories.
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
export function isPunctChar(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return ASCII_PUNCT_BITS[code] === 1;
  return UNICODE_PUNCT_RE.test(ch);
}

export function isSpaceChar(ch) {
  return (
    ch === " " || ch === "\t" || ch === "\n" || ch === "\r" ||
    ch === "\f" || ch === "\v"
  );
}

// CommonMark's Unicode whitespace: the ASCII whitespace characters plus
// the Unicode space separators.
export function isUnicodeSpaceChar(ch) {
  if (
    ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f"
  ) {
    return true;
  }
  const code = ch.charCodeAt(0);
  return (
    code === 0x00a0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f ||
    code === 0x205f || code === 0x3000
  );
}

export function isDigitChar(ch) {
  return ch >= "0" && ch <= "9";
}

export function isAlnumChar(ch) {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

// Encode a URL the way marked does: encodeURI, then attribute-escape it.
// A "%" that encodeURI produced from an original "%" is put back.
export function sanitizeHref(href) {
  let cleaned;
  try {
    cleaned = encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
  return escapeAttr(cleaned);
}

// Normalize a link label: trim, collapse every whitespace run to a single
// space, case-fold. The folding is Unicode folding, not plain lowercasing:
// sharp s folds to "ss" and the Greek final sigma folds to sigma.
export function foldLinkLabel(label) {
  return label
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ẞ/g, "ss")
    .replace(/ς/g, "σ");
}

// Decode one numeric character reference. `body` is the text after "&#"
// (for example "65", "x41" or "X1F600"). Returns the decoded string, or
// null when the reference is malformed (wrong digit count, empty, or a
// stray ";"). Zero, surrogates and values above the Unicode range decode
// to the replacement character, as marked does.
export function decodeNumericEntity(body) {
  let value = 0;
  if (body.charCodeAt(0) === 120 || body.charCodeAt(0) === 88) {
    // Hexadecimal: between 1 and 6 digits after the "x".
    const digits = body.slice(1);
    if (digits.length < 1 || digits.length > 6) return null;
    for (let k = 0; k < digits.length; k++) {
      const c = digits.charCodeAt(k);
      let d;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (c >= 65 && c <= 70) d = c - 55;
      else if (c >= 97 && c <= 102) d = c - 87;
      else return null;
      value = value * 16 + d;
    }
  } else {
    // Decimal: between 1 and 7 digits.
    if (body.length < 1 || body.length > 7) return null;
    for (let k = 0; k < body.length; k++) {
      const c = body.charCodeAt(k);
      if (c < 48 || c > 57) return null;
      value = value * 10 + (c - 48);
    }
  }
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return "�";
  }
  return String.fromCodePoint(value);
}
