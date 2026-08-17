import { readFile } from 'node:fs/promises';
import { loadIndex, loadState } from './state.js';
import { estimateTokens } from './scan.js';
import { formatLoadedContext, loadRoutedEntries, routeEntries } from './router.js';
import { routeHybrid, routeWithEmbeddings } from './hybrid-router.js';
import { vaultMeasurements } from './vault.js';
import { DEFAULT_SUMMARY_REPEAT_AFTER, appendTrace, clearSession, loadSession, memoLookup, recordAccess, recordEviction, recordInjection, recordMemo, recordRefresh, recordSummaries, summaryIsFresh, updateSession } from './session.js';
import { buildRetrievalManifest } from './retrieval-index.js';
import { formatRefreshContext, formatSummaryContext, selectSections, summarizeSkill, summaryTokens } from './skill-summary.js';
import { DEFAULT_REFRESH_AFTER, DEFAULT_RESIDENT_SLOTS, restoreOrder, staleSkills } from './memory-policy.js';
import { predictFromTraces } from './prefetch.js';
import { applyOverlay, loadOverlays } from './overlay.js';
import { defaultServiceIpc, defaultServiceSocket, localServiceHealth } from './local-http.js';

const SKILLROUTER_EMBEDDING_URL = 'http://127.0.0.1:8765/embed';
const SKILLROUTER_HEALTH_URL = 'http://127.0.0.1:8765/health';

async function skillRouterServiceStatus({ stateDir, fetchImpl = globalThis.fetch, healthUrl = process.env.SKILLRAM_SERVICE_HEALTH_URL ?? SKILLROUTER_HEALTH_URL, serviceIpc, serviceSocket = defaultServiceSocket() } = {}) {
  return localServiceHealth({ fetchImpl, healthUrl, ipcRoot: serviceIpc ?? defaultServiceIpc(stateDir), socketPath: serviceSocket, timeout: 1000 });
}

let warnedServiceDown = false;
function warnSkillRouterServiceDown() {
  if (warnedServiceDown) return;
  warnedServiceDown = true;
  process.stderr.write(
    'SkillRAM: --router skillrouter was requested but the local model service is not running, so routing fell back to lexical matching — much lower accuracy. Start it with `skillram serve` (CPU works; a GPU is optional and only makes it faster).\n',
  );
}

export async function routePrompt(stateDir, prompt, { provider = 'all', top = 2, router = 'hybrid', ...routerOptions } = {}) {
  const index = await loadIndex(stateDir);
  if (router === 'lexical') return routeEntries(index, prompt, { provider, top, ...routerOptions });
  if (router === 'semantic') return routeHybrid(index, prompt, { provider, top, stateDir, lexicalShortcut: false, ...routerOptions });
  if (router === 'skillrouter') {
    const service = await skillRouterServiceStatus({ stateDir, ...routerOptions });
    if (!service) {
      if (routerOptions.diagnostics) routerOptions.diagnostics.skillrouterService = { ready: false, healthUrl: process.env.SKILLRAM_SERVICE_HEALTH_URL ?? SKILLROUTER_HEALTH_URL };
      if (routerOptions.strictRouter) throw new Error('SkillRouter model service is not running. Start it with “skillram serve”.');
      warnSkillRouterServiceDown();
      // The service is the embedding backend in this mode; with it down there is no endpoint
      // to reach, so route without embeddings and let the lexical fallback handle it.
      return routeHybrid(index, prompt, { provider, top, stateDir, embeddings: false, routerLlm: false, ...routerOptions });
    }
    if (routerOptions.diagnostics) routerOptions.diagnostics.skillrouterService = { ready: true, transport: service.transport };
    const serviceSocket = service.transport === 'unix' ? service.socketPath : null;
    const serviceIpc = service.transport === 'file-ipc' ? service.ipcRoot : null;
    return routeHybrid(index, prompt, {
      provider, top, stateDir,
      embeddingUrl: process.env.SKILLRAM_SKILLROUTER_EMBEDDING_URL ?? SKILLROUTER_EMBEDDING_URL,
      embeddingModel: 'skillrouter-embedding-0.6b', embeddingTimeout: 120_000, embeddingSocket: serviceSocket,
      embeddingIpc: serviceIpc,
      reranker: 'skillrouter', rerankerTimeout: 120_000, rerankerSocket: serviceSocket, rerankerIpc: serviceIpc,
      ...routerOptions,
    });
  }
  return routeHybrid(index, prompt, { provider, top, stateDir, ...routerOptions });
}

export async function rebuildRetrievalIndex(stateDir, { embeddings = true, provider = 'all', ...options } = {}) {
  const index = await loadIndex(stateDir);
  const manifest = await buildRetrievalManifest(stateDir, index, options);
  if (embeddings && index.entries.length) {
    const profile = options.router === 'skillrouter' ? {
      embeddingUrl: process.env.SKILLRAM_SKILLROUTER_EMBEDDING_URL ?? SKILLROUTER_EMBEDDING_URL,
      embeddingModel: 'skillrouter-embedding-0.6b', embeddingTimeout: 120_000,
    } : {};
    const service = options.router === 'skillrouter' ? await skillRouterServiceStatus({ stateDir, ...options }) : null;
    if (options.router === 'skillrouter' && !service) {
      throw new Error('SkillRouter model service is not running. Start it with “skillram serve” in another terminal.');
    }
    if (service?.transport === 'unix') profile.embeddingSocket = service.socketPath;
    if (service?.transport === 'file-ipc') profile.embeddingIpc = service.ipcRoot;
    await routeWithEmbeddings(index, 'SkillRAM private retrieval index warmup', {
      provider, stateDir, semanticThreshold: 2, retrievalK: 1, ...profile, ...options,
    });
  }
  return { entries: manifest.entries.length, chunks: manifest.entries.reduce((sum, entry) => sum + entry.chunks, 0), embeddings };
}

// Restores in the caller's order. Index order used to decide which skills survived a
// budget overflow, which made eviction depend on a skill's position in the index file.
export async function loadSelection(stateDir, ids, { tokenBudget = 8000, overlays = true } = {}) {
  const index = await loadIndex(stateDir);
  const byKey = new Map();
  for (const entry of index.entries) {
    byKey.set(entry.id, entry);
    if (!byKey.has(entry.name)) byKey.set(entry.name, entry);
  }
  const seen = new Set();
  const routed = [];
  for (const id of ids) {
    const entry = byKey.get(id);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    routed.push({ entry, score: 1, matches: [] });
  }
  const overlayMap = overlays ? await loadOverlays(stateDir, routed.map(({ entry }) => entry.id)) : new Map();
  const trim = overlayMap.size
    ? (raw, { entry }) => (overlayMap.has(entry.id) ? applyOverlay(raw, overlayMap.get(entry.id)) : raw)
    : null;
  return loadRoutedEntries(routed, { tokenBudget, trim });
}

// Resolves ids to ranked-shaped results, preserving the given order.
async function loadSelectionEntries(stateDir, ids) {
  const byId = new Map((await loadIndex(stateDir)).entries.map((entry) => [entry.id, entry]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map((entry) => ({ entry, score: 1, matches: [] }));
}

async function summarizeEntries(routed, { budget }) {
  const summaries = [];
  let spent = 0;
  for (const { entry } of routed) {
    const contents = await readFile(entry.vaultSkillFile, 'utf8').catch(() => null);
    if (contents === null) continue;
    const summary = summarizeSkill(entry, contents);
    const cost = summaryTokens([summary]);
    if (spent + cost > budget) break;
    spent += cost;
    summaries.push(summary);
  }
  return { summaries, tokens: spent };
}

export async function handlePromptHook(stateDir, input, {
  provider = 'all', top = 2, tokenBudget = 8000,
  summaryTop = 3, summaryBudget = 400, summaryMinScore = 1, refreshAfter = DEFAULT_REFRESH_AFTER,
  summaryRepeatAfter = DEFAULT_SUMMARY_REPEAT_AFTER, prefetch = true, prefetchLimit = 2, memo = true,
  sectionGranularity = false, sectionThresholdTokens = 2000, sectionMaxTokens = 1200, overlays = true,
  residentSlots = DEFAULT_RESIDENT_SLOTS,
  ...routerOptions
} = {}) {
  if (!input?.prompt || input.hook_event_name !== 'UserPromptSubmit') return null;
  const diagnostics = {};
  const session = await loadSession(stateDir, provider, input.session_id);
  const memoized = memo ? memoLookup(session, input.prompt) : undefined;
  if (memoized) diagnostics.memoHit = true;
  // Route deeper than the load limit so the surplus can populate the summary tier instead
  // of being discarded, which is what turns a near miss into something recoverable.
  // The summary tier can only offer what the router returned, but the confidence floor
  // discards weak candidates outright — so the misses most worth recovering were exactly
  // the ones never ranked. Retrieve with a relaxed floor and re-apply the real one when
  // deciding what loads, so L2 widens discovery without weakening L1 admission.
  const loadFloor = routerOptions.minScore ?? 2;
  const searchFloor = summaryTop > 0 ? Math.min(loadFloor, summaryMinScore) : loadFloor;
  const ranked = memoized
    ? await loadSelectionEntries(stateDir, memoized)
    : await routePrompt(stateDir, input.prompt, {
      provider, top: top + Math.max(0, summaryTop), diagnostics, ...routerOptions, minScore: searchFloor,
    });
  const admissible = memoized ? ranked : ranked.filter(({ score }) => score === undefined || score >= loadFloor);
  const routed = admissible.slice(0, top);
  const belowFloor = ranked.filter(({ entry }) => !routed.some((value) => value.entry.id === entry.id));
  const promptIndex = (session.promptCount ?? 0) + 1;
  const alreadyLoaded = new Set(session.loaded ?? []);
  const pending = routed.filter(({ entry }) => !alreadyLoaded.has(entry.id));
  const selectedIds = routed.map(({ entry }) => entry.id);
  const residentSelected = selectedIds.filter((id) => alreadyLoaded.has(id));

  const stale = staleSkills(session, residentSelected, { promptIndex, refreshAfter });
  const refreshed = [];
  for (const { entry } of routed.filter(({ entry }) => stale.includes(entry.id))) {
    const contents = await readFile(entry.vaultSkillFile, 'utf8').catch(() => null);
    if (contents !== null) refreshed.push({ entry, summary: summarizeSkill(entry, contents) });
  }

  const candidates = belowFloor
    .filter(({ entry }) => !alreadyLoaded.has(entry.id))
    .filter(({ entry }) => summaryIsFresh(session, entry.id, promptIndex, summaryRepeatAfter));
  // Speculative candidates rank behind ranked ones: prediction fills leftover summary
  // budget, it never displaces a skill the router actually matched.
  const predicted = prefetch && summaryTop > 0 && selectedIds.length
    ? await predictFromTraces(stateDir, selectedIds, { limit: prefetchLimit })
    : [];
  // Predicted skills are by definition absent from this prompt's ranking, so they resolve
  // against the index rather than the ranked list.
  const known = new Set([...candidates.map(({ entry }) => entry.id), ...alreadyLoaded]);
  const wanted = predicted
    .filter(({ id }) => !known.has(id) && summaryIsFresh(session, id, promptIndex, summaryRepeatAfter))
    .map(({ id }) => id);
  const prefetched = wanted.length
    ? (await loadIndex(stateDir)).entries
      .filter((entry) => wanted.includes(entry.id))
      .sort((left, right) => wanted.indexOf(left.id) - wanted.indexOf(right.id))
      .map((entry) => ({ entry, score: 0, matches: [] }))
    : [];
  const { summaries, tokens: summaryTokenCost } = summaryTop > 0
    ? await summarizeEntries([...candidates, ...prefetched], { budget: summaryBudget })
    : { summaries: [], tokens: 0 };

  const overlayMap = overlays && pending.length
    ? await loadOverlays(stateDir, pending.map(({ entry }) => entry.id))
    : new Map();
  // Trim first, then append the overlay: section selection must never drop a learned note,
  // and the overlay must be counted in the token cost the budget sees.
  const transform = (raw, { entry }) => {
    const trimmed = sectionGranularity && estimateTokens(raw) > sectionThresholdTokens
      ? selectSections(raw, input.prompt, { maxTokens: sectionMaxTokens })
      : raw;
    return overlayMap.has(entry.id) ? applyOverlay(trimmed, overlayMap.get(entry.id)) : trimmed;
  };
  const result = pending.length ? await loadRoutedEntries(pending, { tokenBudget, trim: transform }) : { loaded: [], tokens: 0, skipped: [] };
  const additionalContext = [
    formatLoadedContext(result.loaded),
    formatRefreshContext(refreshed),
    formatSummaryContext(summaries),
  ].filter(Boolean).join('\n\n');

  await updateSession(stateDir, provider, input.session_id, (value) => ({
    ...recordSummaries(
      recordRefresh(
        recordInjection(
          recordAccess(value, residentSelected, promptIndex, { residentSlots }),
          result.loaded.map(({ entry, tokens }) => ({ id: entry.id, tokens })),
          promptIndex, { residentSlots },
        ),
        refreshed.map(({ entry }) => entry.id),
        promptIndex,
      ),
      summaries.map(({ id }) => id),
      promptIndex,
    ),
    ...(memo ? { memo: recordMemo({ ...value }, input.prompt, ranked.map(({ entry }) => entry.id)).memo } : {}),
    promptCount: promptIndex,
  }));
  await appendTrace(stateDir, {
    provider, event: 'prompt', promptIndex, selected: selectedIds,
    injected: result.loaded.map(({ entry }) => entry.id),
    deduplicated: residentSelected,
    refreshed: refreshed.map(({ entry }) => entry.id),
    summarized: summaries.map(({ id }) => id),
    prefetched: predicted.map(({ id }) => id),
    overlaid: [...overlayMap.keys()].filter((id) => result.loaded.some(({ entry }) => entry.id === id)),
    skipped: result.skipped, tokens: result.tokens, summaryTokens: summaryTokenCost, diagnostics,
  });
  if (!additionalContext) return null;
  return {
    output: {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    },
    routed,
    result,
    refreshed,
    summaries,
  };
}

export async function handleAgentHook(stateDir, input, options = {}) {
  if (input?.hook_event_name === 'PostCompact') {
    const provider = options.provider ?? 'all';
    const session = await loadSession(stateDir, provider, input.session_id);
    if (!session.loaded?.length) return null;
    const policy = options.evictionPolicy ?? 'arc';
    const ordered = restoreOrder(session, session.loaded, { policy, window: options.workingSetWindow });
    const result = await loadSelection(stateDir, ordered, { tokenBudget: options.tokenBudget ?? 8000 });
    const additionalContext = formatLoadedContext(result.loaded);
    const restored = result.loaded.map(({ entry }) => entry.id);
    const evicted = session.loaded.filter((id) => !restored.includes(id));
    await updateSession(stateDir, provider, input.session_id, (value) => recordRefresh(
      recordEviction(value, evicted), restored, value.promptCount ?? 0,
    ));
    await appendTrace(stateDir, {
      provider, event: 'compact', policy, restored, tokens: result.tokens, evicted,
    });
    if (!additionalContext) return null;
    return { output: { hookSpecificOutput: { hookEventName: 'PostCompact', additionalContext } }, result };
  }
  if (input?.hook_event_name === 'SessionEnd') {
    await clearSession(stateDir, options.provider ?? 'all', input.session_id);
    await appendTrace(stateDir, { provider: options.provider ?? 'all', event: 'session-end', sessionCleared: Boolean(input.session_id) });
    return null;
  }
  return handlePromptHook(stateDir, input, options);
}

export async function currentMeasurements(stateDir, result = null) {
  return vaultMeasurements(await loadState(stateDir), result);
}
