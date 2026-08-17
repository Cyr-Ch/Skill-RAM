import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { vaultSkills } from './vault.js';
import { handleAgentHook, handlePromptHook } from './runtime.js';
import { loadSession } from './session.js';

// Single-shot retrieval benchmarks score one query against one ranked list. Nothing in that
// shape can observe a resident set, an eviction, a refresh, or a budget under pressure, so
// none of the memory-hierarchy behavior is measurable with SkillRouter Eval Core or SKILLRET.
//
// This runner replays ordered prompt sequences against a real vault and asks, at each turn,
// which skills are actually resident — not merely which ranked first.

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function f1(expected, actual) {
  if (!expected.size && !actual.size) return 1;
  const hit = [...expected].filter((id) => actual.has(id)).length;
  const precision = actual.size ? hit / actual.size : 0;
  const recall = expected.size ? hit / expected.size : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

export function validateSuite(suite, location = 'suite') {
  if (!Array.isArray(suite?.skills) || !suite.skills.length) throw new Error(`${location} must define a non-empty skills array.`);
  if (!Array.isArray(suite?.sessions) || !suite.sessions.length) throw new Error(`${location} must define a non-empty sessions array.`);
  const names = new Set();
  for (const skill of suite.skills) {
    if (!skill.name || !skill.description) throw new Error(`${location} skills need a name and description.`);
    if (names.has(skill.name)) throw new Error(`${location} duplicate skill ${skill.name}.`);
    names.add(skill.name);
  }
  const ids = new Set();
  for (const session of suite.sessions) {
    if (!session.id) throw new Error(`${location} sessions need an id.`);
    if (ids.has(session.id)) throw new Error(`${location} duplicate session ${session.id}.`);
    ids.add(session.id);
    if (!Array.isArray(session.turns) || !session.turns.length) throw new Error(`${location} session ${session.id} needs turns.`);
    for (const [position, turn] of session.turns.entries()) {
      if (!turn.prompt) throw new Error(`${location} session ${session.id} turn ${position} needs a prompt.`);
      for (const key of ['expectResident', 'expectSummary', 'forbidden']) {
        for (const name of turn[key] ?? []) {
          if (!names.has(name)) throw new Error(`${location} session ${session.id} turn ${position} references unknown skill ${name}.`);
        }
      }
    }
  }
  return suite;
}

async function buildFixture(suite) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillram-session-bench-'));
  for (const skill of suite.skills) {
    const directory = path.join(root, skill.name);
    await mkdir(directory, { recursive: true });
    const body = skill.body ?? `# ${skill.name}\n${skill.description}\n`;
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${body}\n`);
  }
  return root;
}

function resolveIds(index, names) {
  const byName = new Map(index.entries.map((entry) => [entry.name, entry.id]));
  return new Set(names.map((name) => byName.get(name)).filter(Boolean));
}

export async function runSessionBenchmark(suite, {
  provider = 'claude', tokenBudget = 8000, top = 2, summaryTop = 3,
  evictionPolicy = 'arc', router = 'lexical', embeddings = false, ...options
} = {}) {
  validateSuite(suite);
  const root = await buildFixture(suite);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-session-state-'));
  const turns = [];
  const compactions = [];
  try {
    await vaultSkills({ inputRoots: [root], provider, stateDir });
    const { loadIndex } = await import('./state.js');
    const index = await loadIndex(stateDir);

    for (const session of suite.sessions) {
      const sessionId = `bench-${createHash('sha256').update(session.id).digest('hex').slice(0, 12)}`;
      for (const [position, turn] of session.turns.entries()) {
        const hookOptions = {
          provider, top, summaryTop, tokenBudget, evictionPolicy, router, embeddings,
          prefetch: options.prefetch ?? true, memo: options.memo ?? true,
          ...options,
        };
        const before = await loadSession(stateDir, provider, sessionId);
        const outcome = await handlePromptHook(stateDir, {
          hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: turn.prompt,
        }, hookOptions);
        const after = await loadSession(stateDir, provider, sessionId);

        const expected = resolveIds(index, turn.expectResident ?? []);
        const expectedSummary = resolveIds(index, turn.expectSummary ?? []);
        const forbidden = resolveIds(index, turn.forbidden ?? []);
        const resident = new Set(after.loaded);
        const injected = new Set((outcome?.result?.loaded ?? []).map(({ entry }) => entry.id));
        const summarized = new Set((outcome?.summaries ?? []).map(({ id }) => id));
        const refreshed = new Set((outcome?.refreshed ?? []).map(({ entry }) => entry.id));
        // Already resident and not re-sent: the deduplication working as intended.
        const reused = [...expected].filter((id) => new Set(before.loaded).has(id) && !injected.has(id));

        turns.push({
          session: session.id, turn: position, prompt: turn.prompt,
          residentF1: f1(expected, resident),
          covered: expected.size ? [...expected].filter((id) => resident.has(id)).length / expected.size : 1,
          reuse: expected.size ? reused.length / expected.size : 1,
          summaryRecovery: expectedSummary.size
            ? [...expectedSummary].filter((id) => summarized.has(id) || resident.has(id)).length / expectedSummary.size
            : null,
          forbiddenActivations: [...forbidden].filter((id) => injected.has(id)).length,
          // A turn that expects nothing resident is an abstention test: the correct outcome
          // is to inject no skill at all, not merely to avoid the one held-out gold skill.
          abstentionCase: (turn.expectResident ?? []).length === 0,
          abstained: (turn.expectResident ?? []).length === 0 ? injected.size === 0 : null,
          injectedTokens: outcome?.result?.tokens ?? 0,
          injected: injected.size, summarized: summarized.size, refreshed: refreshed.size,
        });

        if (session.compactAfter?.includes(position)) {
          const workingSet = new Set(after.loaded);
          const compact = await handleAgentHook(stateDir, {
            hook_event_name: 'PostCompact', session_id: sessionId,
          }, { ...hookOptions, tokenBudget: session.compactBudget ?? tokenBudget });
          const restored = new Set((compact?.result?.loaded ?? []).map(({ entry }) => entry.id));
          const survives = resolveIds(index, session.compactExpect ?? []);
          compactions.push({
            session: session.id, afterTurn: position,
            residentBefore: workingSet.size, restored: restored.size,
            retention: survives.size ? [...survives].filter((id) => restored.has(id)).length / survives.size : null,
            tokens: compact?.result?.tokens ?? 0,
          });
        }
      }
      await handleAgentHook(stateDir, { hook_event_name: 'SessionEnd', session_id: sessionId }, { provider });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }

  const recoveries = turns.map(({ summaryRecovery }) => summaryRecovery).filter((value) => value !== null);
  const retentions = compactions.map(({ retention }) => retention).filter((value) => value !== null);
  const abstentions = turns.filter(({ abstentionCase }) => abstentionCase);
  return {
    benchmark: 'SkillRAM-Session',
    policy: evictionPolicy, top, summaryTop, tokenBudget,
    sessions: suite.sessions.length, turns: turns.length,
    residentF1: mean(turns.map(({ residentF1 }) => residentF1)),
    residentCoverage: mean(turns.map(({ covered }) => covered)),
    reuseRate: mean(turns.map(({ reuse }) => reuse)),
    summaryRecovery: recoveries.length ? mean(recoveries) : null,
    postCompactRetention: retentions.length ? mean(retentions) : null,
    abstentionRate: abstentions.length ? mean(abstentions.map(({ abstained }) => (abstained ? 1 : 0))) : null,
    forbiddenActivations: turns.reduce((sum, { forbiddenActivations }) => sum + forbiddenActivations, 0),
    meanInjectedTokensPerTurn: mean(turns.map(({ injectedTokens }) => injectedTokens)),
    totalInjectedTokens: turns.reduce((sum, { injectedTokens }) => sum + injectedTokens, 0),
    compactions, turnResults: turns,
  };
}

export async function loadSessionSuite(file) {
  return validateSuite(JSON.parse(await readFile(file, 'utf8')), file);
}

export function formatSessionBenchmark(report) {
  const percent = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
  return [
    `${report.benchmark} · policy ${report.policy} · top ${report.top} · summary ${report.summaryTop} · budget ${report.tokenBudget}`,
    `Sessions: ${report.sessions} · Turns: ${report.turns}`,
    `Resident F1: ${report.residentF1.toFixed(3)} · Coverage: ${percent(report.residentCoverage)} · Reuse: ${percent(report.reuseRate)}`,
    `Summary recovery: ${percent(report.summaryRecovery)} · Post-compaction retention: ${percent(report.postCompactRetention)}`,
    `Abstention (no-gold turns): ${percent(report.abstentionRate)} · Forbidden activations: ${report.forbiddenActivations}`,
    `Mean injected tokens/turn: ${Math.round(report.meanInjectedTokensPerTurn).toLocaleString()}`,
  ].join('\n');
}
