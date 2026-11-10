// Measures how jev classifies a labelled corpus, and which question wording
// and thresholds fit it. Run after `npm run build`:
//   node scripts/calibrate.mjs [--endpoint URL]
// Writes calibration/report.md.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_QUESTIONS,
  EFFORT_ORDER,
  askSystemOne,
  buildState,
  composeDecision,
} from "../dist/core/index.js";

const CORPUS = join("calibration", "corpus.jsonl");
const REPORT = join("calibration", "report.md");

const args = process.argv.slice(2);
const endpointFlag = args.indexOf("--endpoint");
const endpoint =
  endpointFlag >= 0 ? args[endpointFlag + 1] : "http://127.0.0.1:8017";

const rows = (await readFile(CORPUS, "utf8"))
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const level = (name) => EFFORT_ORDER.indexOf(name);
const top = EFFORT_ORDER.length - 1;
const shiftUp = (name) => EFFORT_ORDER[Math.min(level(name) + 1, top)];
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const signed = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

// Wording candidates. `previous` is the wording shipped before calibration;
// the corpus showed it made the model under-rate by 0.40 levels and never pick
// xhigh, so the shipped criteria were sharpened to fix that at the source.
const PREVIOUS = {
  ...DEFAULT_QUESTIONS,
  effortCriteria: {
    minimal:
      "Trivial lookup, greeting, formatting, or a single obvious answer " +
      "with no tradeoffs.",
    low:
      "Simple well-defined task: single-file edit, explain code, or a " +
      "small fix with a clear path.",
    medium:
      "Moderate task: multi-file change, debugging with some unknowns, " +
      "or choosing between a few approaches.",
    high:
      "Complex task: ambiguous requirements, system-wide refactor, hard " +
      "bug, security or performance critical work, novel design.",
    xhigh:
      "Exceptional: mission-critical architecture, intricate distributed " +
      "logic, adversarial security, or high-uncertainty research where a " +
      "wrong answer is costly.",
  },
};
const SPECS = [
  { name: "shipped wording", spec: DEFAULT_QUESTIONS },
  { name: "previous wording", spec: PREVIOUS },
];

// Ask once per prompt per wording and keep the raw answers, so every policy
// replays without another model call.
const samplesBySpec = new Map();
for (const { name, spec } of SPECS) {
  const samples = [];
  for (const row of rows) {
    const state = buildState(row.text, { agent: "build", model: null });
    const started = performance.now();
    const response = await askSystemOne(state, { endpoint }, spec);
    const elapsed = performance.now() - started;
    const choice = response.answers?.reasoning_effort;
    samples.push({
      text: row.text,
      expected: row.expected,
      stakes: row.stakes,
      raw: choice?.choice ?? "unknown",
      confidence: choice?.confidence ?? 0,
      highStakes: response.answers?.high_stakes?.noul ?? 0,
      ms: elapsed,
    });
  }
  samplesBySpec.set(name, samples);
}

function evaluate(samples, minConfidence, stakesThreshold) {
  let exact = 0;
  let near = 0;
  let under = 0;
  let excess = 0;
  let changed = 0;
  const final = {};
  for (const sample of samples) {
    const decision = composeDecision(
      {
        answers: {
          reasoning_effort: {
            type: "choice",
            choice: sample.raw,
            probabilities: {},
            confidence: sample.confidence,
          },
          high_stakes: { type: "noul", noul: sample.highStakes },
        },
      },
      {
        defaultEffort: DEFAULT_CONFIG.defaultEffort,
        maxEffort: DEFAULT_CONFIG.maxEffort,
        minConfidence,
        stakesThreshold,
      },
    );
    const gap = level(decision.effort) - level(sample.expected);
    if (gap === 0) exact += 1;
    if (Math.abs(gap) <= 1) near += 1;
    if (gap < 0) under += 1;
    excess += gap;
    if (decision.effort !== sample.raw) changed += 1;
    const key = `${sample.expected}->${decision.effort}`;
    final[key] = (final[key] ?? 0) + 1;
  }
  const n = samples.length;
  return {
    exact: exact / n,
    near: near / n,
    under: under / n,
    excess: excess / n,
    changed: changed / n,
    final,
  };
}

// The policy knobs the plugin exposes.
const POLICIES = [
  { name: "shipped (0.1 / 0.2)", minConfidence: 0.1, stakesThreshold: 0.2 },
  { name: "previous (0.35 / 0.7)", minConfidence: 0.35, stakesThreshold: 0.7 },
  { name: "no fallback (0 / 0.2)", minConfidence: 0, stakesThreshold: 0.2 },
  {
    name: "strict stakes (0.1 / 0.5)",
    minConfidence: 0.1,
    stakesThreshold: 0.5,
  },
];

// Choosing a threshold on the same prompts used to score it inflates the
// result. Split the corpus, pick the best policy on one half, and score it on
// the other, so the recommendation is measured out of sample.
function heldOutScore(train, test) {
  let best = null;
  for (let mc = 0; mc <= 0.5; mc += 0.05) {
    for (let st = 0.1; st <= 0.9; st += 0.1) {
      const r = evaluate(train, mc, st);
      const key = r.exact - r.under * 0.5;
      if (!best || key > best.key) {
        best = { mc, st, key };
      }
    }
  }
  const held = evaluate(test, best.mc, best.st);
  return { ...best, exact: held.exact, under: held.under };
}

const lines = [
  "# Calibration report",
  "",
  `Generated by \`node scripts/calibrate.mjs\` against ${endpoint}.`,
  `Corpus: ${rows.length} labelled prompts in \`calibration/corpus.jsonl\`.`,
  "",
];

for (const { name } of SPECS) {
  const samples = samplesBySpec.get(name);
  const n = samples.length;

  const rawExact = samples.filter((s) => s.raw === s.expected).length / n;
  const expectedMean =
    samples.reduce((sum, s) => sum + level(s.expected), 0) / n;
  const chosenMean = samples.reduce((sum, s) => sum + level(s.raw), 0) / n;
  const bias = chosenMean - expectedMean;
  const xhighRows = samples.filter((s) => s.expected === "xhigh");
  const xhighHit =
    xhighRows.filter((s) => s.raw === "xhigh").length / xhighRows.length;

  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const median = times[Math.floor(n / 2)];
  const p90 = times[Math.floor(n * 0.9)];

  const confusion = {};
  for (const sample of samples) {
    const key = `${sample.expected}->${sample.raw}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }

  const byExpected = EFFORT_ORDER.map((label) => {
    const group = samples.filter((s) => s.expected === label);
    return {
      label,
      count: group.length,
      chosen: group.length
        ? group.reduce((sum, s) => sum + level(s.raw), 0) / group.length
        : 0,
    };
  });

  const risky = samples.filter((s) => s.stakes);
  const riskyRaw =
    risky.filter((s) => s.raw === s.expected).length / risky.length;

  // Does confidence predict correctness at all? If it does not, a confidence
  // gate only discards right answers.
  const right = samples.filter((s) => s.raw === s.expected);
  const wrong = samples.filter((s) => s.raw !== s.expected);
  const meanOf = (group) =>
    group.length
      ? group.reduce((sum, s) => sum + s.confidence, 0) / group.length
      : 0;
  const rightConfidence = meanOf(right);
  const wrongConfidence = meanOf(wrong);

  const stakesCurve = [];
  for (let t = 0.1; t <= 0.91; t += 0.1) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const sample of samples) {
      const said = sample.highStakes >= t;
      if (said && sample.stakes) tp += 1;
      else if (said && !sample.stakes) fp += 1;
      else if (!said && sample.stakes) fn += 1;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 =
      precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    stakesCurve.push({
      t: Number(t.toFixed(1)),
      precision,
      recall,
      f1,
      fp,
      fn,
    });
  }
  const bestStakes = [...stakesCurve].sort((a, b) => b.f1 - a.f1)[0];

  lines.push(
    `## ${name}`,
    "",
    `- Exact level match: **${pct(rawExact)}**`,
    `- Mean level chosen ${chosenMean.toFixed(2)} vs expected ` +
      `${expectedMean.toFixed(2)} (bias ${signed(bias)} levels)`,
    `- xhigh prompts the model also called xhigh: **${pct(xhighHit)}**`,
    `- On the ${risky.length} dangerous prompts, raw exactness ` +
      `${pct(riskyRaw)}`,
    `- Mean confidence when right ${rightConfidence.toFixed(2)} vs wrong ` +
      `${wrongConfidence.toFixed(2)}`,
    `- Latency: median ${median.toFixed(0)} ms, p90 ${p90.toFixed(0)} ms`,
    "",
    "Confusion (expected -> chosen):",
    "",
    "| expected | chosen | count |",
    "| --- | --- | --- |",
    ...Object.entries(confusion)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => {
        const [from, to] = key.split("->");
        return `| ${from} | ${to} | ${count} |`;
      }),
    "",
    "Mean level chosen per expected level (below the label means under-rated):",
    "",
    "| expected | prompts | mean chosen |",
    "| --- | --- | --- |",
    ...byExpected.map(
      (row) => `| ${row.label} | ${row.count} | ${row.chosen.toFixed(2)} |`,
    ),
    "",
    "Stakes detection (dangerous vs ordinary prompts):",
    "",
    "| threshold | precision | recall | F1 | false positives | misses |",
    "| --- | --- | --- | --- | --- | --- |",
    ...stakesCurve.map(
      (row) =>
        `| ${row.t.toFixed(1)} | ${pct(row.precision)} | ` +
        `${pct(row.recall)} | ${row.f1.toFixed(2)} | ${row.fp} | ` +
        `${row.fn} |`,
    ),
    "",
    `Best F1 ${bestStakes.f1.toFixed(2)} at ${bestStakes.t.toFixed(1)}.`,
    "",
    "Policy fit (`changed` is the share of prompts whose final level differs",
    "from the raw answer, the cost of the policy in work done):",
    "",
    "| policy | minConfidence | stakes | exact | within one | " +
      "under-powered | mean excess | changed |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...POLICIES.map((policy) => {
      const r = evaluate(
        samples,
        policy.minConfidence,
        policy.stakesThreshold,
      );
      return (
        `| ${policy.name} | ${policy.minConfidence} | ` +
        `${policy.stakesThreshold} | ${pct(r.exact)} | ${pct(r.near)} | ` +
        `${pct(r.under)} | ${signed(r.excess)} | ${pct(r.changed)} |`
      );
    }),
    "",
    "Confidence gate sweep on the shipped wording (stakes fixed at 0.2):",
    "",
    "| minConfidence | exact | within one | under-powered | " +
      "mean excess | changed |",
    "| --- | --- | --- | --- | --- | --- |",
    ...[0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4].map((mc) => {
      const r = evaluate(samples, mc, 0.2);
      return (
        `| ${mc.toFixed(2)} | ${pct(r.exact)} | ${pct(r.near)} | ` +
        `${pct(r.under)} | ${signed(r.excess)} | ${pct(r.changed)} |`
      );
    }),
    "",
    "Held-out check: the best policy is picked on even-indexed prompts and",
    "scored on odd-indexed ones, so the number is not fitted to its own test:",
    "",
    ...(() => {
      const train = samples.filter((_, i) => i % 2 === 0);
      const test = samples.filter((_, i) => i % 2 === 1);
      const r = heldOutScore(train, test);
      return [
        `- picked minConfidence ${r.mc.toFixed(2)}, stakes ${r.st.toFixed(1)}`,
        `- on the other half: exact ${pct(r.exact)}, ` +
          `under-powered ${pct(r.under)}`,
        `- shipped policy on the same half: exact ` +
          `${pct(evaluate(test, 0.1, 0.2).exact)}, under-powered ` +
          `${pct(evaluate(test, 0.1, 0.2).under)}`,
      ];
    })(),
    "",
    "Final-level distribution under the shipped policy:",
    "",
    "| expected | final | count |",
    "| --- | --- | --- |",
    ...Object.entries(evaluate(samples, 0.1, 0.2).final)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => {
        const [from, to] = key.split("->");
        return `| ${from} | ${to} | ${count} |`;
      }),
    "",
  );

  console.log(
    `${name}: raw exact ${pct(rawExact)}, bias ${signed(bias)}, ` +
      `xhigh hit ${pct(xhighHit)}, best stakes ${bestStakes.t.toFixed(1)}`,
  );
}

await writeFile(REPORT, lines.join("\n"));
console.log(`report:  ${REPORT}`);