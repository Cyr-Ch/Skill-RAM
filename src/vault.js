import { access, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { analyze, scanSkills } from './scan.js';
import { loadState, saveState, statePaths, writeIndex } from './state.js';
import { buildRetrievalManifest } from './retrieval-index.js';

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function cleanupPrivateCaches(stateDir) {
  const cleanup = await Promise.allSettled(['retrieval-index.json', 'embeddings.json'].map((file) => unlink(path.join(stateDir, file))));
  return cleanup.filter((result) => result.status === 'rejected' && result.reason?.code !== 'ENOENT').length;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'skill';
}

function reasonIneligible(skill, stateDir) {
  const normalized = path.resolve(skill.file);
  if (path.basename(normalized).toLowerCase() !== 'skill.md') return 'only directory-based SKILL.md skills can be vaulted safely';
  if (normalized.includes(`${path.sep}.codex${path.sep}skills${path.sep}.system${path.sep}`)) return 'provider-managed system skill';
  if (normalized.includes(`${path.sep}plugins${path.sep}cache${path.sep}`)) return 'managed plugin cache; disable or optimize the plugin instead';
  if (normalized.startsWith(`${path.resolve(stateDir)}${path.sep}`)) return 'already inside the SkillRAM state directory';
  return null;
}

export function buildVaultPlan(report, stateDir) {
  const entries = [];
  const skipped = [];
  const seenRoots = new Set();
  for (const skill of report.skills) {
    const reason = reasonIneligible(skill, stateDir);
    if (reason) { skipped.push({ name: skill.name, file: skill.file, reason }); continue; }
    const source = path.dirname(path.resolve(skill.file));
    if (seenRoots.has(source)) continue;
    seenRoots.add(source);
    const digest = createHash('sha256').update(source).digest('hex').slice(0, 10);
    const id = `${skill.provider}-${slug(skill.name)}-${digest}`;
    const target = path.join(statePaths(stateDir).vault, skill.provider, id);
    entries.push({
      id,
      provider: skill.provider,
      name: skill.name,
      description: skill.description,
      activationTokens: skill.activationTokens,
      fullTokens: skill.fullTokens,
      source,
      target,
      originalSkillFile: skill.file,
      vaultSkillFile: path.join(target, path.relative(source, skill.file)),
    });
  }
  return { entries, skipped };
}

export async function vaultSkills({ inputRoots = [], provider = 'all', stateDir, dryRun = false } = {}) {
  const existingState = await loadState(stateDir);
  if (existingState.moves.length) throw new Error('A SkillRAM vault is already active. Run “skillram uninstall” before installing again.');
  const report = analyze(await scanSkills(inputRoots, { provider }));
  const plan = buildVaultPlan(report, stateDir);
  if (dryRun || !plan.entries.length) return { ...plan, report, applied: false };

  for (const entry of plan.entries) {
    if (!await exists(entry.source)) throw new Error(`Skill source disappeared: ${entry.source}`);
    if (await exists(entry.target)) throw new Error(`Vault target already exists: ${entry.target}`);
  }
  const state = {
    version: 1,
    status: 'installing',
    installedAt: new Date().toISOString(),
    entries: plan.entries,
    moves: plan.entries.map(({ source, target }) => ({ source, target })),
    integrations: [],
    before: {
      skills: plan.entries.length,
      activationTokens: plan.entries.reduce((sum, entry) => sum + entry.activationTokens, 0),
      fullTokens: plan.entries.reduce((sum, entry) => sum + entry.fullTokens, 0),
    },
  };
  await saveState(stateDir, state);
  const completed = [];
  try {
    for (const move of state.moves) {
      await mkdir(path.dirname(move.target), { recursive: true, mode: 0o700 });
      await rename(move.source, move.target);
      completed.push(move);
    }
    const compactIndex = await writeIndex(stateDir, state.entries);
    await buildRetrievalManifest(stateDir, compactIndex);
    state.status = 'active';
    await saveState(stateDir, state);
  } catch (error) {
    for (const move of completed.reverse()) {
      await mkdir(path.dirname(move.source), { recursive: true });
      await rename(move.target, move.source).catch(() => {});
    }
    state.status = 'failed';
    state.error = error.message;
    state.entries = [];
    state.moves = [];
    await writeIndex(stateDir, []);
    await saveState(stateDir, state);
    throw new Error(`Vault installation rolled back: ${error.message}`);
  }
  return { ...plan, report, applied: true, state };
}

export async function restoreVault(stateDir) {
  const state = await loadState(stateDir);
  if (!state.moves.length) return { restored: 0, state, cacheCleanupFailed: await cleanupPrivateCaches(stateDir) };
  const movesToRestore = [];
  for (const move of state.moves) {
    const sourceExists = await exists(move.source);
    const targetExists = await exists(move.target);
    if (sourceExists && targetExists) throw new Error(`Restore destination already exists; refusing to overwrite it: ${move.source}`);
    if (!sourceExists && !targetExists) throw new Error(`Both source and vault entry are missing: ${move.source}`);
    if (targetExists) movesToRestore.push(move);
  }
  const restored = [];
  try {
    for (const move of [...movesToRestore].reverse()) {
      await mkdir(path.dirname(move.source), { recursive: true });
      await rename(move.target, move.source);
      restored.push(move);
    }
  } catch (error) {
    for (const move of restored.reverse()) {
      await mkdir(path.dirname(move.target), { recursive: true });
      await rename(move.source, move.target).catch(() => {});
    }
    throw new Error(`Restore rolled back: ${error.message}`);
  }
  const count = movesToRestore.length;
  state.status = 'restored';
  state.restoredAt = new Date().toISOString();
  state.entries = [];
  state.moves = [];
  await writeIndex(stateDir, []);
  await saveState(stateDir, state);
  const cacheCleanupFailed = await cleanupPrivateCaches(stateDir);
  return { restored: count, state, cacheCleanupFailed };
}

export function vaultMeasurements(state, routed = null) {
  const before = state.before ?? { skills: 0, activationTokens: 0, fullTokens: 0 };
  const selected = routed?.loaded ?? [];
  return {
    vaultedSkills: before.skills,
    estimatedActivationTokensBefore: before.activationTokens,
    estimatedActivationTokensAfter: 0,
    estimatedActivationTokensAvoided: before.activationTokens,
    selectedSkills: selected.length,
    loadedInstructionTokens: routed?.tokens ?? 0,
    method: 'full-body-retrieve-rerank-v1',
  };
}
