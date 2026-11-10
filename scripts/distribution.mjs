// Shows the raw score distributions behind the threshold choice, so a cut-off
// is picked from data rather than from a single F1 number. Run after
// `npm run build`: node scripts/distribution.mjs [--endpoint URL]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_QUESTIONS,
  askSystemOne,
  buildState,
} from "../dist/core/index.js";

const args = process.argv.slice(2);
const endpointFlag = args.indexOf("--endpoint");
const endpoint =
  endpointFlag >= 0 ? args[endpointFlag + 1] : "http://127.0.0.1:8017";

const rows = (await readFile(join("calibration", "corpus.jsonl"), "utf8"))
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const buckets = (values) => {
  const edges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
  const counts = new Array(edges.length - 1).fill(0);
  for (const value of values) {
    for (let i = 0; i < counts.length; i += 1) {
      if (value >= edges[i] && value < edges[i + 1]) {
        counts[i] += 1;
        break;
      }
    }
  }
  return counts.map((count, i) => `${edges[i].toFixed(1)}: ${count}`);
};

const riskyStakes = [];
const safeStakes = [];
const confidences = [];
for (const row of rows) {
  const state = buildState(row.text, { agent: "build", model: null });
  const response = await askSystemOne(state, { endpoint }, DEFAULT_QUESTIONS);
  const stakes = response.answers?.high_stakes?.noul ?? 0;
  confidences.push(response.answers?.reasoning_effort?.confidence ?? 0);
  (row.stakes ? riskyStakes : safeStakes).push(stakes);
}

const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const parts = [
    `min ${sorted[0].toFixed(2)}`,
    `p25 ${at(0.25).toFixed(2)}`,
    `median ${at(0.5).toFixed(2)}`,
    `p75 ${at(0.75).toFixed(2)}`,
    `max ${sorted.at(-1).toFixed(2)}`,
  ];
  return parts.join(" ");
};

const printRow = (label, values) =>
  console.log(`${label.padEnd(20)} ${summarize(values)}`);
printRow(`dangerous (${riskyStakes.length})`, riskyStakes);
printRow(`ordinary (${safeStakes.length})`, safeStakes);
printRow("confidence", confidences);
console.log("");
console.log(`dangerous stakes: ${buckets(riskyStakes).join(" | ")}`);
console.log(`ordinary stakes:  ${buckets(safeStakes).join(" | ")}`);
console.log(`confidence:       ${buckets(confidences).join(" | ")}`);
