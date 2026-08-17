import { access, mkdir, rename, unlink } from 'node:fs/promises';
import { lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { analyze, scanSkills, MIRROR_SEGMENTS } from './scan.js';
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

function isDescendantOf(child, ancestor) {
  const normalizedChild = path.resolve(child);
  const normalizedAncestor = path.resolve(ancestor);
  return normalizedChild !== normalizedAncestor && normalizedChild.startsWith(`${normalizedAncestor}${path.sep}`);
}

export function collapseToAncestors(sources) {
  const sorted = [...new Set(sources.map((source) => path.resolve(source)))].sort((a, b) => a.length - b.length);
  const kept = [];
  for (const source of sorted) {
    if (kept.some((ancestor) => isDescendantOf(source, ancestor))) continue;
    kept.push(source);
  }
  return kept;
}

export function findContainingMove(skillFile, moves) {
  const resolved = path.resolve(skillFile);
  let best = null;
  for (const move of moves) {
    const source = path.resolve(move.source);
    if (resolved === source || resolved.startsWith(`${source}${path.sep}`)) {
      if (!best || source.length > path.resolve(best.source).length) best = move;
    }
  }
  return best;
}

function isSymlinkedSkill(skillFile) {
  try { return lstatSync(skillFile).isSymbolicLink(); } catch { return false; }
}

function isMirrorCopy(skillFile) {
  return path.resolve(skillFile).split(path.sep).some((part) => MIRROR_SEGMENTS.has(part));
}

function reasonSymlinkWrapper(skillFile, moveSources) {
  let resolved;
  try {
    resolved = path.resolve(path.dirname(skillFile), readlinkSync(skillFile));
  } catch {
    return 'symlinked skill whose link target could not be read';
  }
  for (const source of moveSources) {
    const normalized = path.resolve(source);
    if (resolved === normalized || resolved.startsWith(`${normalized}${path.sep}`)) {
      return 'symlink wrapper for a skill already covered by a vaulted bundle';
    }
  }
  return 'symlinked skill left in place; vaulting it would move the link, not the skill';
}

function indexCanonicalScore(skillFile, bundleRoot) {
  const skillDir = path.resolve(path.dirname(skillFile));
  const relative = path.relative(path.resolve(bundleRoot), skillDir);
  const relativeParts = relative.split(path.sep).filter(Boolean);
  let score = relativeParts.length * 10 + relative.length;
  // A mirror copy can be the root of its own move, which leaves nothing below
  // the bundle root to penalize — so mirror segments are scored on the whole
  // path, not just the part under the bundle.
  for (const part of skillDir.split(path.sep).filter(Boolean)) {
    if (MIRROR_SEGMENTS.has(part)) score += 100;
  }
  for (const part of relativeParts) {
    if (part.startsWith('.')) score += 100;
    if (part === 'skills' && relativeParts.length > 1) score += 50;
  }
  return score;
}

function reasonIneligible(skill, stateDir) {
  const normalized = path.resolve(skill.file);
  if (path.basename(normalized).toLowerCase() !== 'skill.md') return 'only directory-based SKILL.md skills can be vaulted safely';
  if (normalized.includes(`${path.sep}.codex${path.sep}skills${path.sep}.system${path.sep}`)) return 'provider-managed system skill';
  if (normalized.includes(`${path.sep}plugins${path.sep}cache${path.sep}`)) return 'managed plugin cache; disable or optimize the plugin instead';
  if (normalized.startsWith(`${path.resolve(stateDir)}${path.sep}`)) return 'already inside the SkillRAM state directory';
  return null;
}

function representativeSkill(candidates, source) {
  const resolvedSource = path.resolve(source);
  return candidates.find((skill) => path.dirname(path.resolve(skill.file)) === resolvedSource)
    ?? candidates.find((skill) => path.resolve(skill.file).startsWith(`${resolvedSource}${path.sep}`));
}

function buildMoveTarget(stateDir, skill, source) {
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 10);
  const id = `${skill.provider}-${slug(skill.name)}-${digest}`;
  return {
    id,
    source,
    target: path.join(statePaths(stateDir).vault, skill.provider, id),
  };
}

function buildIndexEntry(skill, move) {
  if (!move) throw new Error(`No vault move covers ${skill.file}`);
  const resolvedFile = path.resolve(skill.file);
  const vaultSkillFile = path.join(move.target, path.relative(move.source, resolvedFile));
  const id = `${skill.provider}-${slug(skill.name)}-${createHash('sha256').update(resolvedFile).digest('hex').slice(0, 10)}`;
  return {
    id,
    provider: skill.provider,
    name: skill.name,
    description: skill.description,
    activationTokens: skill.activationTokens,
    fullTokens: skill.fullTokens,
    source: move.source,
    target: move.target,
    originalSkillFile: skill.file,
    vaultSkillFile,
    contentHash: createHash('sha256').update(skill.body).digest('hex'),
  };
}

export function buildVaultPlan(report, stateDir) {
  const skipped = [];
  const eligible = [];
  for (const skill of report.skills) {
    const reason = reasonIneligible(skill, stateDir);
    if (reason) { skipped.push({ name: skill.name, file: skill.file, reason }); continue; }
    eligible.push(skill);
  }

  // Only real files define what gets moved. A symlink is classified afterwards,
  // against the moves it may already be covered by.
  const indexCandidates = [];
  const linkedSkills = [];
  for (const skill of eligible) (isSymlinkedSkill(skill.file) ? linkedSkills : indexCandidates).push(skill);

  const moveSources = collapseToAncestors(indexCandidates.map((skill) => path.dirname(path.resolve(skill.file))));
  const moves = moveSources.map((source) => {
    const skill = representativeSkill(indexCandidates, source);
    if (!skill) throw new Error(`No skill found under vault move source ${source}`);
    return buildMoveTarget(stateDir, skill, source);
  });

  for (const skill of linkedSkills) {
    skipped.push({ name: skill.name, file: skill.file, reason: reasonSymlinkWrapper(skill.file, moveSources) });
  }

  const scored = indexCandidates.map((skill) => {
    const move = findContainingMove(skill.file, moves);
    const entry = buildIndexEntry(skill, move);
    return { entry, score: indexCanonicalScore(skill.file, move.source) };
  });

  const bestByContent = new Map();
  for (const item of scored) {
    const current = bestByContent.get(item.entry.contentHash);
    if (!current || item.score < current.score) bestByContent.set(item.entry.contentHash, item);
  }

  // Mirror bundles ship per-tool copies of the same skill with reformatted
  // frontmatter, so byte-level dedupe misses them. Same provider+name entries
  // collapse to the best-scored path — unless a loser sits on a clean
  // (non-mirror) path, which means two genuinely different skills share a name
  // and both must stay routable.
  const byName = new Map();
  for (const item of bestByContent.values()) {
    const key = `${item.entry.provider}\u0000${item.entry.name}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(item);
  }
  const kept = new Set();
  for (const group of byName.values()) {
    group.sort((a, b) => a.score - b.score || a.entry.vaultSkillFile.localeCompare(b.entry.vaultSkillFile));
    kept.add(group[0].entry);
    for (const item of group.slice(1)) if (!isMirrorCopy(item.entry.originalSkillFile)) kept.add(item.entry);
  }

  const entries = [...kept]
    .sort((a, b) => a.name.localeCompare(b.name) || a.vaultSkillFile.localeCompare(b.vaultSkillFile));

  for (const item of scored) {
    if (kept.has(item.entry)) continue;
    const contentBest = bestByContent.get(item.entry.contentHash);
    const reason = contentBest.entry !== item.entry && kept.has(contentBest.entry)
      ? 'duplicate skill body already indexed from a canonical bundle path'
      : 'mirror copy superseded by the same skill at its canonical path';
    skipped.push({ name: item.entry.name, file: item.entry.originalSkillFile, reason });
  }

  return { moves, entries, skipped };
}

export async function vaultSkills({ inputRoots = [], provider = 'all', stateDir, dryRun = false } = {}) {
  const existingState = await loadState(stateDir);
  if (existingState.moves.length) throw new Error('A SkillRAM vault is already active. Run “skillram uninstall” before installing again.');
  const report = analyze(await scanSkills(inputRoots, { provider }));
  const plan = buildVaultPlan(report, stateDir);
  if (dryRun || !plan.entries.length) return { ...plan, report, applied: false };

  for (const move of plan.moves) {
    if (!await exists(move.source)) throw new Error(`Skill source disappeared: ${move.source}`);
    if (await exists(move.target)) throw new Error(`Vault target already exists: ${move.target}`);
  }
  const state = {
    version: 1,
    status: 'installing',
    installedAt: new Date().toISOString(),
    entries: plan.entries,
    moves: plan.moves.map(({ source, target }) => ({ source, target })),
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
    const stranded = [];
    for (const move of completed.reverse()) {
      await mkdir(path.dirname(move.source), { recursive: true });
      const restored = await rename(move.target, move.source).then(() => true, () => false);
      if (!restored) stranded.push(move);
    }
    state.status = stranded.length ? 'failed-dirty' : 'failed';
    state.error = error.message;
    state.entries = [];
    // Anything that could not be put back stays on record so “skillram
    // uninstall” can retry it instead of orphaning it inside the vault.
    state.moves = stranded;
    await writeIndex(stateDir, []);
    await saveState(stateDir, state);
    const detail = stranded.length
      ? ` ${stranded.length} skill director${stranded.length === 1 ? 'y is' : 'ies are'} still in the vault; run “skillram uninstall” to restore ${stranded.length === 1 ? 'it' : 'them'}.`
      : '';
    throw new Error(`Vault installation rolled back: ${error.message}${detail}`);
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
