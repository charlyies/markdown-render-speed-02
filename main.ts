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

const sourceDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const targetDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

type InputCase = {
  id: string;
  markdown: string;
};

const inputCases: InputCase[] = JSON.parse(
  readFileSync(join(sourceDir, "cases.json"), "utf8"),
);

const htmlOut: string[] = new Array(inputCases.length);
for (let idx = 0; idx < inputCases.length; idx++) {
  htmlOut[idx] = parse(inputCases[idx].markdown);
}

mkdirSync(targetDir, { recursive: true });
writeFileSync(join(targetDir, "html.json"), JSON.stringify(htmlOut));
