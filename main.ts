// Driver for the markdown-render-speed-02 entry.
//
// Reads every case from cases.json in the input directory, renders each
// one on its own with parse() from parse.js, and writes the HTML strings
// (one per case, in the cases' order) to html.json in the output
// directory. Inside the harness the directories are /input and /output;
// outside it MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR override them.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

interface Case {
  id: string;
  markdown: string;
}

const cases: Case[] = JSON.parse(
  readFileSync(join(inputDir, "cases.json"), "utf8"),
);

const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(rendered));
