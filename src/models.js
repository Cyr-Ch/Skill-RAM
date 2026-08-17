import { access, chmod, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStateDir } from './state.js';
import { defaultServiceIpc, defaultServiceSocket, localServiceHealth } from './local-http.js';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

function paths(stateDir) {
  const root = path.join(stateDir, 'models', 'skillrouter');
  const scripts = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts') : path.join(root, '.venv', 'bin');
  return {
    root,
    models: path.join(root, 'models'),
    python: path.join(scripts, process.platform === 'win32' ? 'python.exe' : 'python'),
    service: path.join(packageRoot, 'service', 'skillrouter_service.py'),
    evaluation: path.join(packageRoot, 'service', 'eval_core.py'),
    sampleEvaluation: path.join(packageRoot, 'service', 'sample_eval_core.py'),
    download: path.join(packageRoot, 'service', 'download_models.py'),
    requirements: path.join(packageRoot, 'service', 'requirements.txt'),
  };
}

async function installed(modelPaths) {
  return await exists(modelPaths.python)
    && await exists(path.join(modelPaths.models, 'embedding', 'config.json'))
    && await exists(path.join(modelPaths.models, 'reranker', 'config.json'));
}

async function resolveModelPaths(stateDir, sharedStateDir = resolveStateDir()) {
  const requested = paths(stateDir);
  if (await installed(requested)) return { modelPaths: requested, sharedFallback: false, requestedRoot: requested.root };
  const shared = paths(sharedStateDir);
  if (path.resolve(shared.root) !== path.resolve(requested.root) && await installed(shared)) {
    return { modelPaths: shared, sharedFallback: true, requestedRoot: requested.root };
  }
  return { modelPaths: requested, sharedFallback: false, requestedRoot: requested.root };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${signal ?? `code ${code}`}`)));
  });
}

async function runningService(stateDir, host, port, fetchImpl = globalThis.fetch, socketPath = defaultServiceSocket(), ipcRoot = defaultServiceIpc(stateDir)) {
  const address = host.includes(':') ? `[${host}]` : host;
  const health = await localServiceHealth({ ipcRoot, socketPath, healthUrl: `http://${address}:${port}/health`, fetchImpl, timeout: 800 });
  return health?.ok && (health.service === 'skillram-skillrouter' || 'embeddingLoaded' in health) ? health : null;
}

export async function installSkillRouterModels(stateDir, { python = process.env.SKILLRAM_PYTHON ?? 'python3' } = {}) {
  const modelPaths = paths(stateDir);
  await mkdir(modelPaths.root, { recursive: true, mode: 0o700 });
  await chmod(modelPaths.root, 0o700);
  if (!await exists(modelPaths.python)) await run(python, ['-m', 'venv', path.join(modelPaths.root, '.venv')]);
  await run(modelPaths.python, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  await run(modelPaths.python, ['-m', 'pip', 'install', '-r', modelPaths.requirements]);
  await run(modelPaths.python, [modelPaths.download, '--output', modelPaths.models]);
  return modelStatus(stateDir);
}

export async function modelStatus(stateDir, { fetchImpl = globalThis.fetch, sharedStateDir = resolveStateDir() } = {}) {
  const resolved = await resolveModelPaths(stateDir, sharedStateDir);
  const { modelPaths } = resolved;
  const isInstalled = await installed(modelPaths);
  let service = null;
  let manifest = null;
  try { manifest = JSON.parse(await readFile(path.join(modelPaths.models, 'manifest.json'), 'utf8')); } catch {}
  service = await localServiceHealth({ ipcRoot: defaultServiceIpc(stateDir), fetchImpl, timeout: 800 });
  return { installed: isInstalled, service, manifest, root: modelPaths.root, requestedRoot: resolved.requestedRoot, sharedFallback: resolved.sharedFallback, python: modelPaths.python };
}

export async function serveSkillRouter(stateDir, { host = '127.0.0.1', port = 8765, fetchImpl = globalThis.fetch, serviceSocket = defaultServiceSocket(), serviceIpc = defaultServiceIpc(stateDir) } = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('The model service may only bind to a loopback host.');
  const active = await runningService(stateDir, host, port, fetchImpl, serviceSocket, serviceIpc);
  if (active) {
    if (active.transport !== 'file-ipc' && Number(active.protocol ?? 0) < 2) throw new Error('An older SkillRAM model service is running without hook-safe IPC. Stop it, then run “skillram serve” again.');
    return { alreadyRunning: true, health: active };
  }
  const status = await modelStatus(stateDir);
  if (!status.installed) throw new Error('SkillRouter models are not installed. Run “skillram models install skillrouter” first.');
  const modelPaths = paths(path.dirname(path.dirname(status.root)));
  const args = [modelPaths.service, '--host', host, '--port', String(port), '--models', modelPaths.models];
  if (serviceSocket) args.push('--socket', serviceSocket);
  if (serviceIpc) args.push('--ipc', serviceIpc);
  await run(modelPaths.python, args);
  return { alreadyRunning: false };
}

export async function createSkillRouterEvalSample(stateDir, dataRoot, { tier = 'easy', sampleTasks = 30, sampleSkills = 1000, sampleSeed = 'skillram-dev-v1', output } = {}) {
  const status = await modelStatus(stateDir);
  if (!status.installed) throw new Error('SkillRouter models are not installed. Run “skillram models install skillrouter” first.');
  const modelPaths = paths(path.dirname(path.dirname(status.root)));
  const identity = createHash('sha256').update(`${path.resolve(dataRoot)}\0${tier}\0${sampleTasks}\0${sampleSkills}\0${sampleSeed}`).digest('hex').slice(0, 10);
  const target = path.resolve(output ?? path.join(stateDir, 'evaluations', 'datasets', `skillrouter-${tier}-${sampleTasks}t-${sampleSkills}s-${identity}`));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await run(modelPaths.python, [
    modelPaths.sampleEvaluation, '--data-root', path.resolve(dataRoot), '--output', target,
    '--tier', tier, '--sample-tasks', String(sampleTasks), '--sample-skills', String(sampleSkills), '--seed', sampleSeed,
  ]);
  return target;
}

export async function runSkillRouterEval(stateDir, dataRoot, { dataset = 'skillrouter', tier = 'easy', split = 'test', retrievalK = 20, embeddingBatchSize, checkpointEvery = 512, loadK = 2, cacheDir, output } = {}) {
  const status = await modelStatus(stateDir);
  if (!status.installed) throw new Error('SkillRouter models are not installed. Run “skillram models install skillrouter” first.');
  if (status.service?.ok) throw new Error('Stop “skillram serve” before eval-public so the benchmark can use the model memory. Restart it after evaluation.');
  const modelPaths = paths(path.dirname(path.dirname(status.root)));
  const partition = dataset === 'skillret' ? split : tier;
  const target = output ?? path.join(stateDir, 'evaluations', `${dataset}-${partition}-predictions.json`);
  const evaluationCache = cacheDir ? path.resolve(cacheDir) : path.join(stateDir, 'evaluations', 'cache', 'skillrouter');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(evaluationCache, { recursive: true, mode: 0o700 });
  const args = [
    modelPaths.evaluation,
    '--data-root', path.resolve(dataRoot), '--tier', tier,
    '--dataset', dataset, '--split', split,
    '--models', modelPaths.models, '--output', target,
    '--cache-dir', evaluationCache, '--retrieval-k', String(retrievalK),
    '--checkpoint-every', String(checkpointEvery), '--load-k', String(loadK),
  ];
  if (embeddingBatchSize !== undefined) args.push('--batch-size', String(embeddingBatchSize));
  await run(modelPaths.python, args);
  return target;
}
