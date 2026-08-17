import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emptyArc, referenceArc } from './memory-policy.js';

export const SESSION_VERSION = 2;

function sessionKey(provider, sessionId) {
  return createHash('sha256').update(`${provider}\0${sessionId}`).digest('hex');
}

function sessionFile(stateDir, provider, sessionId) {
  return path.join(stateDir, 'sessions', `${sessionKey(provider, sessionId)}.json`);
}

// `entries` is the resident set (full instructions). `summaries` is the summary tier and
// is deliberately separate: `loaded` derives from `entries` alone, so a skill the agent has
// only seen a summary of is never mistaken for one whose instructions are in context.
function emptySession() {
  return { version: SESSION_VERSION, promptCount: 0, entries: {}, summaries: {}, arc: emptyArc() };
}

export const DEFAULT_SUMMARY_REPEAT_AFTER = 10;
export const DEFAULT_MEMO_ENTRIES = 32;

// A translation lookaside buffer short-circuits address translation for recently resolved
// pages. Retrieval is the expensive translation here, so an exact repeat of a prompt within
// a session reuses its selection instead of re-embedding and re-reranking.
export function promptKey(prompt) {
  return createHash('sha256').update(String(prompt).trim().toLowerCase()).digest('hex').slice(0, 32);
}

export function memoLookup(session, prompt) {
  return session.memo?.[promptKey(prompt)];
}

export function recordMemo(session, prompt, ids, { limit = DEFAULT_MEMO_ENTRIES } = {}) {
  const key = promptKey(prompt);
  const memo = { ...session.memo };
  delete memo[key];
  const trimmed = Object.entries(memo).slice(-(Math.max(1, limit) - 1));
  session.memo = { ...Object.fromEntries(trimmed), [key]: ids };
  return session;
}

export function recordSummaries(session, ids, promptIndex) {
  session.summaries = { ...session.summaries };
  for (const id of ids) session.summaries[id] = promptIndex;
  return session;
}

// A summary already shown a few prompts ago is noise, not new information.
export function summaryIsFresh(session, id, promptIndex, repeatAfter = DEFAULT_SUMMARY_REPEAT_AFTER) {
  const shown = session.summaries?.[id];
  return shown === undefined || promptIndex - shown >= repeatAfter;
}

// Version 1 recorded only which skills were injected. Rebuild the access metadata a
// replacement policy needs, attributing every legacy skill to the first prompt so an
// upgraded session degrades to insertion order instead of failing.
function migrate(value) {
  if (!value || typeof value !== 'object') return emptySession();
  if (value.version === SESSION_VERSION && value.entries) {
    return { ...emptySession(), ...value, entries: { ...value.entries } };
  }
  const entries = {};
  for (const id of Array.isArray(value.loaded) ? value.loaded : []) {
    entries[id] = { firstPrompt: 1, lastPrompt: 1, lastInjectedPrompt: 1, hits: 1, tokens: 0 };
  }
  return {
    ...emptySession(),
    promptCount: Object.keys(entries).length ? 1 : 0,
    entries,
    updatedAt: value.updatedAt,
  };
}

// A skill dropped at compaction is no longer in the model's context, so it must leave the
// resident set. Leaving it in `entries` made `loaded` claim it was still present, and
// deduplication then blocked it from ever being injected again — the skill was lost for the
// rest of the session. ARC's ghost lists are what remember that it was evicted.
export function recordEviction(session, ids) {
  if (!ids.length) return session;
  session.entries = { ...session.entries };
  for (const id of ids) delete session.entries[id];
  return session;
}

// A refresh puts the skill's shape back in front of the model, so it restarts the decay
// clock. Without this, staleSkills keeps reporting the same skill on every later prompt.
export function recordRefresh(session, ids, promptIndex) {
  for (const id of ids) {
    const entry = session.entries[id];
    if (!entry) continue;
    session.entries[id] = { ...entry, lastPrompt: promptIndex, lastInjectedPrompt: promptIndex };
  }
  return session;
}

// `loaded` stays on every returned session so existing callers keep working unchanged.
function withLoaded(session) {
  return { ...session, loaded: Object.keys(session.entries ?? {}) };
}

export async function loadSession(stateDir, provider, sessionId) {
  if (!sessionId) return withLoaded(emptySession());
  try { return withLoaded(migrate(JSON.parse(await readFile(sessionFile(stateDir, provider, sessionId), 'utf8')))); }
  catch (error) {
    if (error.code === 'ENOENT') return withLoaded(emptySession());
    throw error;
  }
}

async function writeSession(stateDir, provider, sessionId, session) {
  const directory = path.join(stateDir, 'sessions');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = sessionFile(stateDir, provider, sessionId);
  const temporary = `${target}.${process.pid}.tmp`;
  const value = { ...session, updatedAt: new Date().toISOString() };
  delete value.loaded;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return withLoaded(value);
}

// Single read-modify-write so a prompt costs one session write no matter how many
// skills it references, injects, or refreshes.
export async function updateSession(stateDir, provider, sessionId, mutate) {
  if (!sessionId) return withLoaded(emptySession());
  const session = await loadSession(stateDir, provider, sessionId);
  const next = mutate({ ...session, entries: { ...session.entries } }) ?? session;
  return writeSession(stateDir, provider, sessionId, next);
}

// A skill the router selected again is a cache hit even when deduplication means nothing
// new is injected. Recording it is what makes recency and frequency policies possible.
export function recordAccess(session, ids, promptIndex, { residentSlots } = {}) {
  for (const id of ids) {
    const entry = session.entries[id];
    if (!entry) continue;
    session.entries[id] = { ...entry, lastPrompt: promptIndex, hits: (entry.hits ?? 0) + 1 };
    session.arc = referenceArc(session.arc, id, residentSlots);
  }
  return session;
}

export function recordInjection(session, injected, promptIndex, { residentSlots } = {}) {
  for (const { id, tokens = 0 } of injected) {
    const entry = session.entries[id];
    session.entries[id] = entry
      ? { ...entry, lastPrompt: promptIndex, lastInjectedPrompt: promptIndex, hits: (entry.hits ?? 0) + 1, tokens }
      : { firstPrompt: promptIndex, lastPrompt: promptIndex, lastInjectedPrompt: promptIndex, hits: 1, tokens };
    session.arc = referenceArc(session.arc, id, residentSlots);
  }
  return session;
}

export async function rememberLoaded(stateDir, provider, sessionId, ids, { promptIndex, tokensById = {} } = {}) {
  if (!sessionId || !ids.length) return;
  await updateSession(stateDir, provider, sessionId, (session) => {
    const at = promptIndex ?? session.promptCount ?? 0;
    return recordInjection(session, ids.map((id) => ({ id, tokens: tokensById[id] ?? 0 })), at);
  });
}

export async function clearSession(stateDir, provider, sessionId) {
  if (!sessionId) return;
  await unlink(sessionFile(stateDir, provider, sessionId)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function appendTrace(stateDir, event) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await appendFile(path.join(stateDir, 'trace.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

// The trace is append-only and never rotated, so it grows without bound over the life of an
// install. Reading it whole was harmless when only the `trace` command used it; prefetch put
// it on the per-prompt path, where whole-file reads cost time proportional to every prompt
// ever handled. Read a bounded tail instead, and grow the window only if it came up short.
const TRACE_TAIL_BYTES = 256 * 1024;

export async function readTraces(stateDir, limit = 20, { tailBytes = TRACE_TAIL_BYTES } = {}) {
  const file = path.join(stateDir, 'trace.jsonl');
  let handle;
  try { handle = await open(file, 'r'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const { size } = await handle.stat();
    for (let window = tailBytes; ; window *= 4) {
      const start = Math.max(0, size - window);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let lines = buffer.toString('utf8').split('\n').filter(Boolean);
      // A window that does not begin at the start of the file may open mid-line.
      if (start > 0) lines = lines.slice(1);
      if (lines.length >= limit || start === 0) {
        return lines.slice(-limit).map((line) => JSON.parse(line));
      }
    }
  } finally {
    await handle.close();
  }
}
