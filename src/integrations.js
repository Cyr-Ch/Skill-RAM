import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadState, readJson, saveState, statePaths } from './state.js';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.skillram-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

async function installRuntime(stateDir) {
  const runtime = statePaths(stateDir).runtime;
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await cp(path.join(packageRoot, 'src'), path.join(runtime, 'src'), { recursive: true, force: true });
  await cp(path.join(packageRoot, 'bin'), path.join(runtime, 'bin'), { recursive: true, force: true });
  await cp(path.join(packageRoot, 'service'), path.join(runtime, 'service'), { recursive: true, force: true });
  await cp(path.join(packageRoot, 'package.json'), path.join(runtime, 'package.json'), { force: true });
  return path.join(runtime, 'bin', 'skillram.js');
}

function addHook(config, command, provider, additionalContextLimit, timeout) {
  config.hooks ??= {};
  for (const event of ['UserPromptSubmit', 'PostCompact', 'SessionEnd']) {
    config.hooks[event] ??= [];
    const exists = config.hooks[event].some((group) => group.hooks?.some((hook) => hook.command === command));
    if (!exists) config.hooks[event].push({ hooks: [{
      type: 'command', command, timeout,
      statusMessage: event === 'UserPromptSubmit' ? 'SkillRAM: loading relevant skills' : event === 'PostCompact' ? 'SkillRAM: restoring active skills' : 'SkillRAM: clearing session cache',
      ...(provider === 'codex' && event !== 'SessionEnd' ? { additionalContextLimit } : {}),
    }] });
  }
  return config;
}

function removeHook(config, command) {
  if (!config.hooks) return config;
  for (const event of ['UserPromptSubmit', 'PostCompact', 'SessionEnd']) {
    const groups = config.hooks[event];
    if (!Array.isArray(groups)) continue;
    config.hooks[event] = groups.map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => hook.command !== command) })).filter((group) => group.hooks.length);
    if (!config.hooks[event].length) delete config.hooks[event];
  }
  if (!Object.keys(config.hooks).length) delete config.hooks;
  return config;
}

function runtimeFlags(options) {
  const flags = [];
  const mappings = [
    ['router', '--router'], ['routerLlm', '--router-llm'], ['embeddingUrl', '--embedding-url'], ['embeddingModel', '--embedding-model'],
    ['reranker', '--reranker'], ['rerankerUrl', '--reranker-url'], ['retrievalK', '--retrieval-k'], ['rerankThreshold', '--rerank-threshold'],
    ['rerankerTimeout', '--reranker-timeout'], ['embeddingTimeout', '--embedding-timeout'],
    ['semanticThreshold', '--semantic-threshold'], ['semanticMargin', '--semantic-margin'], ['lexicalScore', '--lexical-score'],
    ['lexicalMargin', '--lexical-margin'], ['chunkChars', '--chunk-chars'], ['chunkOverlap', '--chunk-overlap'],
    ['embeddingBatchSize', '--embedding-batch-size'], ['minConfidence', '--min-confidence'],
    ['minScore', '--min-score'], ['nameWeight', '--name-weight'], ['descriptionWeight', '--description-weight'],
    ['exactNameWeight', '--exact-name-weight'],
  ];
  for (const [key, flag] of mappings) if (options[key] !== undefined) flags.push(flag, shellQuote(options[key]));
  if (options.embeddings === false) flags.push('--no-embeddings');
  if (options.allowCloudBodies) flags.push('--allow-cloud-bodies');
  if (options.strictRouter) flags.push('--strict-router');
  return flags.join(' ');
}

export async function installIntegrations(stateDir, { provider = 'all', home = os.homedir(), additionalContextLimit = 8000, ...routeOptions } = {}) {
  const state = await loadState(stateDir);
  if (!state.moves.length) throw new Error('Create the vault before installing integrations.');
  const runtimeBin = await installRuntime(stateDir);
  const providers = provider === 'all' ? ['claude', 'codex'] : [provider];
  const hookTimeout = routeOptions.hookTimeout ?? (routeOptions.router === 'skillrouter' ? 60 : 10);
  const changes = [];
  try {
    for (const targetProvider of providers) {
      const file = targetProvider === 'claude'
        ? path.join(home, '.claude', 'settings.json')
        : path.join(home, '.codex', 'hooks.json');
      const previous = await readFile(file, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      const config = previous === null ? {} : await readJson(file, {});
      const flags = runtimeFlags(routeOptions);
      const command = `SKILLRAM_HOME=${shellQuote(stateDir)} ${shellQuote(process.execPath)} ${shellQuote(runtimeBin)} hook --provider ${targetProvider} --budget ${additionalContextLimit}${flags ? ` ${flags}` : ''}`;
      const prior = state.integrations?.find((integration) => integration.provider === targetProvider);
      if (prior?.command && prior.command !== command) removeHook(config, prior.command);
      await writeJsonAtomic(file, addHook(config, command, targetProvider, additionalContextLimit, hookTimeout));
      changes.push({ provider: targetProvider, file, command, previous });
    }
  } catch (error) {
    for (const change of changes.reverse()) {
      if (change.previous === null) await writeJsonAtomic(change.file, {});
      else await writeFile(change.file, change.previous, 'utf8');
    }
    throw new Error(`Integration installation rolled back: ${error.message}`);
  }
  const updated = changes.map(({ provider: itemProvider, file, command }) => ({ provider: itemProvider, file, command }));
  state.integrations = [...(state.integrations ?? []).filter((integration) => !providers.includes(integration.provider)), ...updated];
  await saveState(stateDir, state);
  return updated;
}

export async function removeIntegrations(stateDir) {
  const state = await loadState(stateDir);
  let removed = 0;
  for (const integration of state.integrations ?? []) {
    const config = await readJson(integration.file, null);
    if (!config) continue;
    await writeJsonAtomic(integration.file, removeHook(config, integration.command));
    removed += 1;
  }
  state.integrations = [];
  await saveState(stateDir, state);
  return removed;
}
