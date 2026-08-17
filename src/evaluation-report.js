import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function atomicJson(target, payload) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export async function saveEvaluationReport(stateDir, report) {
  const partition = report.tier ?? report.split ?? 'default';
  const target = path.join(stateDir, 'evaluations', 'reports', `${slug(report.benchmark)}-${slug(partition)}.json`);
  await atomicJson(target, report);
  return target;
}

function normalized(report, sourceFile) {
  if (report.benchmark) {
    return {
      kind: 'public-retrieval', benchmark: report.benchmark, partition: report.tier ?? report.split ?? 'default',
      cases: report.cases, k: report.k, hit1: report.hit1, recallAtK: report.recallAtK,
      precisionAtK: report.precisionAtK, mrr: report.mrr, ndcgAtK: report.ndcgAtK,
      mapAtK: report.mapAtK, completenessAtK: report.completenessAtK,
      predictionsSha256: report.predictionsSha256, performance: report.performance,
      tokenUsage: report.tokenUsage, sample: report.sample, sourceFile,
    };
  }
  if ('accuracy' in report && report.source) {
    return {
      kind: 'native-routing', benchmark: 'SkillRAM native', partition: report.source,
      cases: report.datasetCases ?? report.cases, accuracy: report.accuracy,
      precision: report.precision, recall: report.recall, stability: report.stability,
      latencyMs: report.latencyMs, datasetSha256: report.datasetSha256, sourceFile,
    };
  }
  throw new Error(`Unsupported evaluation report format: ${sourceFile}`);
}

export async function buildEvaluationReport(stateDir, files = []) {
  let selected = files.map((file) => path.resolve(file));
  if (!selected.length) {
    const directory = path.join(stateDir, 'evaluations', 'reports');
    try {
      selected = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort().map((name) => path.join(directory, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!selected.length) throw new Error('No evaluation reports found. Complete eval-public or pass report JSON files.');
  const reports = [];
  for (const file of selected) reports.push(normalized(JSON.parse(await readFile(file, 'utf8')), file));
  return { version: 1, generatedAt: new Date().toISOString(), reports };
}

export async function writeEvaluationReport(target, report) {
  await atomicJson(path.resolve(target), report);
}

function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

export function formatEvaluationReport(report) {
  const lines = ['SkillRAM evaluation report'];
  for (const item of report.reports) {
    if (item.kind === 'public-retrieval') {
      const duration = Number.isFinite(item.performance?.totalSeconds) ? ` · ${item.performance.totalSeconds.toFixed(1)}s` : '';
      const memory = Number.isFinite(item.performance?.peakRssMb) ? ` · peak ${item.performance.peakRssMb.toFixed(0)}MB` : '';
      const performance = `${duration}${memory}`;
      const tokens = Number.isFinite(item.tokenUsage?.estimatedReduction) ? ` · skill-context reduction ${percent(item.tokenUsage.estimatedReduction)}` : '';
      const sample = item.sample ? ' · development sample' : '';
      lines.push(`${item.benchmark} (${item.partition}): ${item.cases} cases${sample} · Hit@1 ${percent(item.hit1)} · Recall@${item.k} ${percent(item.recallAtK)} · MRR ${item.mrr?.toFixed(3) ?? '—'} · nDCG@${item.k} ${item.ndcgAtK?.toFixed(3) ?? '—'}${tokens}${performance}`);
    } else {
      lines.push(`${item.benchmark} (${item.partition}): ${item.cases} cases · Accuracy ${percent(item.accuracy)} · Precision ${percent(item.precision)} · Recall ${percent(item.recall)} · p95 ${item.latencyMs?.p95 ?? '—'}ms`);
    }
  }
  lines.push('Metrics from different benchmark families are shown side-by-side and are not averaged.');
  return lines.join('\n');
}
