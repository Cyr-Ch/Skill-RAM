import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  DEFAULT_RESIDENT_SLOTS, restoreOrder, staleSkills,
} from './memory-policy.js';
import {
  recordAccess, recordInjection, recordEviction, recordRefresh,
} from './session.js';

// Replays a stored retrieval evaluation through the real memory layer.
//
// A live session benchmark conflates two things: whether the router *found* the right skill,
// and whether the memory layer *kept* it. Eval Core and SKILLRET already froze the first —
// every prediction file is `taskId -> ranked skill ids` from the semantic + reranker path.
// Feeding those frozen rankings through session.js and memory-policy.js holds retrieval
// constant, so any difference between policies is attributable to memory alone, with no GPU
// and no re-routing.
//
// This drives the memory state machine directly rather than through handlePromptHook: the
// hook also composes summaries, overlays, and section trims, which are context-shaping
// concerns, not replacement-policy concerns. Isolating the policy is the entire point here.

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

// Predictions carry no body, so token cost is synthesized deterministically from the id.
// Budget pressure still has to be realistic and repeatable for eviction to be exercised;
// a fixed spread per skill gives that without inventing bodies.
function tokenCostFor(id, { minTokens = 300, maxTokens = 2500 } = {}) {
  const hash = parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16);
  return minTokens + (hash % (maxTokens - minTokens + 1));
}

// Deterministic session plan over the available tasks. Same archetypes as the live suite,
// but every turn is a task whose ranking is already known.
export function planSessions(taskIds, { seed = 'skillram-replay-v1' } = {}) {
  const rank = (value) => parseInt(createHash('sha256').update(`${seed}\0${value}`).digest('hex').slice(0, 12), 16);
  const ordered = [...taskIds].sort((left, right) => rank(left) - rank(right));
  const sessions = [];

  // focused: one task revisited, testing deduplication and reuse.
  for (const taskId of ordered.slice(0, Math.min(4, ordered.length))) {
    sessions.push({ id: `focused-${taskId}`, archetype: 'focused', turns: [taskId, taskId, taskId] });
  }
  // drift: a walk through distinct tasks, compacting once it cannot all fit.
  for (let start = 0; start + 4 <= ordered.length && sessions.filter((s) => s.archetype === 'drift').length < 4; start += 4) {
    const walk = ordered.slice(start, start + 4);
    sessions.push({ id: `drift-${start}`, archetype: 'drift', turns: walk, compactAfter: 3, compactExpectTasks: walk.slice(2) });
  }
  // return: task A used twice, three unrelated tasks, then A again. The frequency signal
  // that separates ARC and LFU from LRU lives here.
  for (let start = 0; start + 4 <= ordered.length && sessions.filter((s) => s.archetype === 'return').length < 4; start += 4) {
    const [hot, ...cold] = ordered.slice(start, start + 4);
    sessions.push({
      id: `return-${start}`, archetype: 'return',
      turns: [hot, hot, ...cold, hot], compactAfter: 4, compactExpectTasks: [hot],
    });
  }
  return sessions;
}

function loadUnderBudget(order, costs, tokenBudget) {
  const loaded = [];
  let tokens = 0;
  for (const id of order) {
    const cost = costs.get(id) ?? 0;
    if (tokens + cost > tokenBudget && loaded.length) continue;
    loaded.push(id);
    tokens += cost;
    if (tokens >= tokenBudget) break;
  }
  return loaded;
}

export function runMemoryReplay(predictions, gold, {
  policy = 'arc', top = 2, tokenBudget = 8000, compactBudget = 3000,
  residentSlots = DEFAULT_RESIDENT_SLOTS, refreshAfter = 20, seed = 'skillram-replay-v1',
  costOptions = {},
} = {}) {
  const taskIds = Object.keys(predictions).filter((id) => (predictions[id] ?? []).length);
  const sessions = planSessions(taskIds, { seed });
  const costs = new Map();
  const costOf = (id) => {
    if (!costs.has(id)) costs.set(id, tokenCostFor(id, costOptions));
    return costs.get(id);
  };

  const turns = [];
  const compactions = [];
  for (const plan of sessions) {
    let session = { promptCount: 0, entries: {}, arc: { t1: [], t2: [], b1: [], b2: [], p: 0 } };
    plan.turns.forEach((taskId, position) => {
      const promptIndex = position + 1;
      const ranked = (predictions[taskId] ?? []).slice(0, top);
      ranked.forEach((id) => costOf(id));
      const residentBefore = new Set(Object.keys(session.entries));
      const pending = ranked.filter((id) => !residentBefore.has(id));
      const resident = ranked.filter((id) => residentBefore.has(id));

      const stale = staleSkills(session, resident, { promptIndex, refreshAfter });
      session = recordRefresh(session, stale, promptIndex);
      session = recordAccess(session, resident, promptIndex, { residentSlots });
      session = recordInjection(session, pending.map((id) => ({ id, tokens: costOf(id) })), promptIndex, { residentSlots });
      session.promptCount = promptIndex;

      const expected = new Set(gold[taskId] ?? []);
      const nowResident = new Set(Object.keys(session.entries));
      const injected = new Set(pending);
      const hit = [...expected].filter((id) => nowResident.has(id)).length;
      turns.push({
        session: plan.id, archetype: plan.archetype, turn: position, taskId,
        // Retrieval is frozen, so this reflects only whether memory kept a correctly
        // retrieved gold skill resident — not whether retrieval found it.
        goldResident: expected.size ? hit / expected.size : null,
        goldRetrieved: expected.size ? [...expected].filter((id) => (predictions[taskId] ?? []).slice(0, top).includes(id)).length / expected.size : null,
        reused: [...expected].filter((id) => residentBefore.has(id) && !injected.has(id)).length,
        injected: injected.size,
      });

      if (plan.compactAfter === position) {
        // What *should* survive: the gold skills of the returning tasks that retrieval put
        // resident. Resolved here, not in the plan, because only skill ids live in the
        // resident set — a task id never would.
        const residentNow = new Set(Object.keys(session.entries));
        const survive = [...new Set((plan.compactExpectTasks ?? [])
          .flatMap((taskId) => (gold[taskId] ?? []))
          .filter((id) => residentNow.has(id)))];
        const order = restoreOrder(session, Object.keys(session.entries), { policy, promptIndex });
        const restored = loadUnderBudget(order, costs, compactBudget);
        const restoredSet = new Set(restored);
        const evicted = Object.keys(session.entries).filter((id) => !restoredSet.has(id));
        compactions.push({
          session: plan.id, archetype: plan.archetype,
          residentBefore: Object.keys(session.entries).length, restored: restored.length,
          retention: survive.length ? survive.filter((id) => restoredSet.has(id)).length / survive.length : null,
        });
        session = recordEviction(session, evicted);
        session = recordRefresh(session, restored, session.promptCount);
      }
    });
  }

  const retentions = compactions.map(({ retention }) => retention).filter((value) => value !== null);
  const scored = turns.filter(({ goldRetrieved }) => goldRetrieved !== null);
  // Of the gold skills retrieval actually surfaced, how many did memory keep resident.
  const retrievedTurns = scored.filter(({ goldRetrieved }) => goldRetrieved > 0);
  return {
    benchmark: 'SkillRAM-Memory-Replay', policy, top, tokenBudget, compactBudget,
    sessions: sessions.length, turns: turns.length,
    goldResident: mean(scored.map(({ goldResident }) => goldResident)),
    goldRetrieved: mean(scored.map(({ goldRetrieved }) => goldRetrieved)),
    memoryRetention: retrievedTurns.length ? mean(retrievedTurns.map(({ goldResident }) => goldResident)) : null,
    reuseTurns: turns.filter(({ reused }) => reused > 0).length,
    postCompactRetention: retentions.length ? mean(retentions) : null,
    meanInjectedPerTurn: mean(turns.map(({ injected }) => injected)),
    compactions,
  };
}

export async function loadPredictionsAndGold(predictionsFile, relevanceFile) {
  const predictions = JSON.parse(await readFile(predictionsFile, 'utf8'));
  const relevance = JSON.parse(await readFile(relevanceFile, 'utf8'));
  const gold = {};
  for (const [taskId, labels] of Object.entries(relevance)) {
    const ids = labels.core_gt_ids?.length ? labels.core_gt_ids : (labels.gt_skill_ids ?? []);
    if (ids.length) gold[taskId] = ids;
  }
  return { predictions, gold };
}

export function formatMemoryReplay(report) {
  const percent = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
  return [
    `${report.benchmark} · policy ${report.policy} · top ${report.top} · compact budget ${report.compactBudget}`,
    `Sessions: ${report.sessions} · Turns: ${report.turns}`,
    `Gold retrieved (frozen): ${percent(report.goldRetrieved)} · Gold resident: ${percent(report.goldResident)}`,
    `Memory retention (kept | retrieved): ${percent(report.memoryRetention)} · Post-compaction retention: ${percent(report.postCompactRetention)}`,
    `Reuse turns: ${report.reuseTurns} · Mean injected/turn: ${report.meanInjectedPerTurn.toFixed(2)}`,
  ].join('\n');
}
