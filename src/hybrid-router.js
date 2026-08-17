import { routeEntries } from './router.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeEntry, retrievalConfiguration, writeRetrievalManifest } from './retrieval-index.js';
import { rerankCandidates, rerankerConfiguration } from './reranker.js';
import { requestFileJson, requestUnixJson } from './local-http.js';
import { localEmbedderModel, usesLocalEmbedder } from './local-embedder.js';

// No default HTTP endpoint: the default backend is the in-process MiniLM embedder, which
// needs no server. A custom Ollama-compatible endpoint is still supported by setting
// SKILLRAM_EMBEDDING_URL explicitly, and the SkillRouter service supplies its own transport.

function numeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

let warnedEmbeddingFallback = false;
function warnEmbeddingFallback(reason) {
  if (warnedEmbeddingFallback) return;
  warnedEmbeddingFallback = true;
  process.stderr.write(
    `SkillRAM: the embedding backend was unavailable (${reason}), so routing fell back to lexical matching — much lower accuracy (about 33% vs 77% Hit@1 for the default in-process model). The default backend needs @huggingface/transformers; install it with \`npm install @huggingface/transformers\`. For higher accuracy use \`skillram models install\` + \`skillram serve\` with --router skillrouter. Pass --no-embeddings to silence this and use lexical intentionally.\n`,
  );
}

let warnedExactName = false;
function warnExactNameShortcut(poolSize, maxPool) {
  if (warnedExactName) return;
  warnedExactName = true;
  process.stderr.write(
    `SkillRAM: exact-name shortcut is enabled. It bypasses the reranker on a literal skill-name match and is only accurate on small, distinctively named libraries. Measured precision collapses on large pools (7–13% on a 6,006-skill set), so it is disabled automatically above ${maxPool} skills (this library: ${poolSize}). Unset SKILLRAM_EXACT_NAME_SHORTCUT to route every prompt through semantic retrieval and reranking.\n`,
  );
}

export function routerConfiguration(options = {}) {
  return {
    lexicalScore: numeric(options.lexicalScore ?? process.env.SKILLRAM_LEXICAL_SCORE, 6),
    lexicalMargin: numeric(options.lexicalMargin ?? process.env.SKILLRAM_LEXICAL_MARGIN, 2),
    minScore: numeric(options.minScore, 2),
    nameWeight: numeric(options.nameWeight, 6),
    descriptionWeight: numeric(options.descriptionWeight, 2),
    exactNameWeight: numeric(options.exactNameWeight, 12),
    semanticThreshold: Math.max(0, Math.min(1, numeric(options.semanticThreshold ?? process.env.SKILLRAM_SEMANTIC_THRESHOLD, 0.42))),
    semanticMargin: numeric(options.semanticMargin ?? process.env.SKILLRAM_SEMANTIC_MARGIN, 0.04),
    retrievalK: Math.max(1, Math.floor(numeric(options.retrievalK ?? process.env.SKILLRAM_RETRIEVAL_K, 20))),
    minConfidence: Math.max(0, Math.min(1, numeric(options.minConfidence ?? process.env.SKILLRAM_LLM_CONFIDENCE, 0.72))),
    embeddingTimeout: Math.max(1, numeric(options.embeddingTimeout ?? process.env.SKILLRAM_EMBEDDING_TIMEOUT, 2500)),
    embeddingModel: options.embeddingModel ?? process.env.SKILLRAM_EMBEDDING_MODEL ?? null,
    embeddingUrl: options.embeddingUrl ?? process.env.SKILLRAM_EMBEDDING_URL ?? null,
    embeddingsEnabled: options.embeddings !== false && process.env.SKILLRAM_EMBEDDINGS !== 'off',
    cloudFallback: options.routerLlm ?? process.env.SKILLRAM_ROUTER_LLM ?? null,
    embeddingBackend: options.embeddingBackend ?? process.env.SKILLRAM_EMBEDDING_BACKEND ?? null,
    // Off by default: the terminal lexical shortcut is only safe on a small, distinctively
    // named library. Opt in with SKILLRAM_EXACT_NAME_SHORTCUT=1 or exactNameShortcut: true.
    exactNameShortcut: options.exactNameShortcut ?? (process.env.SKILLRAM_EXACT_NAME_SHORTCUT === '1' || process.env.SKILLRAM_EXACT_NAME_SHORTCUT === 'true'),
    exactNameMaxPool: numeric(options.exactNameMaxPool ?? process.env.SKILLRAM_EXACT_NAME_MAX_POOL, 300),
    ...retrievalConfiguration(options),
    ...rerankerConfiguration(options),
  };
}

function candidates(index, provider) {
  return index.entries.filter((entry) => provider === 'all' || entry.provider === provider || entry.provider === 'all');
}

function cosine(left, right) {
  if (!Array.isArray(left) || left.length !== right?.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function lexicalIsConfident(routed, options = {}) {
  const lexicalScore = numeric(options.lexicalScore ?? process.env.SKILLRAM_LEXICAL_SCORE, 6);
  const lexicalMargin = numeric(options.lexicalMargin ?? process.env.SKILLRAM_LEXICAL_MARGIN, 2);
  if (!routed.length || routed[0].score < lexicalScore) return false;
  return routed.length === 1 || routed[0].score - routed[1].score >= lexicalMargin;
}

// Whole-name, word-boundary match: the "named entity" regime where lexical genuinely beats
// dense retrieval. A raw lexical score gate fires on accumulated word overlap and is only
// ~39% precise at scale, because score magnitude does not track correctness. Requiring the
// prompt to actually contain a skill's full, distinctive name is the signal that does.
function nameMatchesPrompt(name, prompt) {
  const normalized = String(name).toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word-bounded phrase; hyphen/underscore/space in the name all match a single space class.
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped.replace(/ /g, '[\\s_-]+')}(?:$|[^\\p{L}\\p{N}])`, 'u')
    .test(String(prompt).toLowerCase());
}

export function exactNameMatches(index, prompt, { minNameChars = 4, provider = 'all' } = {}) {
  const matched = [];
  for (const entry of index.entries) {
    if (provider !== 'all' && entry.provider !== provider && entry.provider !== 'all') continue;
    const name = String(entry.name ?? '');
    // A distinctive name only: skip names so short they collide with ordinary words.
    if (name.replace(/[-_\s]/g, '').length < minNameChars) continue;
    if (nameMatchesPrompt(name, prompt)) matched.push({ entry, name });
  }
  // Longest name wins so "react-review" beats a bare "react"; ties stay ambiguous.
  matched.sort((left, right) => right.name.length - left.name.length || left.entry.name.localeCompare(right.entry.name));
  return matched;
}

// Reciprocal Rank Fusion: combine ranked lists by position, not by score, because lexical
// and embedding scores live on incomparable scales. score(d) = Σ 1 / (k + rank_i(d)).
export function fuseByRrf(lists, { k = 60 } = {}) {
  const fused = new Map();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = item.entry.id;
      const current = fused.get(id) ?? { item, rrf: 0 };
      current.rrf += 1 / (k + rank + 1);
      fused.set(id, current);
    });
  }
  return [...fused.values()]
    .sort((left, right) => right.rrf - left.rrf || left.item.entry.name.localeCompare(right.item.entry.name))
    .map(({ item, rrf }) => ({ ...item, rrf }));
}

async function embedInProcess(texts, embeddingModel) {
  const { embedLocal, localEmbedderModel } = await import('./local-embedder.js');
  return validateEmbeddings(await embedLocal(texts, { model: localEmbedderModel({ embeddingModel }) }));
}

export async function requestEmbeddings(texts, { fetchImpl, embeddingUrl, embeddingModel, embeddingTimeout, embeddingIpc, embeddingSocket, inputType, embeddingBackend }) {
  // Explicitly forced in-process backend.
  if (usesLocalEmbedder({ embeddingBackend })) return embedInProcess(texts, embeddingModel);
  // Configured transports: the SkillRouter service (IPC/socket/its own URL) or a custom
  // Ollama-compatible endpoint the user pointed SKILLRAM_EMBEDDING_URL at.
  if (embeddingIpc) {
    const data = await requestFileJson(embeddingIpc, '/embed', {
      method: 'POST', timeout: embeddingTimeout,
      body: { model: embeddingModel, input: texts, input_type: inputType },
    });
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new Error('local embedding endpoint returned invalid embeddings');
    return validateEmbeddings(data.embeddings);
  }
  if (embeddingSocket) {
    const data = await requestUnixJson(embeddingSocket, '/embed', {
      method: 'POST', timeout: embeddingTimeout,
      body: { model: embeddingModel, input: texts, input_type: inputType },
    });
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new Error('local embedding endpoint returned invalid embeddings');
    return validateEmbeddings(data.embeddings);
  }
  // A custom endpoint only when one was explicitly configured.
  if (embeddingUrl) {
    const response = await fetchImpl(embeddingUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: embeddingModel, input: texts, input_type: inputType }),
      signal: AbortSignal.timeout(embeddingTimeout),
    });
    if (!response.ok) throw new Error(`local embedding endpoint returned HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new Error('local embedding endpoint returned invalid embeddings');
    return validateEmbeddings(data.embeddings);
  }
  // Default: the in-process MiniLM embedder — no server, no configuration.
  return embedInProcess(texts, embeddingModel);
}

function validateEmbeddings(embeddings) {
  const dimensions = embeddings[0]?.length;
  if (!dimensions || embeddings.some((vector) => !Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))) {
    throw new Error('local embedding endpoint returned malformed vectors');
  }
  return embeddings;
}

function embeddingKey(entry, model, contentHash, position) {
  return createHash('sha256').update(`${model}\0${entry.id}\0${contentHash}\0${position}`).digest('hex');
}

async function readEmbeddingCache(stateDir, embeddingModel) {
  if (!stateDir) return { version: 2, model: embeddingModel, vectors: {} };
  try {
    const cache = JSON.parse(await readFile(path.join(stateDir, 'embeddings.json'), 'utf8'));
    return cache.model === embeddingModel ? cache : { version: 2, model: embeddingModel, vectors: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 2, model: embeddingModel, vectors: {} };
    throw error;
  }
}

async function saveEmbeddingCache(stateDir, cache) {
  if (!stateDir) return;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(stateDir, 'embeddings.json');
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export async function routeWithEmbeddings(index, prompt, {
  provider = 'all', top = 2, fetchImpl = globalThis.fetch,
  embeddingUrl = process.env.SKILLRAM_EMBEDDING_URL ?? null,
  embeddingModel = process.env.SKILLRAM_EMBEDDING_MODEL ?? null,
  semanticThreshold, semanticMargin, embeddingTimeout, stateDir, retrievalK,
  chunkChars, chunkOverlap, embeddingBatchSize, embeddingIpc, embeddingSocket, embeddingBackend,
} = {}) {
  const entries = candidates(index, provider);
  if (!entries.length) return [];
  const retrievalConfig = retrievalConfiguration({ chunkChars, chunkOverlap, embeddingBatchSize });
  // The backend is part of the vector identity: MiniLM and 0.6B vectors are not comparable,
  // so a backend switch must invalidate the cache rather than mix incompatible embeddings.
  // With no explicit transport, the default is the in-process MiniLM embedder.
  const usesLocal = usesLocalEmbedder({ embeddingBackend }) || (!embeddingIpc && !embeddingSocket && !embeddingUrl);
  const backendTag = usesLocal ? `local:${localEmbedderModel({ embeddingModel })}` : (embeddingIpc ?? embeddingSocket ?? embeddingUrl);
  const embeddingIdentity = `${embeddingModel}\0${backendTag}`;
  const cache = await readEmbeddingCache(stateDir, embeddingIdentity);
  semanticThreshold = Math.max(0, Math.min(1, numeric(semanticThreshold ?? process.env.SKILLRAM_SEMANTIC_THRESHOLD, 0.42)));
  semanticMargin = numeric(semanticMargin ?? process.env.SKILLRAM_SEMANTIC_MARGIN, 0.04);
  embeddingTimeout = Math.max(1, numeric(embeddingTimeout ?? process.env.SKILLRAM_EMBEDDING_TIMEOUT, 2500));
  retrievalK = Math.max(top, Math.floor(numeric(retrievalK ?? process.env.SKILLRAM_RETRIEVAL_K, 20)));
  const describedAll = await Promise.all(index.entries.map((entry) => describeEntry(entry, retrievalConfig)));
  if (stateDir) await writeRetrievalManifest(stateDir, describedAll, retrievalConfig);
  const eligible = new Set(entries.map(({ id }) => id));
  const described = describedAll.filter(({ entry }) => eligible.has(entry.id));
  const validKeys = new Set(describedAll.flatMap(({ entry, chunks }) => chunks
    .map((chunk) => embeddingKey(entry, embeddingIdentity, chunk.contentHash, chunk.position))));
  let pruned = false;
  for (const key of Object.keys(cache.vectors)) {
    if (!validKeys.has(key)) { delete cache.vectors[key]; pruned = true; }
  }
  const missing = described.flatMap(({ entry, chunks }) => chunks
    .map((chunk) => ({ entry, chunk, key: embeddingKey(entry, embeddingIdentity, chunk.contentHash, chunk.position) }))
    .filter(({ key }) => !cache.vectors[key]));
  const [query] = await requestEmbeddings([prompt], { fetchImpl, embeddingUrl, embeddingModel, embeddingTimeout, embeddingIpc, embeddingSocket, embeddingBackend, inputType: 'query' });
  for (let offset = 0; offset < missing.length; offset += retrievalConfig.embeddingBatchSize) {
    const batch = missing.slice(offset, offset + retrievalConfig.embeddingBatchSize);
    const vectors = await requestEmbeddings(batch.map(({ chunk }) => chunk.text), { fetchImpl, embeddingUrl, embeddingModel, embeddingTimeout, embeddingIpc, embeddingSocket, embeddingBackend, inputType: 'document' });
    if (vectors.some((vector) => vector.length !== query.length)) throw new Error('query and document embeddings have different dimensions');
    for (let position = 0; position < batch.length; position += 1) cache.vectors[batch[position].key] = vectors[position];
  }
  if (missing.length || pruned) await saveEmbeddingCache(stateDir, cache);
  const ranked = described.map(({ entry, contentHash, chunks }) => {
    const chunkScores = chunks.map((chunk) => cosine(query, cache.vectors[embeddingKey(entry, embeddingIdentity, chunk.contentHash, chunk.position)]));
    return { entry, contentHash, score: Math.max(0, ...chunkScores), chunkScores, matches: [], method: 'embedding-full-body' };
  })
    .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name));
  if (!ranked.length || ranked[0].score < semanticThreshold) return [];
  const unique = [];
  const hashes = new Set();
  for (const result of ranked) {
    if (hashes.has(result.contentHash)) continue;
    hashes.add(result.contentHash);
    if (result.score >= semanticThreshold) unique.push({ ...result, confidence: result.score });
    if (unique.length >= retrievalK) break;
  }
  if (top === 1 && unique.length > 1 && unique[0].score - unique[1].score < semanticMargin) unique[0].ambiguous = true;
  return unique;
}

function parseSelection(text, allowed) {
  const value = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!Array.isArray(value.ids) || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error('invalid LLM router response');
  return { ids: [...new Set(value.ids)].filter((id) => allowed.has(id)), confidence: value.confidence };
}

export async function routeWithLlm(index, prompt, {
  provider = 'all', top = 2, llm, model, minConfidence, fetchImpl = globalThis.fetch,
  anthropicApiKey = process.env.ANTHROPIC_API_KEY, openaiApiKey = process.env.OPENAI_API_KEY,
} = {}) {
  const entries = candidates(index, provider);
  minConfidence = Math.max(0, Math.min(1, numeric(minConfidence ?? process.env.SKILLRAM_LLM_CONFIDENCE, 0.72)));
  if (!entries.length || !llm) return [];
  const catalog = entries.map(({ id, name, description }) => ({ id, name, description }));
  const instruction = `Select at most ${top} skills for the user prompt. Select none if evidence is weak. Return only JSON: {"ids":["id"],"confidence":0.0}.\nPrompt: ${JSON.stringify(prompt)}\nSkills: ${JSON.stringify(catalog)}`;
  let text;
  if (llm === 'anthropic') {
    if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is required for Anthropic routing');
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: model ?? 'claude-haiku-4-5', max_tokens: 200, temperature: 0, messages: [{ role: 'user', content: instruction }] }) });
    if (!response.ok) throw new Error(`Anthropic router returned HTTP ${response.status}`);
    text = (await response.json()).content?.find((item) => item.type === 'text')?.text;
  } else if (llm === 'openai') {
    if (!openaiApiKey) throw new Error('OPENAI_API_KEY is required for OpenAI routing');
    const response = await fetchImpl('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiApiKey}` }, body: JSON.stringify({ model: model ?? 'gpt-5.6-luna', input: instruction, max_output_tokens: 200 }) });
    if (!response.ok) throw new Error(`OpenAI router returned HTTP ${response.status}`);
    const data = await response.json();
    text = data.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text ?? data.output_text;
  } else throw new Error('Router LLM must be anthropic or openai');
  const selection = parseSelection(text, new Set(entries.map((entry) => entry.id)));
  if (selection.confidence < minConfidence || !selection.ids.length) return [];
  return selection.ids.slice(0, top).map((id) => ({ entry: entries.find((entry) => entry.id === id), score: selection.confidence, confidence: selection.confidence, matches: [], method: `llm:${llm}` }));
}

export async function routeHybrid(index, prompt, options = {}) {
  const config = routerConfiguration(options);
  const effective = { ...options, ...config };
  const lexical = routeEntries(index, prompt, { ...effective, top: Math.max(options.top ?? 2, 2) }).map((result) => ({ ...result, method: 'lexical' }));
  const diagnostics = options.diagnostics;
  // The terminal exact-name shortcut is opt-in and only safe where names are distinctive and
  // rarely collide with unrelated prompts — a small personal library. On a large diverse
  // pool, generic skill names appear coincidentally in prompts that do not mean them, so
  // measured precision collapses (7–13% on the 6,006-skill SKILLRET set). Even when opted in
  // it is gated on pool size and requires exactly one full-name match; at scale everything
  // defers to semantic + rerank.
  const exactNameMaxPool = effective.exactNameMaxPool;
  if (effective.exactNameShortcut) warnExactNameShortcut(index.entries.length, exactNameMaxPool);
  const named = effective.exactNameShortcut && index.entries.length <= exactNameMaxPool
    ? exactNameMatches(index, prompt, { provider: effective.provider ?? options.provider ?? 'all' })
    : [];
  const namedShortcut = named.length === 1; // strictly unambiguous only
  if (diagnostics) diagnostics.lexical = { candidates: lexical.map(({ entry, score, matches }) => ({ id: entry.id, score, matches })), exactNames: named.map(({ entry }) => entry.id), shortcut: Boolean(named.length && namedShortcut) };
  if (options.lexicalShortcut !== false && named.length && namedShortcut) {
    if (diagnostics) diagnostics.selectedMethod = 'exact-name';
    return named.slice(0, options.top ?? 2).map(({ entry }) => ({ entry, score: 1, confidence: 1, matches: [], method: 'exact-name' }));
  }
  let semanticRan = false;
  let embeddingFailure = null;
  if (options.embeddings !== false && process.env.SKILLRAM_EMBEDDINGS !== 'off') {
    try {
      const semantic = await routeWithEmbeddings(index, prompt, effective);
      semanticRan = true;
      if (diagnostics) diagnostics.embedding = { candidates: semantic.map(({ entry, score, ambiguous }) => ({ id: entry.id, score, ambiguous: Boolean(ambiguous) })), matched: Boolean(semantic.length), fullBody: true };
      if (semantic.length) {
        // Fuse the lexical candidates into the rerank pool by rank (RRF), so lexical's
        // orthogonal recall — exact terms the embedding missed — reaches the reranker, which
        // stays the terminal judge. Lexical-only additions enter with a neutral base score so
        // they cannot inflate the similarity blend; the reranker re-scores every candidate.
        const semanticIds = new Set(semantic.map(({ entry }) => entry.id));
        const lexicalExtras = lexical
          .filter(({ entry }) => !semanticIds.has(entry.id))
          .map((result) => ({ ...result, score: 0, ambiguous: false }));
        const pool = fuseByRrf([semantic, lexical]).map(({ rrf, ...item }) => item);
        const byId = new Map([...semantic, ...lexicalExtras].map((item) => [item.entry.id, item]));
        const candidates = pool.map(({ entry }) => byId.get(entry.id)).filter(Boolean).slice(0, effective.retrievalK);
        if (diagnostics) diagnostics.fusion = { poolSize: candidates.length, lexicalAdded: lexicalExtras.filter(({ entry }) => candidates.some((c) => c.entry.id === entry.id)).length };
        let reranked = candidates;
        try {
          reranked = await rerankCandidates(prompt, candidates, effective);
          if (diagnostics) diagnostics.reranker = { mode: effective.reranker, candidates: reranked.map(({ entry, score }) => ({ id: entry.id, score })) };
        } catch (error) {
          if (diagnostics) diagnostics.reranker = { mode: effective.reranker, error: error.message };
          if (options.strictRouter) throw error;
          reranked = effective.reranker !== 'similarity' ? semantic : candidates;
        }
        const accepted = reranked.filter(({ score }) => score >= effective.rerankThreshold).slice(0, options.top ?? 2);
        const ambiguous = accepted.length === 1 && accepted[0].ambiguous && effective.reranker === 'none';
        if (accepted.length && !ambiguous) {
          if (diagnostics) diagnostics.selectedMethod = accepted[0].method;
          return accepted;
        }
      }
    } catch (error) {
      embeddingFailure = error.message;
      if (diagnostics) diagnostics.embedding = { error: error.message };
      if (options.strictRouter) throw error;
    }
  } else if (diagnostics) {
    diagnostics.embedding = { skipped: true };
  }
  const llm = config.cloudFallback;
  if (llm) {
    try {
      const selected = await routeWithLlm(index, prompt, { ...effective, llm });
      if (diagnostics) diagnostics.llm = { provider: llm, matched: Boolean(selected.length) };
      if (selected.length && diagnostics) diagnostics.selectedMethod = `llm:${llm}`;
      return selected;
    } catch (error) {
      if (diagnostics) diagnostics.llm = { provider: llm, error: error.message };
      if (options.strictRouter) throw error;
    }
  }
  // Graceful degradation: when the semantic path was unavailable — embeddings disabled or
  // the model service unreachable — fall back to the lexical candidates instead of
  // abstaining. This is a last resort, not the old confident shortcut, so its confidence is
  // capped low. When the model actually ran and rejected everything, that is a real
  // abstention and lexical does not override it.
  if (!semanticRan && lexical.length) {
    // Warn only when embeddings were wanted but unreachable — an intentional --no-embeddings
    // run degrades quietly. This is the silent-degradation guardrail: without it, a down
    // backend leaves the user on the weak lexical path with no signal.
    if (effective.embeddingsEnabled) warnEmbeddingFallback(embeddingFailure ?? 'no endpoint reachable');
    if (diagnostics) diagnostics.selectedMethod = 'lexical-fallback';
    return lexical.slice(0, options.top ?? 2).map((result) => ({
      ...result, method: 'lexical', confidence: Math.min(0.6, result.score / 20),
    }));
  }
  if (diagnostics) diagnostics.selectedMethod = null;
  return [];
}
