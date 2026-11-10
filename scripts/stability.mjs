// Measures how much jev's answers vary between identical requests. Without
// this, a difference between two wordings cannot be told apart from noise.
// Run after `npm run build`: node scripts/stability.mjs [--endpoint URL]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_QUESTIONS,
  EFFORT_ORDER,
  askSystemOne,
  buildState,
} from "../dist/core/index.js";

const args = process.argv.slice(2);
const endpointFlag = args.indexOf("--endpoint");
const endpoint =
  endpointFlag >= 0 ? args[endpointFlag + 1] : "http://127.0.0.1:8017";
const REPEATS = 5;

const rows = (await readFile(join("calibration", "corpus.jsonl"), "utf8"))
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const level = (name) => EFFORT_ORDER.indexOf(name);

let stable = 0;
let withinOne = 0;
let total = 0;
const spreads = [];
const confidenceSpreads = [];
const stakesSpreads = [];

for (const row of rows) {
  const state = buildState(row.text, { agent: "build", model: null });
  const picks = [];
  const confidences = [];
  const stakes = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const response = await askSystemOne(state, { endpoint }, DEFAULT_QUESTIONS);
    picks.push(response.answers?.reasoning_effort?.choice ?? "unknown");
    confidences.push(response.answers?.reasoning_effort?.confidence ?? 0);
    stakes.push(response.answers?.high_stakes?.noul ?? 0);
  }
  const levels = picks.map(level);
  const spread = Math.max(...levels) - Math.min(...levels);
  spreads.push(spread);
  confidenceSpreads.push(Math.max(...confidences) - Math.min(...confidences));
  stakesSpreads.push(Math.max(...stakes) - Math.min(...stakes));
  if (spread === 0) stable += 1;
  if (spread <= 1) withinOne += 1;
  total += 1;
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.log(`prompts: ${total}, repeats each: ${REPEATS}`);
console.log(`identical every time: ${pct(stable / total)}`);
console.log(`within one level every time: ${pct(withinOne / total)}`);
console.log(`mean level spread: ${mean(spreads).toFixed(2)}`);
console.log(`mean confidence spread: ${mean(confidenceSpreads).toFixed(3)}`);
console.log(`mean stakes spread: ${mean(stakesSpreads).toFixed(3)}`);
