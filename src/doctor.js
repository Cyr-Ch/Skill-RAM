import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadIndex, loadState, readJson, statePaths } from './state.js';
import { loadRetrievalManifest } from './retrieval-index.js';
import { modelStatus } from './models.js';

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

export async function runDoctor(stateDir, { fetchImpl = globalThis.fetch } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const state = await loadState(stateDir);
  const usesSkillRouter = (state.integrations ?? []).some(({ command }) => /--router(?:=|\s+)["']?skillrouter(?:["']?\s|$)/.test(command ?? ''));
  add('state', state.status === 'active' ? 'pass' : 'fail', state.status ?? 'not installed');
  let index;
  try {
    index = await loadIndex(stateDir);
    add('index', index.entries.length ? 'pass' : 'warn', `${index.entries.length} indexed skills`);
  } catch (error) { add('index', 'fail', error.message); }
  try {
    const manifest = await loadRetrievalManifest(stateDir);
    const consistent = manifest?.version === 2 && manifest.entries?.length === index?.entries.length;
    add('private-retrieval-index', consistent ? 'pass' : 'fail', manifest ? `${manifest.entries.length} full-body manifests · ${manifest.entries.reduce((sum, entry) => sum + entry.chunks, 0)} chunks` : 'missing');
    if (manifest) {
      const mode = (await stat(path.join(stateDir, 'retrieval-index.json'))).mode & 0o777;
      add('retrieval-index-permissions', mode & 0o077 ? 'warn' : 'pass', `mode ${mode.toString(8).padStart(3, '0')}`);
    }
  } catch (error) { add('private-retrieval-index', 'fail', error.message); }
  const runtimeBin = path.join(statePaths(stateDir).runtime, 'bin', 'skillram.js');
  add('runtime', await exists(runtimeBin) ? 'pass' : 'fail', runtimeBin);
  let vaultProblems = 0;
  for (const move of state.moves ?? []) {
    if (!await exists(move.target) || await exists(move.source)) vaultProblems += 1;
  }
  add('vault', vaultProblems ? 'fail' : 'pass', vaultProblems ? `${vaultProblems} inconsistent moves` : `${state.moves.length} moves consistent`);
  for (const integration of state.integrations ?? []) {
    const config = await readJson(integration.file, {});
    const promptInstalled = config.hooks?.UserPromptSubmit?.some((group) => group.hooks?.some((hook) => hook.command === integration.command));
    const compactInstalled = config.hooks?.PostCompact?.some((group) => group.hooks?.some((hook) => hook.command === integration.command));
    const endInstalled = config.hooks?.SessionEnd?.some((group) => group.hooks?.some((hook) => hook.command === integration.command));
    add(`${integration.provider}-prompt-hook`, promptInstalled ? 'pass' : 'fail', integration.file);
    add(`${integration.provider}-compact-hook`, compactInstalled ? 'pass' : 'fail', integration.file);
    add(`${integration.provider}-session-end-hook`, endInstalled ? 'pass' : 'fail', integration.file);
    if (integration.provider === 'codex') add('codex-trust', 'manual', 'Open /hooks in Codex and confirm both SkillRAM hooks are active.');
  }
  if (!(state.integrations ?? []).length) add('integrations', 'fail', 'No prompt-hook integrations recorded.');
  if (!usesSkillRouter) {
    const customUrl = process.env.SKILLRAM_EMBEDDING_URL;
    if (customUrl) {
      // A custom Ollama-compatible endpoint was configured; probe it.
      try {
        const response = await fetchImpl(customUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: process.env.SKILLRAM_EMBEDDING_MODEL ?? 'unknown', input: ['SkillRAM health check'] }),
          signal: AbortSignal.timeout(1200),
        });
        add('embedding-endpoint', response.ok ? 'pass' : 'warn', response.ok ? customUrl : `HTTP ${response.status}`);
      } catch { add('embedding-endpoint', 'warn', `${customUrl} unreachable; falls back to lexical.`); }
    } else {
      // Default backend: the in-process MiniLM embedder. It works when @huggingface/transformers
      // is installed; otherwise routing degrades to lexical.
      try {
        await import('@huggingface/transformers');
        add('embedding-backend', 'pass', 'in-process MiniLM (all-MiniLM-L6-v2) available');
      } catch {
        add('embedding-backend', 'warn', 'Install @huggingface/transformers for semantic routing, or routing uses lexical only.');
      }
    }
  }
  const models = await modelStatus(stateDir, { fetchImpl });
  add('skillrouter-models', models.installed ? 'pass' : 'manual', models.installed ? models.root : 'Optional enhanced models are not installed.');
  if (models.installed) {
    const hookSafe = models.service?.ok && (!usesSkillRouter || models.service.transport === 'file-ipc');
    const detail = !models.service?.ok
      ? 'Models installed but local service is not running.'
      : !hookSafe
        ? 'Service is reachable only outside the agent sandbox. Restart “skillram serve” to enable file IPC.'
        : `${models.service.device} · ${models.service.transport ?? 'local'} ready`;
    add('skillrouter-service', hookSafe ? 'pass' : 'warn', detail);
  }
  try { JSON.parse(await readFile(statePaths(stateDir).state, 'utf8')); }
  catch (error) { add('state-json', 'fail', error.message); }
  return { ok: !checks.some(({ status }) => status === 'fail'), stateDir, checks, indexedSkills: index?.entries.length ?? 0 };
}

export function formatDoctor(report) {
  const icon = { pass: '✓', warn: '!', fail: '✗', manual: '?' };
  return [`SkillRAM doctor: ${report.ok ? 'healthy' : 'needs attention'}`, ...report.checks.map((check) => `${icon[check.status]} ${check.name}: ${check.detail}`)].join('\n');
}
