// Probes whether each effort level is reachable at all, and where the model
// puts its probability mass. Run after `npm run build`:
//   node scripts/reach.mjs [--endpoint URL]
import {
  DEFAULT_QUESTIONS,
  askSystemOne,
  buildState,
} from "../dist/core/index.js";

const args = process.argv.slice(2);
const endpointFlag = args.indexOf("--endpoint");
const endpoint =
  endpointFlag >= 0 ? args[endpointFlag + 1] : "http://127.0.0.1:8017";

const prompts = [
  ["trivial", "say hi in one word"],
  ["simple", "explain what this function does"],
  ["moderate", "add pagination to this list endpoint"],
  ["complex", "refactor the plugin loading to support removal entries"],
  [
    "critical",
    "prove this consensus implementation is safe under partitions, and " +
      "review the cryptography for side channels; a wrong answer costs money",
  ],
];

for (const [label, text] of prompts) {
  const state = buildState(text, { agent: "build", model: null });
  const response = await askSystemOne(state, { endpoint }, DEFAULT_QUESTIONS);
  const answer = response.answers?.reasoning_effort;
  const probabilities = answer?.probabilities ?? {};
  const sorted = Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([name, p]) => `${name} ${(p * 100).toFixed(1)}%`)
    .join(", ");
  const choice = String(answer?.choice).padEnd(8);
  const confidence = (answer?.confidence ?? 0).toFixed(2);
  const line = `${label.padEnd(9)} choice=${choice} conf=${confidence}`;
  console.log(`${line} [${sorted}]`);
}
