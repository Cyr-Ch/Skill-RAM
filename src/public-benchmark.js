import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function dcg(ids, relevance, k) {
  return ids.slice(0, k).reduce((sum, id, position) => sum + ((2 ** Number(relevance[id] ?? 0)) - 1) / Math.log2(position + 2), 0);
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

function retrievalMetrics(ranked, expected, graded, k) {
  const first = ranked.findIndex((id) => expected.has(id));
  const top = ranked.slice(0, k);
  const found = top.filter((id) => expected.has(id)).length;
  let relevantSeen = 0;
  let precisionSum = 0;
  for (let position = 0; position < top.length; position += 1) {
    if (!expected.has(top[position])) continue;
    relevantSeen += 1;
    precisionSum += relevantSeen / (position + 1);
  }
  const ideal = Object.values(graded).map(Number).sort((left, right) => right - left).slice(0, k);
  const idealDcg = ideal.reduce((sum, score, position) => sum + ((2 ** score) - 1) / Math.log2(position + 2), 0);
  return {
    hit1: Number(expected.has(ranked[0])),
    recallAtK: found / expected.size,
    precisionAtK: found / k,
    mrr: first === -1 ? 0 : 1 / (first + 1),
    ndcgAtK: idealDcg ? dcg(ranked, graded, k) / idealDcg : 0,
    mapAtK: precisionSum / Math.min(expected.size, k),
    completenessAtK: Number(found === expected.size),
  };
}

async function readJsonl(target) {
  const buffer = await readFile(target);
  const text = target.endsWith('.gz') ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
  return { text, rows: text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) };
}

async function skillRetFile(dataRoot, kind, split) {
  const candidates = [
    path.join(dataRoot, 'data', kind, `${split}.jsonl`),
    path.join(dataRoot, 'data', kind, `${split}.jsonl.gz`),
    path.join(dataRoot, kind, `${split}.jsonl`),
    path.join(dataRoot, kind, `${split}.jsonl.gz`),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return candidates[0];
}

export async function detectPublicDataset(dataRoot, requested = 'auto') {
  if (requested !== 'auto') return requested;
  if (await exists(path.join(dataRoot, 'relevance.json'))) return 'skillrouter';
  for (const candidate of [
    path.join(dataRoot, 'data', 'qrels', 'test.jsonl'), path.join(dataRoot, 'data', 'qrels', 'test.jsonl.gz'),
    path.join(dataRoot, 'qrels', 'test.jsonl'), path.join(dataRoot, 'qrels', 'test.jsonl.gz'),
  ]) {
    if (await exists(candidate)) return 'skillret';
  }
  throw new Error('Could not detect the public dataset. Use --dataset skillrouter or --dataset skillret.');
}

export async function scoreSkillRouterPredictions(dataRoot, predictionsFile, { tier = 'easy', k = 10 } = {}) {
  const relevanceText = await readFile(path.join(dataRoot, 'relevance.json'), 'utf8');
  const predictionsText = await readFile(predictionsFile, 'utf8');
  const relevance = JSON.parse(relevanceText);
  const predictions = JSON.parse(predictionsText);
  const results = [];
  for (const [taskId, labels] of Object.entries(relevance)) {
    if (labels.task_type === 'generic_only') continue;
    const expected = new Set(labels.core_gt_ids ?? labels.gt_skill_ids ?? []);
    if (!expected.size) continue;
    const ranked = predictions[taskId] ?? [];
    if (!Array.isArray(ranked)) throw new Error(`Predictions for ${taskId} must be an array.`);
    const graded = labels.relevance ?? Object.fromEntries([...expected].map((id) => [id, 1]));
    results.push({ taskId, ...retrievalMetrics(ranked, expected, graded, k) });
  }
  if (!results.length) throw new Error('No scorable SkillRouter Eval Core tasks were found.');
  const report = {
    benchmark: 'SkillRouter-Eval-Core', tier, k, cases: results.length,
    hit1: mean(results.map(({ hit1 }) => hit1)),
    recallAtK: mean(results.map(({ recallAtK }) => recallAtK)),
    precisionAtK: mean(results.map(({ precisionAtK }) => precisionAtK)),
    mrr: mean(results.map(({ mrr }) => mrr)),
    ndcgAtK: mean(results.map(({ ndcgAtK }) => ndcgAtK)),
    mapAtK: mean(results.map(({ mapAtK }) => mapAtK)),
    completenessAtK: mean(results.map(({ completenessAtK }) => completenessAtK)),
    relevanceSha256: createHash('sha256').update(relevanceText).digest('hex'),
    predictionsSha256: createHash('sha256').update(predictionsText).digest('hex'),
    predictionsFile,
    results,
  };
  try {
    const manifest = JSON.parse(await readFile(path.join(dataRoot, 'manifest.json'), 'utf8'));
    if (manifest.sample) report.sample = { ...manifest.sample, ...manifest.sampleStats };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return report;
}

export async function scoreSkillRetPredictions(dataRoot, predictionsFile, { split = 'test', k = 10 } = {}) {
  const qrelsFile = await skillRetFile(dataRoot, 'qrels', split);
  const { text: qrelsText, rows: qrels } = await readJsonl(qrelsFile);
  const predictionsText = await readFile(predictionsFile, 'utf8');
  const predictions = JSON.parse(predictionsText);
  const labels = new Map();
  for (const row of qrels) {
    if (Number(row.relevance) <= 0) continue;
    const queryId = String(row.query_id);
    if (!labels.has(queryId)) labels.set(queryId, new Set());
    labels.get(queryId).add(String(row.skill_id));
  }
  const results = [];
  for (const [queryId, expected] of labels) {
    const ranked = predictions[queryId] ?? [];
    if (!Array.isArray(ranked)) throw new Error(`Predictions for ${queryId} must be an array.`);
    const graded = Object.fromEntries([...expected].map((id) => [id, 1]));
    results.push({ taskId: queryId, ...retrievalMetrics(ranked.map(String), expected, graded, k) });
  }
  if (!results.length) throw new Error('No scorable SKILLRET queries were found.');
  return {
    benchmark: 'SKILLRET', split, k, cases: results.length,
    hit1: mean(results.map(({ hit1 }) => hit1)),
    recallAtK: mean(results.map(({ recallAtK }) => recallAtK)),
    precisionAtK: mean(results.map(({ precisionAtK }) => precisionAtK)),
    mrr: mean(results.map(({ mrr }) => mrr)),
    ndcgAtK: mean(results.map(({ ndcgAtK }) => ndcgAtK)),
    mapAtK: mean(results.map(({ mapAtK }) => mapAtK)),
    completenessAtK: mean(results.map(({ completenessAtK }) => completenessAtK)),
    relevanceSha256: createHash('sha256').update(qrelsText).digest('hex'),
    predictionsSha256: createHash('sha256').update(predictionsText).digest('hex'),
    predictionsFile,
    results,
  };
}

export async function scorePublicPredictions(dataRoot, predictionsFile, { dataset = 'auto', tier = 'easy', split = 'test', k = 10 } = {}) {
  const selected = await detectPublicDataset(dataRoot, dataset);
  const report = selected === 'skillret'
    ? scoreSkillRetPredictions(dataRoot, predictionsFile, { split, k })
    : scoreSkillRouterPredictions(dataRoot, predictionsFile, { tier, k });
  const resolved = await report;
  try {
    resolved.performance = JSON.parse(await readFile(`${predictionsFile}.metrics.json`, 'utf8'));
    if (resolved.performance.contextTokens) resolved.tokenUsage = resolved.performance.contextTokens;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return resolved;
}

export function formatPublicBenchmark(report) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const partition = report.tier ?? report.split;
  const lines = [
    `${report.benchmark} (${partition})`,
    ...(report.sample ? [`Development sample: ${report.sample.selectedTasks} tasks · ${report.sample.selectedSkills} skills · seed ${report.sample.seed}`] : []),
    `Cases: ${report.cases} · Hit@1: ${percent(report.hit1)} · MRR: ${report.mrr.toFixed(3)}`,
    `Recall@${report.k}: ${percent(report.recallAtK)} · Precision@${report.k}: ${percent(report.precisionAtK)} · nDCG@${report.k}: ${report.ndcgAtK.toFixed(3)}`,
    `MAP@${report.k}: ${report.mapAtK.toFixed(3)} · Completeness@${report.k}: ${percent(report.completenessAtK)}`,
    `Predictions: ${report.predictionsFile}`,
  ];
  if (report.tokenUsage) {
    const reduction = report.tokenUsage.estimatedReduction;
    const change = reduction >= 0
      ? `estimated ${(reduction * 100).toFixed(1)}% reduction`
      : `estimated ${(-reduction * 100).toFixed(1)}% increase`;
    lines.splice(-1, 0,
      `Skill context: ~${Math.round(report.tokenUsage.catalogTokensPerPromptBefore).toLocaleString()} → ~${Math.round(report.tokenUsage.meanLoadedInstructionTokensPerQuery).toLocaleString()} tokens/prompt (${change})`,
      `Across ${report.tokenUsage.queries} prompts: ~${Math.abs(Math.round(report.tokenUsage.estimatedTokensAvoided)).toLocaleString()} skill-context tokens ${report.tokenUsage.estimatedTokensAvoided >= 0 ? 'avoided' : 'added'}`,
    );
  }
  return lines.join('\n');
}
