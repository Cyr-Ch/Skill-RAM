import { readRetrievalDocument } from './retrieval-index.js';
import { tokenize } from './router.js';
import { requestFileJson, requestUnixJson } from './local-http.js';

function numeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function rerankerConfiguration(options = {}) {
  return {
    reranker: options.reranker ?? process.env.SKILLRAM_RERANKER ?? 'similarity',
    rerankerUrl: options.rerankerUrl ?? process.env.SKILLRAM_RERANKER_URL ?? 'http://127.0.0.1:8765/rerank',
    rerankerIpc: options.rerankerIpc ?? process.env.SKILLRAM_SERVICE_IPC ?? null,
    rerankerSocket: options.rerankerSocket ?? process.env.SKILLRAM_SERVICE_SOCKET ?? null,
    rerankerTimeout: Math.max(1, numeric(options.rerankerTimeout ?? process.env.SKILLRAM_RERANKER_TIMEOUT, 10_000)),
    rerankThreshold: Math.max(0, Math.min(1, numeric(options.rerankThreshold ?? process.env.SKILLRAM_RERANK_THRESHOLD, 0.42))),
    allowCloudBodies: options.allowCloudBodies === true || process.env.SKILLRAM_ALLOW_CLOUD_BODIES === '1',
  };
}

function bodyOverlap(prompt, body) {
  const query = [...new Set(tokenize(prompt))];
  if (!query.length) return 0;
  const document = new Set(tokenize(body));
  return query.filter((word) => document.has(word)).length / query.length;
}

async function materialize(candidates) {
  return Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    body: await readRetrievalDocument(candidate.entry),
  })));
}

async function rerankSimilarity(prompt, candidates) {
  const full = await materialize(candidates);
  return full.map((candidate) => {
    const lexical = bodyOverlap(prompt, candidate.body);
    const score = Math.max(candidate.score, (candidate.score * 0.85) + (lexical * 0.15));
    return { ...candidate, score, confidence: score, rerankScore: lexical, method: 'embedding+body-overlap' };
  });
}

async function rerankService(prompt, candidates, config, fetchImpl) {
  const full = await materialize(candidates);
  const body = {
    prompt,
    candidates: full.map(({ entry, body: contents }) => ({ id: entry.id, name: entry.name, description: entry.description, body: contents })),
  };
  if (config.rerankerIpc) {
    const payload = await requestFileJson(config.rerankerIpc, '/rerank', { method: 'POST', body, timeout: config.rerankerTimeout });
    return serviceRanking(payload, candidates);
  }
  if (config.rerankerSocket) {
    const payload = await requestUnixJson(config.rerankerSocket, '/rerank', { method: 'POST', body, timeout: config.rerankerTimeout });
    return serviceRanking(payload, candidates);
  }
  const response = await fetchImpl(config.rerankerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.rerankerTimeout),
  });
  if (!response.ok) throw new Error(`local reranker returned HTTP ${response.status}`);
  const payload = await response.json();
  return serviceRanking(payload, candidates);
}

function serviceRanking(payload, candidates) {
  if (!Array.isArray(payload.ranked)) throw new Error('local reranker returned an invalid ranking');
  const scores = new Map(payload.ranked.map(({ id, score }) => [id, Math.max(0, Math.min(1, Number(score)))]));
  return candidates.filter(({ entry }) => Number.isFinite(scores.get(entry.id))).map((candidate) => ({
    ...candidate,
    score: scores.get(candidate.entry.id),
    confidence: scores.get(candidate.entry.id),
    rerankScore: scores.get(candidate.entry.id),
    method: 'skillrouter-rerank',
  }));
}

function extractOpenAiText(payload) {
  return payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text ?? payload.output_text;
}

function parseCloudRanking(text, allowed) {
  const parsed = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!Array.isArray(parsed.ranked)) throw new Error('cloud reranker returned invalid JSON');
  return parsed.ranked.filter(({ id, score }) => allowed.has(id) && Number.isFinite(Number(score)))
    .map(({ id, score }) => ({ id, score: Math.max(0, Math.min(1, Number(score))) }));
}

async function rerankCloud(prompt, candidates, provider, config, options, fetchImpl) {
  if (!config.allowCloudBodies) throw new Error('Cloud reranking full skill bodies requires --allow-cloud-bodies or SKILLRAM_ALLOW_CLOUD_BODIES=1.');
  const full = await materialize(candidates);
  const catalog = full.map(({ entry, body }) => ({ id: entry.id, name: entry.name, description: entry.description, body }));
  const instruction = `Rank the candidate skill documents for the user task. Return only JSON: {"ranked":[{"id":"skill-id","score":0.0}]}. Use scores from 0 to 1 and omit irrelevant skills.\nTask: ${JSON.stringify(prompt)}\nCandidates: ${JSON.stringify(catalog)}`;
  let text;
  if (provider === 'openai') {
    const key = options.openaiApiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is required for OpenAI reranking');
    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: options.model ?? 'gpt-5.6-luna', input: instruction, max_output_tokens: 500 }),
      signal: AbortSignal.timeout(config.rerankerTimeout),
    });
    if (!response.ok) throw new Error(`OpenAI reranker returned HTTP ${response.status}`);
    text = extractOpenAiText(await response.json());
  } else {
    const key = options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is required for Anthropic reranking');
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: options.model ?? 'claude-haiku-4-5', max_tokens: 500, temperature: 0, messages: [{ role: 'user', content: instruction }] }),
      signal: AbortSignal.timeout(config.rerankerTimeout),
    });
    if (!response.ok) throw new Error(`Anthropic reranker returned HTTP ${response.status}`);
    text = (await response.json()).content?.find((item) => item.type === 'text')?.text;
  }
  const ranking = parseCloudRanking(text, new Set(candidates.map(({ entry }) => entry.id)));
  const byId = new Map(candidates.map((candidate) => [candidate.entry.id, candidate]));
  return ranking.map(({ id, score }) => ({ ...byId.get(id), score, confidence: score, rerankScore: score, method: `cloud-rerank:${provider}` }));
}

export async function rerankCandidates(prompt, candidates, options = {}) {
  const config = rerankerConfiguration(options);
  if (!candidates.length || config.reranker === 'none') return candidates;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let ranked;
  if (config.reranker === 'similarity') ranked = await rerankSimilarity(prompt, candidates);
  else if (config.reranker === 'skillrouter') ranked = await rerankService(prompt, candidates, config, fetchImpl);
  else if (config.reranker === 'openai' || config.reranker === 'anthropic') ranked = await rerankCloud(prompt, candidates, config.reranker, config, options, fetchImpl);
  else throw new Error('Reranker must be none, similarity, skillrouter, openai, or anthropic.');
  return ranked.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name));
}
