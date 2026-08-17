import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { loadIndex } from './state.js';
import { routePrompt } from './runtime.js';
import { routerConfiguration } from './hybrid-router.js';
import { loadRetrievalManifest } from './retrieval-index.js';

const SYNTHETIC_NEGATIVES = ['What is two plus two?', 'Book a flight for next Tuesday.', 'Tell me a short joke.'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(results) {
  const totals = results.reduce((summary, result) => ({
    truePositive: summary.truePositive + result.truePositive,
    falsePositive: summary.falsePositive + result.falsePositive,
    falseNegative: summary.falseNegative + result.falseNegative,
    exact: summary.exact + Number(result.pass),
    forbidden: summary.forbidden + result.forbiddenSelected.length,
  }), { truePositive: 0, falsePositive: 0, falseNegative: 0, exact: 0, forbidden: 0 });
  const positive = results.filter((result) => result.expected.length);
  const negative = results.filter((result) => !result.expected.length);
  return {
    cases: results.length,
    exactMatches: totals.exact,
    accuracy: results.length ? totals.exact / results.length : 1,
    precision: totals.truePositive + totals.falsePositive ? totals.truePositive / (totals.truePositive + totals.falsePositive) : 1,
    recall: totals.truePositive + totals.falseNegative ? totals.truePositive / (totals.truePositive + totals.falseNegative) : 1,
    falseActivations: totals.falsePositive,
    missedActivations: totals.falseNegative,
    forbiddenActivations: totals.forbidden,
    hitAt1: positive.length ? positive.filter((result) => result.expected.includes(result.selected[0])).length / positive.length : 1,
    hitAtK: positive.length ? positive.filter((result) => result.selected.some((id) => result.expected.includes(id))).length / positive.length : 1,
    meanReciprocalRank: positive.length ? positive.reduce((sum, result) => {
      const position = result.selected.findIndex((id) => result.expected.includes(id));
      return sum + (position === -1 ? 0 : 1 / (position + 1));
    }, 0) / positive.length : 1,
    noSkillAccuracy: negative.length ? negative.filter((result) => result.selected.length === 0).length / negative.length : 1,
    falseActivationRate: negative.length ? negative.filter((result) => result.selected.length > 0).length / negative.length : 0,
  };
}

async function loadCases(file, index) {
  if (!file) return {
    source: 'synthetic-smoke', synthetic: true,
    cases: [
      ...index.entries.map((entry) => ({ id: `self-${entry.id}`, prompt: `${entry.name}: ${entry.description}`, expected: [entry.id], tags: ['synthetic', 'positive'] })),
      ...SYNTHETIC_NEGATIVES.map((prompt, position) => ({ id: `negative-${position + 1}`, prompt, expected: [], tags: ['synthetic', 'negative'] })),
    ],
  };
  const lines = (await readFile(file, 'utf8')).split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Benchmark file contains no cases.');
  return { source: file, synthetic: false, cases: lines.map((line, number) => {
    try { return { ...JSON.parse(line), line: number + 1 }; }
    catch (error) { throw new Error(`Invalid JSON on benchmark line ${number + 1}: ${error.message}`); }
  }) };
}

function validateCases(cases, index, top) {
  const known = new Map(index.entries.flatMap((entry) => [[entry.id, entry.id], [entry.name, entry.id]]));
  const prompts = new Set();
  const ids = new Set();
  return cases.map((item, position) => {
    const location = item.line ? `line ${item.line}` : `case ${position + 1}`;
    if (typeof item.prompt !== 'string' || !item.prompt.trim()) throw new Error(`Benchmark ${location} requires a non-empty prompt.`);
    if (!Array.isArray(item.expected) || !item.expected.every((value) => typeof value === 'string')) throw new Error(`Benchmark ${location} requires an expected string array.`);
    if (item.forbidden !== undefined && (!Array.isArray(item.forbidden) || !item.forbidden.every((value) => typeof value === 'string'))) throw new Error(`Benchmark ${location} forbidden must be a string array.`);
    if (item.tags !== undefined && (!Array.isArray(item.tags) || !item.tags.every((value) => typeof value === 'string'))) throw new Error(`Benchmark ${location} tags must be a string array.`);
    const promptKey = item.prompt.trim().toLowerCase();
    if (prompts.has(promptKey)) throw new Error(`Duplicate benchmark prompt at ${location}.`);
    prompts.add(promptKey);
    const id = item.id ?? `case-${position + 1}`;
    if (ids.has(id)) throw new Error(`Duplicate benchmark id: ${id}.`);
    ids.add(id);
    const resolve = (value) => {
      if (!known.has(value)) throw new Error(`Unknown skill “${value}” at benchmark ${location}.`);
      return known.get(value);
    };
    const expected = [...new Set(item.expected.map(resolve))];
    const forbidden = [...new Set((item.forbidden ?? []).map(resolve))];
    if (expected.length > top) throw new Error(`Benchmark ${location} expects ${expected.length} skills but --top is ${top}.`);
    if (expected.some((value) => forbidden.includes(value))) throw new Error(`Benchmark ${location} lists the same skill as expected and forbidden.`);
    return { id, prompt: item.prompt.trim(), expected, forbidden, tags: [...new Set(item.tags ?? [])] };
  });
}

export async function runBenchmark(stateDir, { file, provider = 'all', top = 2, runs = 1, ...routerOptions } = {}) {
  const index = await loadIndex(stateDir);
  const retrievalManifest = await loadRetrievalManifest(stateDir);
  const suite = await loadCases(file, index);
  const inputs = validateCases(suite.cases, index, top);
  const results = [];
  const methodCounts = {};
  let loadedTokens = 0;
  for (const item of inputs) {
    for (let run = 1; run <= runs; run += 1) {
      const started = performance.now();
      const routed = await routePrompt(stateDir, item.prompt, { provider, top, ...routerOptions });
      const latencyMs = performance.now() - started;
      const selected = routed.map(({ entry }) => entry.id);
      const actual = new Set(selected);
      const expected = new Set(item.expected);
      const truePositive = selected.filter((id) => expected.has(id)).length;
      const falsePositive = selected.filter((id) => !expected.has(id)).length;
      const falseNegative = item.expected.filter((id) => !actual.has(id)).length;
      const forbiddenSelected = item.forbidden.filter((id) => actual.has(id));
      const pass = falsePositive === 0 && falseNegative === 0 && forbiddenSelected.length === 0;
      const methods = [...new Set(routed.map(({ method }) => method ?? 'lexical'))];
      for (const method of methods.length ? methods : ['none']) methodCounts[method] = (methodCounts[method] ?? 0) + 1;
      const instructionTokens = routed.reduce((sum, { entry }) => sum + entry.fullTokens, 0);
      loadedTokens += instructionTokens;
      results.push({ ...item, run, selected, methods, pass, truePositive, falsePositive, falseNegative, forbiddenSelected, instructionTokens, latencyMs: Math.round(latencyMs * 100) / 100 });
    }
  }
  const summary = summarize(results);
  const tags = [...new Set(results.flatMap((result) => result.tags))];
  const byTag = Object.fromEntries(tags.map((tag) => [tag, summarize(results.filter((result) => result.tags.includes(tag))) ]));
  const eligibleEntries = index.entries.filter((entry) => provider === 'all' || entry.provider === provider || entry.provider === 'all');
  const activationBefore = eligibleEntries.reduce((sum, entry) => sum + entry.activationTokens, 0);
  const latencies = results.map(({ latencyMs }) => latencyMs);
  const stableCases = inputs.filter((item) => new Set(results.filter((result) => result.id === item.id).map((result) => JSON.stringify(result.selected))).size === 1).length;
  return {
    source: suite.source, synthetic: suite.synthetic, ...summary, byTag, methodCounts,
    generatedAt: new Date().toISOString(),
    datasetSha256: sha256(JSON.stringify(inputs)),
    indexSha256: sha256(JSON.stringify(index.entries.map(({ id, provider: entryProvider, name, description, activationTokens, fullTokens }) => ({ id, provider: entryProvider, name, description, activationTokens, fullTokens })))),
    retrievalIndexSha256: retrievalManifest ? sha256(JSON.stringify(retrievalManifest)) : null,
    datasetCases: inputs.length, runs, stability: inputs.length ? stableCases / inputs.length : 1,
    latencyMs: { median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(0, ...latencies) },
    router: { provider, top, mode: routerOptions.router ?? 'hybrid', ...routerConfiguration(routerOptions) },
    estimatedActivationTokensBefore: activationBefore, estimatedActivationTokensAfter: 0, estimatedActivationTokensAvoided: activationBefore,
    selectedInstructionTokensAcrossSuite: loadedTokens,
    meanSelectedInstructionTokens: results.length ? loadedTokens / results.length : 0,
    memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10,
    results,
  };
}

export function formatBenchmark(report) {
  const percent = (value) => `${Math.round(value * 100)}%`;
  return [
    `SkillRAM benchmark (${report.source})${report.synthetic ? ' — smoke test, not a production accuracy claim' : ''}`,
    `Dataset: ${report.datasetCases} cases × ${report.runs} run${report.runs === 1 ? '' : 's'} · Accuracy: ${percent(report.accuracy)} · Stability: ${percent(report.stability)}`,
    `Precision: ${percent(report.precision)} · Recall: ${percent(report.recall)}`,
    `Hit@1: ${percent(report.hitAt1)} · Hit@${report.router.top}: ${percent(report.hitAtK)} · MRR: ${report.meanReciprocalRank.toFixed(3)} · No-skill: ${percent(report.noSkillAccuracy)}`,
    `False activations: ${report.falseActivations} · Missed: ${report.missedActivations} · Forbidden: ${report.forbiddenActivations}`,
    `Latency: ${report.latencyMs.median}ms median · ${report.latencyMs.p95}ms p95`,
    `Methods: ${Object.entries(report.methodCounts).map(([method, count]) => `${method}=${count}`).join(' · ')}`,
    `Activation catalog: ~${report.estimatedActivationTokensBefore} → ~0 tokens`,
    `Selected instructions: ~${report.selectedInstructionTokensAcrossSuite} total · ~${Math.round(report.meanSelectedInstructionTokens)} mean/case`,
  ].join('\n');
}

export async function writeBenchmarkSvg(report, output) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
  const percent = Math.round(report.accuracy * 100);
  const label = report.synthetic ? 'SYNTHETIC SMOKE BENCHMARK' : 'LABELED ROUTING BENCHMARK';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#0b0d10"/><text x="80" y="105" fill="#8cff98" font-family="monospace" font-size="34">SKILLRAM · ${label}</text><text x="80" y="205" fill="white" font-family="monospace" font-size="64">${escape(percent)}% routing accuracy</text><text x="80" y="295" fill="#b8bec9" font-family="monospace" font-size="30">${escape(report.cases)} cases · ${escape(report.falseActivations)} false · ${escape(report.missedActivations)} missed · ${escape(report.forbiddenActivations)} forbidden</text><text x="80" y="390" fill="white" font-family="monospace" font-size="38">~${escape(report.estimatedActivationTokensAvoided)} catalog tokens avoided</text><text x="80" y="535" fill="#8cff98" font-family="monospace" font-size="26">Install every skill. Load only what the task needs.</text></svg>`;
  await writeFile(output, svg, 'utf8');
  return output;
}
