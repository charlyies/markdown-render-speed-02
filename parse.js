// parse.js — a from-scratch CommonMark 0.31.2 + GFM 0.29 markdown parser.
//
// Written for the make.fun markdown-render-speed-02 competition. It renders
// exactly the HTML that marked 18.1.3 produces with its default options
// (gfm on, breaks off, pedantic off, async off), dependency-free.
//
// Layout: src/text.js holds the character and escaping primitives,
// src/inline.js the inline scanner, link resolution and emphasis pass,
// src/blocks.js the line-based block parser and the block renderer.
// This file only wires them together: build the block tree, render it.
//
// Design: the block layer builds a small AST from lines (container aware,
// tab aware); the inline layer turns each block's raw text into HTML with
// a delimiter-stack emphasis algorithm and CommonMark link resolution.
// No input is ever special-cased: everything is computed from the markdown.

import { DocParser, renderNodes } from "./src/blocks.js";
import { resetAnchorTracking } from "./src/inline.js";

export function parse(markdown) {
  resetAnchorTracking();
  const builder = new DocParser(markdown);
  const doc = builder.run();
  const out = [];
  renderNodes(doc.children, builder.definitions, out, false);
  return out.join("");
}
