// Replacement policies for the session-resident skill set.
//
// Skills vary in size by an order of magnitude, and ARC assumes uniform pages, so the two
// concerns are kept separate: a policy decides *priority*, and the caller admits skills in
// that priority order until the token budget is spent. That keeps ARC's semantics intact
// instead of bending them around variable-cost entries.

export const POLICIES = ['arc', 'lru', 'lfu', 'index'];
export const DEFAULT_RESIDENT_SLOTS = 16;

export function emptyArc() {
  return { t1: [], t2: [], b1: [], b2: [], p: 0 };
}

function without(list, id) {
  const next = list.filter((value) => value !== id);
  return next.length === list.length ? null : next;
}

// ARC replacement: evict from T1 when it exceeds the adaptive target p, otherwise from T2.
// The evicted id moves to the matching ghost list so a later reference can retune p.
function replace(arc, id, capacity) {
  const inB2 = arc.b2.includes(id);
  if (arc.t1.length && (arc.t1.length > arc.p || (inB2 && arc.t1.length === arc.p))) {
    const victim = arc.t1[0];
    arc.t1 = arc.t1.slice(1);
    arc.b1 = [...arc.b1, victim].slice(-capacity);
  } else if (arc.t2.length) {
    const victim = arc.t2[0];
    arc.t2 = arc.t2.slice(1);
    arc.b2 = [...arc.b2, victim].slice(-capacity);
  }
}

export function referenceArc(state, id, capacity = DEFAULT_RESIDENT_SLOTS) {
  const arc = { ...emptyArc(), ...state };
  const fromT1 = without(arc.t1, id);
  if (fromT1) { arc.t1 = fromT1; arc.t2 = [...arc.t2, id]; return arc; }
  const fromT2 = without(arc.t2, id);
  if (fromT2) { arc.t2 = [...fromT2, id]; return arc; }

  const fromB1 = without(arc.b1, id);
  if (fromB1) {
    const delta = arc.b1.length ? Math.max(1, Math.round(arc.b2.length / arc.b1.length)) : 1;
    arc.p = Math.min(capacity, arc.p + delta);
    replace(arc, id, capacity);
    arc.b1 = fromB1;
    arc.t2 = [...arc.t2, id];
    return arc;
  }
  const fromB2 = without(arc.b2, id);
  if (fromB2) {
    const delta = arc.b2.length ? Math.max(1, Math.round(arc.b1.length / arc.b2.length)) : 1;
    arc.p = Math.max(0, arc.p - delta);
    replace(arc, id, capacity);
    arc.b2 = fromB2;
    arc.t2 = [...arc.t2, id];
    return arc;
  }

  if (arc.t1.length + arc.t2.length >= capacity) replace(arc, id, capacity);
  arc.t1 = [...arc.t1, id];
  arc.b1 = arc.b1.slice(-capacity);
  arc.b2 = arc.b2.slice(-capacity);
  return arc;
}

// Highest priority first. Frequent (T2) outranks recent-once (T1); within each list the
// most recently referenced wins. Anything the ARC state has not seen falls back to recency.
function arcOrder(ids, session) {
  const arc = { ...emptyArc(), ...(session.arc ?? {}) };
  const rank = new Map();
  arc.t1.forEach((id, position) => rank.set(id, [1, position]));
  arc.t2.forEach((id, position) => rank.set(id, [2, position]));
  return [...ids].sort((left, right) => {
    const [leftList = 0, leftPosition = 0] = rank.get(left) ?? [];
    const [rightList = 0, rightPosition = 0] = rank.get(right) ?? [];
    if (leftList !== rightList) return rightList - leftList;
    if (leftList === 0) return lastPrompt(session, right) - lastPrompt(session, left);
    return rightPosition - leftPosition;
  });
}

function lastPrompt(session, id) {
  return session.entries?.[id]?.lastPrompt ?? 0;
}

function hits(session, id) {
  return session.entries?.[id]?.hits ?? 0;
}

// Denning's working set: everything referenced in the last `window` prompts. These are the
// skills the current task is actually using, so they are restored before anything else
// rather than competing on recency alone against skills the session has moved past.
export const DEFAULT_WORKING_SET_WINDOW = 10;

export function workingSet(session, { promptIndex, window = DEFAULT_WORKING_SET_WINDOW } = {}) {
  const now = promptIndex ?? session.promptCount ?? 0;
  return Object.entries(session.entries ?? {})
    .filter(([, entry]) => (entry.lastPrompt ?? 0) > now - window)
    .map(([id]) => id);
}

// Working set first, then everything else, each ordered by the replacement policy.
export function restoreOrder(session, ids, { policy = 'arc', promptIndex, window } = {}) {
  const resident = new Set(workingSet(session, { promptIndex, window }));
  const inSet = policyOrder(session, ids.filter((id) => resident.has(id)), { policy });
  const evictable = policyOrder(session, ids.filter((id) => !resident.has(id)), { policy });
  return [...inSet, ...evictable];
}

// DRAM cells lose charge and must be rewritten before they decay. A skill injected many
// turns ago is still nominally resident, but the model's attention over it has faded, so a
// still-relevant skill past `refreshAfter` prompts gets its shape restated compactly.
export const DEFAULT_REFRESH_AFTER = 20;

export function staleSkills(session, ids, { promptIndex, refreshAfter = DEFAULT_REFRESH_AFTER } = {}) {
  const now = promptIndex ?? session.promptCount ?? 0;
  return ids.filter((id) => {
    const entry = session.entries?.[id];
    if (!entry) return false;
    const injected = entry.lastInjectedPrompt ?? entry.firstPrompt ?? 0;
    return injected > 0 && now - injected >= refreshAfter;
  });
}

export function policyOrder(session, ids, { policy = 'arc' } = {}) {
  if (policy === 'index') return [...ids];
  if (policy === 'lru') return [...ids].sort((left, right) => lastPrompt(session, right) - lastPrompt(session, left));
  if (policy === 'lfu') {
    return [...ids].sort((left, right) => hits(session, right) - hits(session, left)
      || lastPrompt(session, right) - lastPrompt(session, left));
  }
  return arcOrder(ids, session);
}
