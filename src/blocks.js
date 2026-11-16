// src/blocks.js — block parsing and block rendering.
//
// Line-based, container aware, tab aware. Each line is processed with a
// cursor (index, visual column, partially-consumed tab remainder) so tabs
// expand the way CommonMark requires, including tabs that are only partly
// consumed by an indent. The open blocks live on a stack; every line first
// matches the open containers, then either continues the open leaf or
// starts new blocks.
//
// The parser builds a small tree; renderNodes walks it to HTML. Link
// reference definitions are pulled out of paragraphs as they close, and
// the inline layer (src/inline.js) resolves them when it renders.

import {
  ASCII_PUNCT_BITS,
  escapeAttr,
  escapeRaw,
  foldLinkLabel,
} from "./text.js";
import { inlineToHtml } from "./inline.js";

const BLOCK_TAG_NAMES = new Set([
  "address", "article", "aside", "base", "basefont", "blockquote", "body",
  "caption", "center", "col", "colgroup", "dd", "details", "dialog", "dir",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header",
  "hr", "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem",
  "nav", "noframes", "ol", "optgroup", "option", "p", "param", "search",
  "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
  "title", "tr", "track", "ul",
]);

function isLeafKind(t) {
  return (
    t === "para" || t === "heading" || t === "code" || t === "html" ||
    t === "hr" || t === "table"
  );
}

function isAsciiPunct(c) {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return code < 128 && ASCII_PUNCT_BITS[code] === 1;
}

// Split a table row line into cells: split on unescaped "|", trim cells,
// drop an empty first/last cell (from a leading/trailing pipe). An
// escaped "\|" does not split and becomes a literal "|" in the cell text
// (so it renders as "|" even inside a code span); other escapes are kept
// for the inline parser.
export function splitRowCells(line) {
  const cells = [];
  let cur = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === "\\" && i + 1 < n && isAsciiPunct(line[i + 1])) {
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

export class DocParser {
  constructor(input) {
    this.source = input.replace(/\r\n?/g, "\n");
    this.lines = this.source.split("\n");
    this.definitions = new Map();
    this.tree = { t: "doc", children: [] };
    this.open = [this.tree];
    this.line = "";
    this.idx = 0;
    this.col = 0;
    this.tabLeft = 0;
  }

  top() {
    return this.open[this.open.length - 1];
  }

  // --- line cursor -------------------------------------------------------
  savePos() {
    return { i: this.idx, col: this.col, partial: this.tabLeft };
  }
  restorePos(c) {
    this.idx = c.i;
    this.col = c.col;
    this.tabLeft = c.partial;
  }
  peekChar() {
    if (this.tabLeft > 0) return " ";
    return this.idx < this.line.length ? this.line[this.idx] : "";
  }
  // Advance up to n columns of whitespace; returns columns advanced.
  skipSpace(n) {
    let adv = 0;
    while (adv < n) {
      if (this.tabLeft > 0) {
        const take = Math.min(this.tabLeft, n - adv);
        this.tabLeft -= take;
        this.col += take;
        adv += take;
        continue;
      }
      if (this.idx >= this.line.length) break;
      const ch = this.line[this.idx];
      if (ch === " ") {
        this.idx++;
        this.col++;
        adv++;
      } else if (ch === "\t") {
        const w = 4 - (this.col % 4);
        const take = Math.min(w, n - adv);
        this.idx++;
        this.col += take;
        adv += take;
        if (take < w) this.tabLeft = w - take;
      } else break;
    }
    return adv;
  }
  remainder() {
    return (this.tabLeft > 0 ? " ".repeat(this.tabLeft) : "") + this.line.slice(this.idx);
  }
  blankAhead() {
    let i = this.idx;
    while (i < this.line.length) {
      const ch = this.line[i];
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
  isBlank(failedContainer) {
    const rest = this.remainder();
    if (rest === "") return true;
    if (!/^[ \t]*$/.test(rest)) return false;
    if (failedContainer) return true;
    if (this.top().t !== "para") return true;
    let inQuote = false;
    for (let k = 1; k < this.open.length; k++) {
      if (this.open[k].t === "item") return true;
      if (this.open[k].t === "quote") inQuote = true;
    }
    if (inQuote) {
      if (this.lineNo + 1 >= this.lines.length) return false;
      return this.nextLineFits();
    }
    return this.lineNo !== this.lines.length - 1;
  }
  indentAhead() {
    const save = this.savePos();
    const n = this.skipSpace(1000000);
    this.restorePos(save);
    return n;
  }

  // --- main loop ---------------------------------------------------------
  run() {
    for (let li = 0; li < this.lines.length; li++) {
      this.lineNo = li;
      this.line = this.lines[li];
      this.idx = 0;
      this.col = 0;
      this.tabLeft = 0;
      // Columns consumed by phase-1 list-item matching on this line;
      // list-item indents are relative to the cursor after the enclosing
      // blockquotes, so a new item's columns are measured from the
      // cursor minus what the open items already consumed.
      this.itemIndentUsed = 0;
      // Absolute column where the innermost list item matched on this
      // line starts its content (0 if none matched yet); a tab after a
      // ">" inside that item expands on the grid anchored there
      // (doc-30, probed 16 Nov 2026).
      this.itemContentAt = 0;
      this.handleLine();
    }
    while (this.open.length > 1) {
      const block = this.top();
      if (block.t === "html") {
        // At the end of the input inside a container, an HTML block has
        // no trailing newline (the container's inner source ends without
        // one); at the top level the input's own trailing newline counts.
        for (let k = 1; k < this.open.length - 1; k++) {
          const t = this.open[k].t;
          if (t === "quote" || t === "item") {
            block.lastTerminated = false;
            break;
          }
        }
      }
      this.popBlock();
    }
    return this.tree;
  }

  handleLine() {
    // Phase 1: match the open containers, outermost first. Lists always
    // match (they consume no columns); quotes and items are matched
    // against the line; a leaf ends the container run.
    let containerIdx = 1;
    while (containerIdx < this.open.length) {
      const b = this.open[containerIdx];
      if (b.t === "list") {
        containerIdx++;
        continue;
      }
      if (b.t !== "quote" && b.t !== "item") break;
      if (b.t === "quote") {
        if (!this.matchQuote()) break;
      } else {
        const beforeCol = this.col;
        if (!this.matchItem(b)) break;
        this.itemIndentUsed += this.col - beforeCol;
        this.itemContentAt = this.col;
      }
      containerIdx++;
    }
    const failedContainer =
      containerIdx < this.open.length &&
      (this.open[containerIdx].t === "quote" || this.open[containerIdx].t === "item");
    // The innermost container this line matched: a blank line only
    // marks that container (and its descendants) as ending blank, not
    // the ancestors above it (a blank line inside a quote or sublist
    // does not loosen the enclosing list).
    this.blankScope = this.open[containerIdx - 1];
    const blank = this.isBlank(failedContainer);
    if (failedContainer && !blank) {
      const tip = this.top();
      if (tip.t === "code" && tip.fenced) {
        // A fenced code block's lines are literal: they do not need to
        // match a list item's indent. But a line that fails to match a
        // blockquote is outside the quote, so the block inside it ends.
        // Probed 16 Nov 2026 (probe72): the list-item leniency only
        // applies once the block already has a non-blank content line;
        // an empty block ends on the first non-matching line instead
        // (the line becomes a new block outside, and a fence line
        // opens a new code block).
        const failed = this.open[containerIdx];
        // The leniency only applies when every failed container is a
        // list item: if any failed container is a blockquote, the line
        // is outside the quote and the block ends (doc-36: the line
        // fails an outer item AND the inner quote; the quote failure
        // wins). containerIdx is the outermost failure, so scan the
        // whole failed range up to the tip.
        let failedQuote = false;
        for (let k = containerIdx; k < this.open.length - 1; k++) {
          if (this.open[k].t === "quote") {
            failedQuote = true;
            break;
          }
        }
        if (failed && failed.t === "item" && !failedQuote && /[^\n]/.test(tip.lit)) {
          if (this.isFenceClose(tip)) {
            this.popBlock();
            return;
          }
          this.appendCodeLine(tip);
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
        const html = this.matchHtmlChunk();
        if (html && html.kind === 7) {
          this.popBlock();
          this.attachNode(html);
          this.open.push(html);
          return;
        }
        if (!html && !this.startsAnyBlock()) {
          const parent = this.open[this.open.length - 2];
          if (this.isTableRule() && parent.t === "item") {
            this.makeTable();
            return;
          }
          const para = this.top();
          // A lazy "=" setext line inside a blockquote, following another
          // lazy line, is padded to four spaces (marked's blockquote
          // setext fixup: "\n {0,3}(=+...)" -> "\n    $1").
          if (/^[ \t]*=+[ \t]*$/.test(this.remainder()) && para.hasLazyLine && parent.t === "quote") {
            para.lines.push("    " + this.remainder().trimStart());
            return;
          }
          // A lazy line indented by 4 or more columns loses 4 columns.
          if (this.indentAhead() >= 4) this.skipSpace(4);
          para.hasLazyLine = true;
          this.appendParaLine();
          return;
        }
        // Otherwise fall through: close the unmatched containers.
      } else if (tip.t === "table") {
        // Lazy table row: a row line that starts no block joins the table
        // even though it does not match the table's containers.
        if (!this.startsNewBlock()) {
          this.appendTableRow(tip);
          return;
        }
      }
    }
    if (failedContainer) {
      // An HTML block closed by a container failure has no trailing
      // newline.
      for (let k = containerIdx; k < this.open.length; k++) {
        if (this.open[k].t === "html") this.open[k].lastTerminated = false;
      }
      this.closeDownTo(containerIdx);
    }
    // A non-blank line ends the blank run for every block it belongs
    // to: a blank line only loosens a list when no content follows it
    // inside the same item.
    if (!blank) {
      for (const b of this.open) b.lastLineBlank = false;
    }
    this.handleFresh();
  }

  // Does the line at the cursor start any block (ATX, fence, HTML block of
  // any type, thematic break, list item, blockquote)?
  startsAnyBlock() {
    const save = this.savePos();
    if (this.matchHeading() || this.matchFenceBlock() || this.matchHtmlChunk()) {
      this.restorePos(save);
      return true;
    }
    if (this.isRule()) {
      this.restorePos(save);
      return true;
    }
    if (this.matchItemMarker()) {
      this.restorePos(save);
      return true;
    }
    if (this.matchQuoteStart()) {
      this.restorePos(save);
      return true;
    }
    this.restorePos(save);
    return false;
  }

  closeDownTo(idx) {
    while (this.open.length > idx) this.popBlock();
  }

  popBlock() {
    const block = this.open.pop();
    this.finishBlock(block);
    if (block.t === "para" && block.lines.length === 0) {
      const parent = this.top();
      const at = parent.children.indexOf(block);
      if (at >= 0) parent.children.splice(at, 1);
    }
  }

  finishBlock(block) {
    if (block.t === "para") this.finishPara(block);
    else if (block.t === "list") this.finishList(block);
    else if (block.t === "code") {
      if (block.fenced) {
        // A fenced code block keeps its trailing blank lines: they are
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

  finishPara(para) {
    this.pullRefDefs(para);
  }

  // Consume leading link reference definitions from a paragraph's lines,
  // registering them (the first definition of a label wins).
  pullRefDefs(para) {
    const lines = para.lines;
    let i = 0;
    while (i < lines.length) {
      const res = this.parseRefDef(lines, i);
      if (!res) break;
      const key = foldLinkLabel(res.label);
      if (!this.definitions.has(key)) {
        this.definitions.set(key, { href: res.href, title: res.title });
      }
      i = res.nextLine;
    }
    para.lines = lines.slice(i);
  }

  finishList(list) {
    let tight = true;
    const items = list.children;
    for (let k = 0; k < items.length; k++) {
      const item = items[k];
      // An HTML block that is an item's last child keeps its trailing
      // newline when a blank line separates this item from the next
      // one (the list is loose and continues): marked renders the
      // newline even though the block's own line is followed by a
      // blank line (h7/j7/k5/k6/k9, probed 16 Nov 2026). The
      // "just ended" rule drops it, so restore it here.
      if (
        item.lastLineBlank &&
        k + 1 < items.length &&
        item.children.length > 0
      ) {
        const last = item.children[item.children.length - 1];
        if (last.t === "html") last.lastTerminated = true;
      }
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
  // After a ">" marker, one optional space is consumed. A tab there
  // expands on the grid anchored at the innermost list item's content
  // start (not the absolute column): marked expands it relative to the
  // item, so a tab at relative column 1 becomes 3 columns and the
  // quote consumes 1, leaving 2 spaces in the code (doc-30). At the
  // top level (no item matched) the anchor is 0, i.e. absolute.
  eatAfterMarker() {
    const p = this.peekChar();
    if (p === " ") {
      this.skipSpace(1);
    } else if (p === "\t") {
      const w = 4 - ((this.col - this.itemContentAt) % 4);
      this.idx++;
      this.col += 1;
      this.tabLeft = w - 1;
    }
  }

  matchQuote() {
    if (this.blankAhead()) {
      // A blank line only matches if it carries the ">" marker; a blank
      // line without it ends the blockquote.
      const save = this.savePos();
      this.skipSpace(3);
      if (this.peekChar() === ">") {
        this.idx++;
        this.col++;
        this.eatAfterMarker();
        return true;
      }
      this.restorePos(save);
      return false;
    }
    const save = this.savePos();
    this.skipSpace(3);
    if (this.peekChar() === ">") {
      this.idx++;
      this.col++;
      this.eatAfterMarker();
      return true;
    }
    this.restorePos(save);
    return false;
  }

  matchItem(item) {
    if (this.blankAhead()) return true;
    // An empty item is closed by a blank line: indented content after
    // it belongs to the enclosing block, not to the item.
    if (item.children.length === 0 && item.lastLineBlank) return false;
    // The item's indent is relative to the cursor after the enclosing
    // blockquotes (the same containers can consume a different number
    // of columns on different lines); outer items already consumed
    // part of it.
    const need = (item.contentIndent - item.baseCol) - this.itemIndentUsed;
    if (need <= 0) return true;
    const save = this.savePos();
    if (this.skipSpace(need) === need) return true;
    this.restorePos(save);
    return false;
  }

  // --- fresh line processing ----------------------------------------------
  handleFresh() {
    while (true) {
      const tip = this.top();
      if (tip.t === "code" && tip.fenced) {
        if (this.isFenceClose(tip)) {
          this.popBlock();
          return;
        }
        this.appendCodeLine(tip);
        return;
      }
      if (tip.t === "html") {
        if ((tip.kind === 6 || tip.kind === 7) && this.blankAhead()) {
          // A trailing blank line at the very end of the input belongs
          // to the block — but only at the top level: inside a
          // container the container's inner source ends without it
          // (h2: a <div> in a list item must not gain the newline).
          if (this.lineNo === this.lines.length - 1 && !this.hasContainer()) {
            tip.lit += "\n" + this.remainder();
            tip.lastTerminated = false;
          }
          this.popBlock();
          // Fall through: the blank line is processed below.
        } else {
          const ends = tip.kind <= 5 && this.htmlEndsHere(tip);
          this.appendHtmlLine(tip);
          if (ends) {
            tip.lastTerminated = this.htmlKeepsNewline();
            this.popBlock();
          }
          return;
        }
      }
      if (tip.t === "code" && !tip.fenced) {
        if (this.blankAhead() || this.indentAhead() >= 4) {
          this.appendCodeLine(tip);
          return;
        }
        this.popBlock();
        continue;
      }
      if (tip.t === "table") {
        // A whitespace-only line ends the table — except one whose
        // indent is exactly 4 columns, which is an empty row (a lone
        // tab, or a space plus a tab, both measure 4 columns).
        if (this.blankAhead() && this.indentAhead() !== 4) {
          this.popBlock();
          continue;
        }
        if (this.startsNewBlock()) {
          this.popBlock();
          continue;
        }
        this.appendTableRow(tip);
        return;
      }
      if (this.isBlank(false)) {
        this.blankLine();
        return;
      }
      if (tip.t === "para") {
        // A setext underline or table delimiter is only recognised after
        // leading link reference definitions are removed; definitions
        // whose title may still be on the next line are left alone here
        // (they are extracted when the paragraph is finalised).
        const level = this.setextLevel();
        const isTable = level === 0 && this.isTableRule();
        if (level > 0 || isTable) {
          this.pullRefDefs(tip);
          if (tip.lines.length === 0) {
            this.popBlock();
            continue;
          }
        }
        if (level > 0) {
          this.makeSetext(level);
          return;
        }
        if (isTable) {
          this.makeTable();
          return;
        }
      }
      const atx = this.matchHeading();
      if (atx) {
        this.closeLeafBlock();
        this.closeOpenLists();
        this.attachNode(atx);
        return;
      }
      const fence = this.matchFenceBlock();
      if (fence) {
        this.closeLeafBlock();
        this.closeOpenLists();
        this.attachNode(fence);
        this.open.push(fence);
        return;
      }
      const html = this.matchHtmlChunk();
      if (html) {
        if (html.kind === 7 && tip.t === "para") {
          // A type-7 block cannot interrupt a paragraph: fall through to
          // the paragraph continuation below.
        } else {
          this.closeLeafBlock();
          this.closeOpenLists();
          this.attachNode(html);
          if (!(html.kind <= 5 && this.htmlEndsHere(html))) {
            this.open.push(html);
          }
          return;
        }
      }
      if (this.isRule()) {
        this.closeLeafBlock();
        this.closeOpenLists();
        this.attachNode({ t: "hr", children: [] });
        return;
      }
      const listSave = this.savePos();
      const item = this.matchItemMarker();
      if (item) {
        // An ordered list starting with a number other than 1 cannot
        // interrupt a paragraph — unless the paragraph sits inside a
        // list item, where a nested list of any start number may
        // follow it (an empty item never interrupts a paragraph).
        const tipParent =
          this.open.length >= 2 ? this.open[this.open.length - 2] : null;
        const inItem = tipParent !== null && tipParent.t === "item";
        if (
          this.top().t === "para" &&
          (item.blank || (item.ordered && item.start !== 1 && !inItem))
        ) {
          // Cannot interrupt a paragraph: the line is paragraph text.
          this.restorePos(listSave);
          this.appendParaLine();
          return;
        }
        this.openItem(item);
        // An empty item (marker with no content) has nothing more on
        // this line; continuing would treat the consumed marker line as
        // a blank line and wrongly loosen the list.
        if (item.blank) return;
        continue;
      }
      if (this.matchQuoteStart()) {
        this.closeLeafBlock();
        this.closeOpenLists();
        const quote = { t: "quote", children: [] };
        this.attachNode(quote);
        this.open.push(quote);
        continue;
      }
      if (tip.t !== "para" && this.indentAhead() >= 4) {
        this.closeLeafBlock();
        this.closeOpenLists();
        const code = { t: "code", fenced: false, info: "", lit: "", started: false };
        this.attachNode(code);
        this.open.push(code);
        this.appendCodeLine(code);
        return;
      }
      if (tip.t === "para") {
        this.appendParaLine();
        return;
      }
      this.closeLeafBlock();
      this.closeOpenLists();
      const para = { t: "para", lines: [this.expandLeadingTabs(this.remainder())], hasLazyLine: false };
      this.attachNode(para);
      this.open.push(para);
      return;
    }
  }

  closeLeafBlock() {
    if (isLeafKind(this.top().t)) this.popBlock();
  }

  // Close any open lists: a new block that is not a list item cannot be a
  // direct child of a list, it belongs to the list's parent.
  closeOpenLists() {
    while (this.top().t === "list") this.popBlock();
  }

  attachNode(node) {
    node.open = true;
    node.lastLineBlank = false;
    if (node.children === undefined) node.children = [];
    const parent = this.top();
    // A blank line since the parent's previous child means this child
    // is separated from it by a blank line: the enclosing list is loose.
    if (parent.t === "item" && parent.blankPending && parent.children.length > 0) {
      parent.looseInner = true;
    }
    parent.blankPending = false;
    parent.children.push(node);
  }

  blankLine() {
    // A truly empty line marks every open block as ending blank; a line
    // that only looks blank inside its innermost container (e.g. "  >"
    // inside a quote) marks just that container and its descendants.
    // A blank line inside a quote or sublist must not loosen the
    // enclosing list, but a blank line between two items of a list must.
    let start;
    if (/^[ \t]*$/.test(this.line)) {
      start = 0;
    } else {
      start = this.open.indexOf(this.blankScope);
      if (start < 0) start = 0;
    }
    for (let k = start; k < this.open.length; k++) {
      this.open[k].lastLineBlank = true;
      this.open[k].blankPending = true;
    }
    if (isLeafKind(this.top().t)) this.popBlock();
  }

  appendParaLine() {
    this.top().lines.push(this.expandLeadingTabs(this.remainder()));
  }

  // Expand leading tabs in a paragraph line's content. Probed 16 Nov
  // 2026 (probe89/90): a tab at the start of the content expands to
  // spaces up to the next multiple of 4, with the column counted from
  // the innermost container — a blockquote counts from 2 (identical
  // for 1, 2 and 3 levels, and regardless of leading indent), a list
  // item from the absolute column; at the top level the raw tab is
  // preserved. Only leading whitespace is expanded; a tab in the
  // middle of the line stays a literal tab.
  expandLeadingTabs(text) {
    let inner = null;
    for (let k = this.open.length - 1; k >= 0; k--) {
      const b = this.open[k];
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

  appendCodeLine(block) {
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
    //   and the indent may consume (part of) a tab, which skipSpace()
    //   handles via `tabLeft`.
    let inner = null;
    for (let k = this.open.length - 1; k >= 0; k--) {
      const b = this.open[k];
      if (b.t === "quote" || b.t === "item") {
        inner = b.t;
        break;
      }
    }
    let text;
    if (inner === "quote") {
      text = this.remainder();
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
      // The fence indent is stripped from the expanded text — except
      // for tilde fences, which never strip it (probe93/94).
      const isTilde = block.fenced && block.fenceChar === "~";
      let cut = 0;
      if (!isTilde) {
        while (cut < indent && cut < text.length && text[cut] === " ") cut++;
      }
      text = text.slice(cut);
      this.skipSpace(indent);
    } else if (inner === "item") {
      const beforeI = this.idx;
      // A tilde fence never strips its indent (probe93/94).
      if (!(block.fenced && block.fenceChar === "~")) this.skipSpace(indent);
      // Probed 16 Nov 2026 (probe75): in a FENCED code block, when the
      // fence-indent strip partially consumes a tab, marked drops the
      // whole tab — the remainder is not kept as spaces. But a
      // remainder left over from container matching (no tab consumed
      // by this strip) is kept, so only drop it when this advance
      // crossed a tab. Indented code keeps the remainder (cm-005/007).
      if (block.fenced && this.tabLeft > 0 && this.line.slice(beforeI, this.idx).includes("\t")) this.tabLeft = 0;
      text = this.remainder();
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
      const beforeI = this.idx;
      // A tilde fence never strips its indent (probe93/94).
      if (!(block.fenced && block.fenceChar === "~")) this.skipSpace(indent);
      // See the item branch: a tab partially consumed by the
      // fence-indent strip is dropped whole (fenced code only).
      if (block.fenced && this.tabLeft > 0 && this.line.slice(beforeI, this.idx).includes("\t")) this.tabLeft = 0;
      text = this.remainder();
    }
    if (block.started) block.lit += "\n";
    else block.started = true;
    block.lit += text;
    block.lastLineTerminated = this.lineEnds();
    // Remember whether the last non-blank line was terminated: trailing
    // blank lines are stripped from a code block when it closes.
    if (!/^[ \t]*$/.test(text)) block.lastContentTerminated = this.lineEnds();
  }

  lineEnds() {
    // Every line except the last line of the input is terminated.
    return this.lineNo < this.lines.length - 1;
  }

  // An HTML block's text ends with a newline only if this line is
  // terminated and the next line is not a blank line with more content
  // after it (a blank line ends the block without a trailing newline).
  htmlLineEnds(kind) {
    if (!this.lineEnds()) return false;
    const next = this.lineNo + 1;
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
  // input it is included only at the top level. `upto` is forwarded to
  // nextLineFits (see there); `kind` selects its whitespace rule.
  htmlKeepsNewline(upto, kind) {
    const next = this.lineNo + 1;
    if (next >= this.lines.length) return false;
    const line = this.lines[next];
    if (next === this.lines.length - 1 && /^[ \t]*$/.test(line)) {
      // The final line is blank: the block runs to the end of the input,
      // whose trailing newline counts only at the top level.
      return !this.hasContainer();
    }
    // Probed 16 Nov 2026 (probe76/77): a truly empty next line drops
    // the trailing newline, but a whitespace-only (non-empty) line
    // keeps it for kind <= 5 blocks (comment, PI, CDATA, declaration,
    // script/pre/style) — it falls through to the container check.
    if (line === "") return false;
    return this.nextLineFits(upto, kind);
  }

  hasContainer() {
    for (let k = 1; k < this.open.length; k++) {
      const t = this.open[k].t;
      if (t === "quote" || t === "item") return true;
    }
    return false;
  }

  // Would the next line match every container the HTML block sits in?
  // (Simulates phase-1 container matching on the next line.) `upto` is
  // the exclusive stack bound: by default the tip (the HTML block
  // itself) is excluded; callers matching a block that is not yet on
  // the stack pass the full length to include the parent container.
  // `kind` selects the whitespace rule for the remainder: a
  // whitespace-only remainder keeps the newline for kind <= 5 blocks
  // (probe76/77) but drops it for kind 6/7 blocks.
  nextLineFits(upto = this.open.length - 1, kind) {
    const saveS = this.line;
    const saveI = this.idx;
    const saveCol = this.col;
    const savePartial = this.tabLeft;
    const saveLineNo = this.lineNo;
    const saveItemIndentUsed = this.itemIndentUsed;
    const saveItemContentAt = this.itemContentAt;
    this.lineNo = this.lineNo + 1;
    this.line = this.lines[this.lineNo];
    this.idx = 0;
    this.col = 0;
    this.tabLeft = 0;
    // A fresh line starts with no item indent consumed (the previous
    // line's value would make matchItem think the indent is already met).
    this.itemIndentUsed = 0;
    this.itemContentAt = 0;
    let ok = true;
    for (let k = 1; k < upto; k++) {
      const b = this.open[k];
      if (b.t === "list") continue;
      if (b.t === "quote") {
        if (!this.matchQuote()) {
          ok = false;
          break;
        }
      } else if (b.t === "item") {
        const beforeCol = this.col;
        if (!this.matchItem(b)) {
          ok = false;
          break;
        }
        // matchItem returns early for a blank line without consuming
        // the item's indent; consume it here so remainder() reflects the
        // post-indent content (a line of just the indent is blank).
        if (this.blankAhead()) {
          const need = (b.contentIndent - b.baseCol) - this.itemIndentUsed;
          if (need > 0) this.skipSpace(need);
        }
        this.itemIndentUsed += this.col - beforeCol;
        this.itemContentAt = this.col;
      } else break;
    }
    // The next line only keeps the block's trailing newline if it
    // carries content inside the containers: a line that is blank
    // within them (e.g. ">" alone, or just the item's indent) drops
    // it, while a whitespace-only remainder keeps it for kind <= 5
    // (probe76/77) but drops it for kind 6/7.
    if (ok) {
      const rest = this.remainder();
      if (rest === "") ok = false;
      else if (kind !== undefined && kind > 5 && /^[ \t]*$/.test(rest)) ok = false;
    }
    this.line = saveS;
    this.idx = saveI;
    this.col = saveCol;
    this.tabLeft = savePartial;
    this.lineNo = saveLineNo;
    this.itemIndentUsed = saveItemIndentUsed;
    this.itemContentAt = saveItemContentAt;
    return ok;
  }

  appendHtmlLine(block) {
    if (block.started) block.lit += "\n";
    else block.started = true;
    block.lit += this.remainder();
    block.lastTerminated = this.htmlLineEnds(block.kind);
  }

  appendTableRow(table) {
    table.rows.push(this.remainder());
  }

  // --- block starts ---------------------------------------------------------
  matchHeading() {
    const save = this.savePos();
    this.skipSpace(3);
    let hashes = 0;
    while (this.peekChar() === "#") {
      this.idx++;
      this.col++;
      hashes++;
      if (hashes > 6) {
        this.restorePos(save);
        return null;
      }
    }
    if (hashes === 0) {
      this.restorePos(save);
      return null;
    }
    const after = this.peekChar();
    if (after !== "" && after !== " " && after !== "\t") {
      this.restorePos(save);
      return null;
    }
    // The heading text is the rest of the line. A closing sequence is a
    // run of "#" at the end preceded by whitespace; the whitespace may be
    // the space(s) right after the opening hashes, so check it before
    // stripping the leading whitespace ("# #" is an empty heading).
    let text = this.remainder().replace(/[ \t]+$/, "");
    const m = /[ \t]+#+$/.exec(text);
    if (m) text = text.slice(0, m.index);
    text = text.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    return { t: "heading", level: hashes, text };
  }

  matchFenceBlock() {
    const save = this.savePos();
    const indent = this.skipSpace(3);
    const ch = this.peekChar();
    if (ch !== "`" && ch !== "~") {
      this.restorePos(save);
      return null;
    }
    let len = 0;
    while (this.peekChar() === ch) {
      this.idx++;
      this.col++;
      len++;
    }
    if (len < 3) {
      this.restorePos(save);
      return null;
    }
    const info = this.remainder();
    if (ch === "`" && info.indexOf("`") >= 0) {
      this.restorePos(save);
      return null;
    }
    return {
      t: "code", fenced: true, fenceChar: ch, fenceLen: len,
      fenceIndent: indent, info: info.replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""),
      lit: "", started: false,
    };
  }

  isFenceClose(tip) {
    const save = this.savePos();
    this.skipSpace(3);
    let len = 0;
    while (this.peekChar() === tip.fenceChar) {
      this.idx++;
      this.col++;
      len++;
    }
    const ok = len >= tip.fenceLen && this.blankAhead();
    if (!ok) this.restorePos(save);
    return ok;
  }

  matchHtmlChunk() {
    const save = this.savePos();
    this.skipSpace(3);
    if (this.peekChar() !== "<") {
      this.restorePos(save);
      return null;
    }
    const rest = this.line.slice(this.idx);
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
      const name = this.tagNameHere();
      if (name !== null && BLOCK_TAG_NAMES.has(name)) {
        kind = 6;
      } else {
        const tag = this.parseTagHere();
        if (tag && tag.complete) {
          kind = 7;
        } else {
          this.restorePos(save);
          return null;
        }
      }
    }
    // Note: a type-7 block cannot interrupt a paragraph; that is the
    // caller's job (handleFresh suppresses it, the lazy branch in
    // handleLine handles it specially).
    // The literal is the whole line from after the container prefixes,
    // including up to three spaces of indent.
    this.restorePos(save);
    const node = { t: "html", kind, endTag, lit: this.remainder(), started: true };
    // A block that ends on this line takes the "block just ended" rule
    // (not the line-based one): its trailing newline is kept only if
    // the next line stays inside the block's parent container. The
    // block is not on the stack yet, so include the tip (the parent)
    // in the container check. Multi-line blocks get this overwritten
    // when they end; kind 6/7 blocks get it overwritten per line.
    node.lastTerminated = this.htmlKeepsNewline(this.open.length, kind);
    return node;
  }

  // The tag name at the cursor ("<" ["/"] letter (letter|digit|"-")*),
  // followed by a space, tab, ">", "/", or end of line. Null if the line
  // does not start with a tag.
  tagNameHere() {
    const s = this.line;
    let j = this.idx;
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
  parseTagHere() {
    const s = this.line;
    const n = s.length;
    let j = this.idx;
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
      // A closing tag takes no attributes: only whitespace, then ">".
      let k = j;
      while (k < n && (s[k] === " " || s[k] === "\t" || s[k] === "\n")) k++;
      if (k < n && s[k] === ">") {
        return { name, complete: this.blankFrom(k + 1) };
      }
      return null;
    }
    while (true) {
      let k = j;
      while (k < n && (s[k] === " " || s[k] === "\t" || s[k] === "\n")) k++;
      if (k < n && s[k] === ">") {
        return { name, complete: this.blankFrom(k + 1) };
      }
      if (k < n && s[k] === "/" && k + 1 < n && s[k + 1] === ">") {
        return { name, complete: this.blankFrom(k + 2) };
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

  blankFrom(idx) {
    for (let k = idx; k < this.line.length; k++) {
      const ch = this.line[k];
      if (ch !== " " && ch !== "\t") return false;
    }
    return true;
  }

  htmlEndsHere(block) {
    if (block.kind === 1) {
      return this.line.toLowerCase().includes("</" + block.endTag);
    }
    return this.line.includes(block.endTag);
  }

  isRule() {
    const save = this.savePos();
    this.skipSpace(3);
    const ch = this.peekChar();
    if (ch !== "*" && ch !== "-" && ch !== "_") {
      this.restorePos(save);
      return false;
    }
    let count = 0;
    while (true) {
      const p = this.peekChar();
      if (p === ch) {
        this.idx++;
        this.col++;
        count++;
      } else if (p === " " || p === "\t") {
        this.skipSpace(1);
      } else break;
    }
    const ok = count >= 3 && this.blankAhead();
    if (!ok) this.restorePos(save);
    return ok;
  }

  setextLevel() {
    const save = this.savePos();
    this.skipSpace(3);
    const ch = this.peekChar();
    if (ch !== "=" && ch !== "-") {
      this.restorePos(save);
      return 0;
    }
    while (this.peekChar() === ch) {
      this.idx++;
      this.col++;
    }
    if (this.blankAhead()) {
      this.restorePos(save);
      return ch === "=" ? 1 : 2;
    }
    this.restorePos(save);
    return 0;
  }

  makeSetext(level) {
    const para = this.top();
    // A heading's content has leading and trailing whitespace stripped.
    const text = para.lines
      .join("\n")
      .replace(/^[ \t]+/, "")
      .replace(/[ \t]+$/, "");
    const heading = { t: "heading", level, text };
    const parent = this.open[this.open.length - 2];
    const at = parent.children.indexOf(para);
    parent.children[at] = heading;
    this.open.pop();
  }

  isTableRule() {
    const tip = this.top();
    if (tip.t !== "para" || tip.lines.length === 0) return false;
    if (this.indentAhead() >= 4) return false;
    const headerCells = splitRowCells(tip.lines[tip.lines.length - 1]);
    const save = this.savePos();
    this.skipSpace(3);
    const delimCells = splitRowCells(this.remainder());
    this.restorePos(save);
    if (delimCells.length !== headerCells.length) return false;
    for (const cell of delimCells) {
      if (!/^:?-+:?$/.test(cell)) return false;
    }
    return true;
  }

  makeTable() {
    const para = this.top();
    const headerLine = para.lines[para.lines.length - 1];
    const headerCells = splitRowCells(headerLine);
    const delimCells = splitRowCells(this.remainder());
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
    const parent = this.open[this.open.length - 2];
    const at = parent.children.indexOf(para);
    if (para.lines.length > 1) {
      para.lines = para.lines.slice(0, -1);
      parent.children.splice(at + 1, 0, table);
    } else {
      parent.children[at] = table;
    }
    this.open.pop();
    this.open.push(table);
  }

  // Does the line at the cursor start a block that ends a table?
  startsNewBlock() {
    const save = this.savePos();
    // A whitespace-only line starts no block (not even indented code,
    // which needs content); this matters for table rows, where a lone
    // tab (4 columns) is an empty row rather than a new block.
    if (this.blankAhead()) {
      this.restorePos(save);
      return false;
    }
    if (this.matchHeading() || this.matchFenceBlock() || this.matchHtmlChunk()) {
      this.restorePos(save);
      return true;
    }
    if (this.isRule()) {
      this.restorePos(save);
      return true;
    }
    const item = this.matchItemMarker();
    if (item) {
      this.restorePos(save);
      return true;
    }
    if (this.matchQuoteStart()) {
      this.restorePos(save);
      return true;
    }
    if (this.indentAhead() >= 4) {
      this.restorePos(save);
      return true;
    }
    this.restorePos(save);
    return false;
  }

  matchItemMarker() {
    const save = this.savePos();
    // The marker and content columns are relative to the cursor position
    // after the enclosing containers: the same containers can consume a
    // different number of columns on different lines (e.g. ">>" vs
    // "> > "), so absolute columns do not compare across lines. The
    // cursor is already past the indents of the open items, so those
    // are subtracted back out.
    const baseCol = this.col - this.itemIndentUsed;
    this.skipSpace(3);
    const markerCol = this.col;
    const ch = this.peekChar();
    let bullet = null;
    let ordered = false;
    let start = 0;
    let delim = "";
    let width = 0;
    if (ch === "-" || ch === "+" || ch === "*") {
      bullet = ch;
      width = 1;
      this.idx++;
      this.col++;
    } else if (ch >= "0" && ch <= "9") {
      let num = 0;
      let digits = 0;
      let j = this.idx;
      while (j < this.line.length && this.line[j] >= "0" && this.line[j] <= "9") {
        if (digits >= 9) {
          this.restorePos(save);
          return null;
        }
        num = num * 10 + (this.line.charCodeAt(j) - 48);
        digits++;
        j++;
      }
      if (digits === 0) {
        this.restorePos(save);
        return null;
      }
      const d = this.line[j];
      if (d !== "." && d !== ")") {
        this.restorePos(save);
        return null;
      }
      ordered = true;
      start = num;
      delim = d;
      width = digits + 1;
      this.idx = j + 1;
      this.col += digits + 1;
    } else {
      this.restorePos(save);
      return null;
    }
    const after = this.peekChar();
    if (after !== "" && after !== " " && after !== "\t") {
      this.restorePos(save);
      return null;
    }
    const afterMarker = this.savePos();
    let spaces = 0;
    while (this.peekChar() === " " || this.peekChar() === "\t") {
      this.skipSpace(1);
      spaces++;
    }
    const blank = this.peekChar() === "";
    let contentIndent;
    if (blank) {
      contentIndent = markerCol + width + 1;
    } else if (spaces >= 1 && spaces <= 4) {
      contentIndent = markerCol + width + spaces;
    } else {
      contentIndent = markerCol + width + 1;
      this.restorePos(afterMarker);
      this.skipSpace(1);
    }
    return {
      bullet, ordered, start, delim,
      markerCol, width, contentIndent,
      // The cursor after the enclosing containers, for the relative
      // content indent used when the item is matched on later lines.
      baseCol,
      blank, cursor: this.savePos(),
    };
  }

  // The new item is a sibling of the deepest open item whose content
  // indent is greater than the marker column, and nested inside any item
  // whose content indent is less than or equal to it.
  openItem(item) {
    this.closeLeafBlock();
    while (true) {
      const tip = this.top();
      if (tip.t === "item") {
        if (item.markerCol >= tip.contentIndent) break;
        this.popBlock();
        continue;
      }
      if (tip.t === "list") {
        if (this.listFits(tip, item)) {
          this.pushItem(tip, item);
          return;
        }
        this.popBlock();
        continue;
      }
      break;
    }
    const list = {
      t: "list", ordered: item.ordered, start: item.start,
      delim: item.delim, bullet: item.bullet, tight: true, children: [],
    };
    this.attachNode(list);
    this.open.push(list);
    this.pushItem(list, item);
  }

  listFits(list, item) {
    return (
      (item.ordered && list.ordered && list.delim === item.delim) ||
      (!item.ordered && !list.ordered && list.bullet === item.bullet)
    );
  }

  pushItem(list, item) {
    const itemNode = {
      t: "item", contentIndent: item.contentIndent, baseCol: item.baseCol,
      checked: null, children: [],
    };
    list.children.push(itemNode);
    this.open.push(itemNode);
    // The marker and its following spaces are consumed on this line,
    // so a nested item matched later on the same line measures its
    // columns from the same base.
    this.itemIndentUsed += item.contentIndent - item.baseCol;
    // Task list marker: [ ], [x], [X] followed by space/tab/EOL.
    const rest = this.remainder();
    if (
      rest.length >= 3 && rest[0] === "[" && rest[2] === "]" &&
      (rest[1] === " " || rest[1] === "x" || rest[1] === "X")
    ) {
      const after = rest.length === 3 ? "" : rest[3];
      if (after === "" || after === " " || after === "\t") {
        itemNode.checked = rest[1] !== " ";
        this.idx += 3;
        this.col += 3;
        if (after === " " || after === "\t") this.skipSpace(1);
      }
    }
  }

  matchQuoteStart() {
    const save = this.savePos();
    this.skipSpace(3);
    if (this.peekChar() === ">") {
      this.idx++;
      this.col++;
      const p = this.peekChar();
      if (p === " " || p === "\t") this.skipSpace(1);
      return true;
    }
    this.restorePos(save);
    return false;
  }

  // --- link reference definitions -------------------------------------------
  parseRefDef(lines, startIdx) {
    let li = startIdx;
    let line = lines[li];
    let pos = 0;
    let col = 0;
    // Indent before the label: at most 3 columns.
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
    // Label: may span lines; newlines inside it count as spaces.
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
      if (ch === "\\" && j + 1 < curLine.length && isAsciiPunct(curLine[j + 1])) {
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
    if (!closed || foldLinkLabel(label) === "") return null;
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
    if (skipWs() === 0) return null; // No destination.
    // Destination.
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
        if (ch === "\\" && pos + 1 < line.length && isAsciiPunct(line[pos + 1])) {
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
        if (ch === "\\" && pos + 1 < line.length && isAsciiPunct(line[pos + 1])) {
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
    // A title right after the destination, with no whitespace, is junk.
    if (line[pos] === '"' || line[pos] === "'" || line[pos] === "(") return null;
    if (skipWs() === 1) {
      const ch = line[pos];
      if (ch === '"' || ch === "'" || ch === "(") {
        const titleStartLi = li;
        const res = this.parseTitleText(lines, li, pos);
        if (!res) {
          // A title that never closes: backtrack to the dest-only def
          // when the title started on a later line than the destination.
          if (titleStartLi !== afterDestLi) {
            return { label, href, title: null, nextLine: afterDestLi + 1 };
          }
          return null;
        }
        title = res.title;
        li = res.li;
        line = lines[li];
        pos = res.pos;
        // After the title only whitespace may follow on the same line.
        let p = pos;
        while (p < line.length && (line[p] === " " || line[p] === "\t")) p++;
        if (p < line.length) {
          // Junk after the title: backtrack to the dest-only def when
          // the title started on a later line than the destination.
          if (titleStartLi !== afterDestLi) {
            return { label, href, title: null, nextLine: afterDestLi + 1 };
          }
          return null;
        }
      } else if (li !== afterDestLi) {
        // The next line is not a title: the def ends at the destination.
        li = afterDestLi;
        line = lines[li];
        pos = afterDestPos;
      } else {
        return null; // Junk on the same line after the destination.
      }
    }
    return { label, href, title, nextLine: li + 1 };
  }

  // Parse a link title starting at (li, pos) on the given lines. The
  // title may span lines. Returns {title, li, pos} (pos just after the
  // closing quote) or null.
  parseTitleText(lines, li, pos) {
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
      if (ch === "\\" && j + 1 < curLine.length && isAsciiPunct(curLine[j + 1])) {
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

export function renderNodes(nodes, refs, out, tight) {
  for (const node of nodes) renderNode(node, refs, out, tight);
}

function renderNode(node, refs, out, tight) {
  switch (node.t) {
    case "para": {
      const text = node.lines.join("\n");
      if (tight) {
        out.push(inlineToHtml(text, refs));
      } else {
        out.push("<p>", inlineToHtml(text, refs), "</p>\n");
      }
      break;
    }
    case "heading": {
      out.push(
        "<h", String(node.level), ">",
        inlineToHtml(node.text, refs),
        "</h", String(node.level), ">\n",
      );
      break;
    }
    case "code": {
      if (node.fenced) {
        const lang = fenceLanguage(node.info);
        out.push(
          "<pre><code",
          lang ? ' class="language-' + escapeAttr(lang) + '"' : "",
          ">", escapeRaw(node.lit),
          node.lastTerminated ? "\n" : "",
          "</code></pre>\n",
        );
      } else {
        out.push(
          "<pre><code>", escapeRaw(node.lit),
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
      renderNodes(node.children, refs, out, false);
      out.push("</blockquote>\n");
      break;
    }
    case "list": {
      if (node.ordered) {
        out.push(node.start !== 1 ? `<ol start="${node.start}">\n` : "<ol>\n");
      } else {
        out.push("<ul>\n");
      }
      renderNodes(node.children, refs, out, node.tight);
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
        // In a loose list the checkbox sits inside the first <p>.
        const first = node.children[0];
        out.push("<p>", checkbox, inlineToHtml(first.lines.join("\n"), refs), "</p>\n");
        for (let k = 1; k < node.children.length; k++) {
          renderNode(node.children[k], refs, out, tight);
        }
      } else {
        if (checkbox !== null) out.push(checkbox);
        renderNodes(node.children, refs, out, tight);
      }
      out.push("</li>\n");
      break;
    }
    case "table": {
      out.push("<table>\n<thead>\n<tr>\n");
      for (let k = 0; k < node.header.length; k++) {
        const a = node.align[k];
        out.push("<th", a ? ` align="${a}"` : "", ">", inlineToHtml(node.header[k], refs), "</th>\n");
      }
      out.push("</tr>\n</thead>\n");
      if (node.rows.length > 0) {
        out.push("<tbody>");
        for (const row of node.rows) {
          const cells = splitRowCells(row);
          out.push("<tr>\n");
          for (let k = 0; k < node.header.length; k++) {
            const a = node.align[k];
            const cell = k < cells.length ? cells[k] : "";
            out.push("<td", a ? ` align="${a}"` : "", ">", inlineToHtml(cell, refs), "</td>\n");
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
function fenceLanguage(info) {
  let end = 0;
  while (end < info.length && info[end] !== " " && info[end] !== "\t") end++;
  const word = info.slice(0, end);
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === "\\" && i + 1 < word.length && isAsciiPunct(word[i + 1])) {
      out += word[i + 1];
      i++;
      continue;
    }
    out += c;
  }
  return out;
}
