// Runs the shipped decision path against the corpus and reports what the
// harness actually receives, including the stakes bump. This is the
// end-to-end number: unlike the calibration report it includes the policy.
// Run after `npm run build`: node scripts/verify-decisions.mjs
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  EFFORT_ORDER,
  askSystemOne,
  buildState,
  composeDecision,
} from "../dist/core/index.js";

const endpoint = "http://127.0.0.1:8017";
const rows = (await readFile(join("calibration", "corpus.jsonl"), "utf8"))
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const level = (name) => EFFORT_ORDER.indexOf(name);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

let exact = 0;
let under = 0;
let risky = 0;
let riskyUnder = 0;
const byExpected = {};

for (const row of rows) {
  const state = buildState(row.text, { agent: "build", model: null });
  const response = await askSystemOne(state, { endpoint });
  const decision = composeDecision(response, DEFAULT_CONFIG);
  const gap = level(decision.effort) - level(row.expected);
  if (gap === 0) exact += 1;
  if (gap < 0) under += 1;
  if (row.stakes) {
    risky += 1;
    if (gap < 0) riskyUnder += 1;
  }
  const key = `${row.expected}->${decision.effort}`;
  byExpected[key] = (byExpected[key] ?? 0) + 1;
}

console.log(`prompts: ${rows.length}`);
console.log(`exact: ${pct(exact / rows.length)}`);
console.log(`under-powered: ${pct(under / rows.length)}`);
console.log(`dangerous under-powered: ${riskyUnder} of ${risky}`);
console.log("final levels:");
for (const [key, count] of Object.entries(byExpected).sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`  ${key.padEnd(18)} ${count}`);
}
