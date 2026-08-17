#!/usr/bin/env node
// Build a scaled session suite for the memory hierarchy from the public SKILLRET corpus.
//
// SKILLRET is single-shot: independent queries, each with gold skills. The memory hierarchy
// only shows itself across ordered turns, so sessions are synthesised by grouping real
// queries into archetypes with deliberate access patterns. The skills, queries, and
// relevance labels stay real; only the ORDER is constructed.
//
// Archetypes, and what each is meant to expose:
//   focused    repeated work on one skill            -> deduplication / reuse rate
//   drift      a task walking A -> B -> C -> D       -> working set, eviction under budget
//   return     heavy use of A, dormancy, then A again-> ARC (frequency) vs LRU (recency)
//   interleave A B A B alternating                   -> thrash resistance
//   negative   queries whose gold skill is held out  -> abstention; nothing should load
//
// `return` is the discriminating archetype. A skill used often and then left dormant is
// exactly the case where recency-only eviction throws away something frequency would keep,
// so it is the one pattern that can separate the policies the smoke suite cannot.
//
// Usage:
//   node scripts/build-session-suite.mjs --pool 1500 --out benchmarks/session.skillret.json

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const ROOT = args.get('data') ?? 'datasets/SKILLRET/data';
const POOL = Number(args.get('pool') ?? 1500);
const PER_ARCHETYPE = Number(args.get('sessions') ?? 6);
const SEED = args.get('seed') ?? 'skillram-session-v1';
const MAX_BODY = Number(args.get('max-body-chars') ?? 4000);
const OUT = args.get('out') ?? 'benchmarks/session.skillret.json';
// SKILLRET contains real offensive-security skills whose bodies trip on-access antivirus,
// which quarantines the file mid-scan. The benchmark reads bodies only for token accounting
// and section headings, never for the exploit content itself, so bodies are replaced with a
// neutral rendering of the same section structure at a comparable length. Disable only in a
// sandbox with no endpoint security: --neutralize-bodies false.
const NEUTRALIZE = (args.get('neutralize-bodies') ?? 'true') !== 'false';

// Deterministic ordering without Math.random, matching the Python sampler's approach.
const rank = (value) => parseInt(createHash('sha256').update(`${SEED}\0${value}`).digest('hex').slice(0, 12), 16);

async function* readJsonl(file) {
  const stream = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of stream) if (line.trim()) yield JSON.parse(line);
}

// Keeps the heading skeleton that drives the summary tier and section-granularity paths,
// replaces every prose line with deterministic filler of similar length, and never emits the
// original body text. Length is preserved so token-cost accounting stays realistic.
function neutralizeBody(body, name) {
  const lines = String(body).split(/\r?\n/);
  let inFront = lines[0]?.trim() === '---';
  const out = [`# ${name}`, `Synthetic body for the SkillRAM session benchmark. Original content omitted.`];
  for (const line of lines) {
    const trimmed = line.trim();
    if (inFront) { if (trimmed === '---' && out.length) inFront = false; continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) { out.push(`${heading[1]} ${heading[2].replace(/[^\p{L}\p{N}\s-]/gu, '').trim() || 'Section'}`); continue; }
    if (!trimmed) continue;
    // one neutral sentence, sized to the original line's word count
    const words = Math.max(4, Math.min(40, trimmed.split(/\s+/).length));
    out.push(Array.from({ length: words }, (_, i) => (i === 0 ? 'This' : ['step', 'uses', 'the', 'documented', 'workflow', 'and', 'inputs'][i % 7])).join(' ') + '.');
  }
  return out.join('\n');
}

function safeName(name, id) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';
  return `${base}-${createHash('sha256').update(id).digest('hex').slice(0, 6)}`;
}

console.error(`Reading ${ROOT} ...`);
const queries = [];
for await (const row of readJsonl(path.join(ROOT, 'queries/test.jsonl'))) queries.push(row);

const gold = new Map();
for await (const row of readJsonl(path.join(ROOT, 'qrels/test.jsonl'))) {
  if (Number(row.relevance) <= 0) continue;
  const key = String(row.query_id);
  if (!gold.has(key)) gold.set(key, new Set());
  gold.get(key).add(String(row.skill_id));
}

// Queries grouped by their single gold skill. Multi-gold queries are skipped: a turn with an
// ambiguous target cannot cleanly attribute a residency outcome to the policy under test.
const bySkill = new Map();
for (const query of queries) {
  const ids = gold.get(String(query.id));
  if (!ids || ids.size !== 1) continue;
  const skillId = [...ids][0];
  if (!bySkill.has(skillId)) bySkill.set(skillId, []);
  bySkill.get(skillId).push({ id: String(query.id), text: String(query.query ?? '') });
}

// Skills with several queries can support focused and returning sessions; the rest are pool.
const usable = [...bySkill.entries()]
  .filter(([, list]) => list.length >= 2)
  .sort(([leftId], [rightId]) => rank(leftId) - rank(rightId));
console.error(`${bySkill.size} single-gold skills, ${usable.length} with 2+ queries.`);

// Each archetype claims a disjoint block: focused needs 1 skill per session, drift 4, and
// return 4. Under-allocating here silently produced fewer sessions than requested, so the
// budget is computed and checked rather than assumed.
const FOCUSED_SKILLS = 1;
const DRIFT_SKILLS = 4;
const RETURN_SKILLS = 4;
const NEEDED = PER_ARCHETYPE * (FOCUSED_SKILLS + DRIFT_SKILLS + RETURN_SKILLS);
const HELD_OUT = PER_ARCHETYPE * 2;
if (usable.length < NEEDED + HELD_OUT) {
  throw new Error(`Need ${NEEDED + HELD_OUT} skills with 2+ queries for --sessions ${PER_ARCHETYPE}, but only ${usable.length} exist. Lower --sessions to at most ${Math.floor(usable.length / (FOCUSED_SKILLS + DRIFT_SKILLS + RETURN_SKILLS + 2))}.`);
}

const archetypeSkills = usable.slice(0, NEEDED).map(([id]) => id);
const wantedIds = new Set(archetypeSkills);

// Held-out skills power the negative archetype: their queries are real and answerable, but
// the skill is deliberately absent from the vault, so the correct behaviour is to load nothing.
const heldOut = usable.slice(NEEDED, NEEDED + HELD_OUT).map(([id]) => id);

console.error('Streaming skills ...');
const skills = [];
const chosen = new Map();
const distractors = [];
for await (const row of readJsonl(path.join(ROOT, 'skills/test.jsonl'))) {
  const id = String(row.id);
  if (heldOut.includes(id)) continue;
  const record = {
    id,
    name: safeName(row.name, id),
    description: String(row.description ?? '').slice(0, 300),
    body: (() => {
      const raw = String(row.skill_md ?? row.body ?? '').slice(0, MAX_BODY);
      return NEUTRALIZE ? neutralizeBody(raw, safeName(row.name, id)) : raw;
    })(),
  };
  if (wantedIds.has(id)) chosen.set(id, record);
  else distractors.push(record);
}

// Fill the remaining pool budget with deterministic distractors so retrieval faces a
// realistic corpus rather than only the skills the sessions need.
distractors.sort((left, right) => rank(left.id) - rank(right.id));
const pool = [...chosen.values(), ...distractors.slice(0, Math.max(0, POOL - chosen.size))];
const nameById = new Map(pool.map((skill) => [skill.id, skill.name]));
console.error(`Pool: ${pool.length} skills (${chosen.size} targeted, ${pool.length - chosen.size} distractors).`);

const queriesFor = (skillId, count) => (bySkill.get(skillId) ?? [])
  .slice()
  .sort((left, right) => rank(left.id) - rank(right.id))
  .slice(0, count);

const sessions = [];
const take = (offset, count) => archetypeSkills.slice(offset, offset + count);

for (let index = 0; index < PER_ARCHETYPE; index += 1) {
  // focused: the same skill across several phrasings of the task
  const focus = take(index, 1)[0];
  if (focus && nameById.has(focus)) {
    const turns = queriesFor(focus, 3).map((query) => ({ prompt: query.text, expectResident: [nameById.get(focus)] }));
    if (turns.length >= 2) sessions.push({ id: `focused-${index}`, archetype: 'focused', turns });
  }

  // drift: a task moving through unrelated skills, compacting once it cannot all fit
  const walk = take(PER_ARCHETYPE * FOCUSED_SKILLS + index * DRIFT_SKILLS, DRIFT_SKILLS).filter((id) => nameById.has(id));
  if (walk.length === DRIFT_SKILLS) {
    const turns = walk.map((id) => ({ prompt: queriesFor(id, 1)[0].text, expectResident: [nameById.get(id)] }));
    sessions.push({
      id: `drift-${index}`, archetype: 'drift', turns,
      compactAfter: [3], compactBudget: 3000,
      compactExpect: walk.slice(2).map((id) => nameById.get(id)),
    });
  }

  // return: A used repeatedly, then a long gap, then A again. Recency-only eviction should
  // lose A across the compaction; a frequency-aware policy should keep it.
  const [hot, ...cold] = take(PER_ARCHETYPE * (FOCUSED_SKILLS + DRIFT_SKILLS) + index * RETURN_SKILLS, RETURN_SKILLS).filter((id) => nameById.has(id));
  const hotQueries = hot ? queriesFor(hot, 2) : [];
  if (hot && cold.length === 3 && hotQueries.length === 2) {
    const turns = [
      { prompt: hotQueries[0].text, expectResident: [nameById.get(hot)] },
      { prompt: hotQueries[1].text, expectResident: [nameById.get(hot)] },
      ...cold.map((id) => ({ prompt: queriesFor(id, 1)[0].text, expectResident: [nameById.get(id)] })),
      { prompt: hotQueries[0].text, expectResident: [nameById.get(hot)] },
    ];
    sessions.push({
      id: `return-${index}`, archetype: 'return', turns,
      compactAfter: [4], compactBudget: 3000,
      compactExpect: [nameById.get(hot)],
      note: 'The frequently used skill must survive compaction despite being dormant for three turns.',
    });
  }
}

// negative: real queries whose gold skill was excluded from the vault entirely.
const negativeTurns = heldOut
  .flatMap((id) => queriesFor(id, 1))
  .slice(0, PER_ARCHETYPE * 2)
  .map((query) => ({ prompt: query.text, expectResident: [] }));
if (negativeTurns.length) {
  sessions.push({
    id: 'negative-held-out', archetype: 'negative', turns: negativeTurns,
    note: 'The gold skill for each query is absent from the pool, so the correct outcome is to load nothing.',
  });
}

const suite = {
  name: 'skillram-session-skillret',
  note: [
    'Generated from the public SKILLRET v1.1 test split. Skills, queries, and relevance labels are real;',
    'session ORDER is synthesised, because SKILLRET has no notion of a session. Bodies are truncated to',
    `${MAX_BODY} characters to keep the suite loadable, which weakens full-body retrieval relative to the`,
    'unmodified corpus. Session archetypes are described in scripts/build-session-suite.mjs.',
  ].join(' '),
  source: { dataset: 'SKILLRET', split: 'test', seed: SEED, poolSize: pool.length, maxBodyChars: MAX_BODY, heldOutSkills: heldOut.length, neutralizedBodies: NEUTRALIZE },
  skills: pool,
  sessions,
};

await writeFile(OUT, `${JSON.stringify(suite, null, 2)}\n`);
const turnCount = sessions.reduce((sum, session) => sum + session.turns.length, 0);
const byArchetype = sessions.reduce((acc, session) => ({ ...acc, [session.archetype]: (acc[session.archetype] ?? 0) + 1 }), {});
console.error(`Wrote ${OUT}: ${pool.length} skills, ${sessions.length} sessions, ${turnCount} turns.`);
console.error('Archetypes:', JSON.stringify(byArchetype));
for (const [archetype, expected] of [['focused', PER_ARCHETYPE], ['drift', PER_ARCHETYPE], ['return', PER_ARCHETYPE]]) {
  const built = byArchetype[archetype] ?? 0;
  if (built < expected) console.error(`WARNING: ${archetype} produced ${built} of ${expected} sessions; the corpus ran out of skills with enough queries.`);
}
