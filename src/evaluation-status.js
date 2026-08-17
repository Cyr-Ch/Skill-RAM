import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

async function json(target, fallback = null) {
  try { return JSON.parse(await readFile(target, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function findNamed(root, name, found = []) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return found;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await findNamed(target, name, found);
    else if (entry.name === name) found.push(target);
  }
  return found;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function totalFromDataRoot(dataRoot, dataset, partition) {
  if (!dataRoot) return null;
  if (dataset === 'skillrouter') return (await json(path.join(dataRoot, 'manifest.json')))?.[partition]?.records ?? null;
  const candidates = [path.join(dataRoot, 'data', 'skills', `${partition}.jsonl`), path.join(dataRoot, 'skills', `${partition}.jsonl`)];
  for (const candidate of candidates) {
    try { return (await readFile(candidate, 'utf8')).split(/\r?\n/).filter(Boolean).length; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

export async function evaluationStatus(stateDir, { dataRoot } = {}) {
  const cacheRoot = path.join(stateDir, 'evaluations', 'cache', 'skillrouter');
  const stateFiles = await findNamed(cacheRoot, 'pool-state.json');
  const evaluations = [];
  for (const stateFile of stateFiles.sort()) {
    const directory = path.dirname(stateFile);
    const pool = await json(stateFile, {});
    const run = await json(path.join(directory, 'run.json'), {});
    const metadata = await stat(stateFile);
    const dataset = run.dataset ?? pool.dataset ?? 'skillrouter';
    const partition = run.partition ?? pool.partition ?? pool.tier ?? 'unknown';
    const total = pool.total ?? run.skills ?? await totalFromDataRoot(dataRoot, dataset, partition);
    const completed = pool.completed ?? 0;
    const alive = processAlive(run.pid);
    const recentlyUpdated = Date.now() - metadata.mtimeMs < 10 * 60 * 1000;
    const embeddingComplete = Number.isFinite(total) && completed >= total;
    const output = run.output ?? path.join(stateDir, 'evaluations', `${dataset}-${partition}-predictions.json`);
    const checkpoint = await json(`${output}.checkpoint.json`, {});
    const queries = await json(path.join(directory, 'queries.json'));
    const tasks = run.tasks ?? checkpoint.taskIds?.length ?? queries?.taskIds?.length ?? null;
    const rerankComplete = Number.isFinite(tasks) && (checkpoint.completed ?? 0) >= tasks;
    const complete = run.status === 'complete' || (embeddingComplete && rerankComplete);
    const status = complete ? 'complete' : alive ? 'running' : recentlyUpdated ? 'recently-active' : 'paused';
    evaluations.push({
      dataset, partition, status, phase: alive ? run.phase : undefined,
      completed, total, percent: Number.isFinite(total) && total > 0 ? completed / total : null,
      queryCache: Boolean(queries),
      rerankedTasks: checkpoint.completed ?? 0, tasks,
      updatedAt: pool.updatedAt ?? run.updatedAt ?? metadata.mtime.toISOString(), cacheDir: directory,
    });
  }
  return { stateDir, evaluations };
}

export function formatEvaluationStatus(report) {
  if (!report.evaluations.length) return 'No cached public evaluations found.';
  return ['SkillRAM public evaluation status', ...report.evaluations.map((item) => {
    const progress = item.total ? `${item.completed.toLocaleString()}/${item.total.toLocaleString()} (${(item.percent * 100).toFixed(1)}%)` : `${item.completed.toLocaleString()} skills`;
    const tasks = item.tasks ? ` · reranked ${item.rerankedTasks}/${item.tasks}` : '';
    const phase = item.phase ? ` · ${item.phase}` : '';
    return `${item.dataset}/${item.partition}: ${item.status}${phase} · embedded ${progress}${tasks} · queries ${item.queryCache ? 'cached' : 'pending'}`;
  })].join('\n');
}
