import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CHUNK_CHARS = 4_000;
const DEFAULT_CHUNK_OVERLAP = 400;

function numeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function retrievalConfiguration(options = {}) {
  const chunkChars = Math.max(500, Math.floor(numeric(options.chunkChars ?? process.env.SKILLRAM_CHUNK_CHARS, DEFAULT_CHUNK_CHARS)));
  const requestedOverlap = Math.max(0, Math.floor(numeric(options.chunkOverlap ?? process.env.SKILLRAM_CHUNK_OVERLAP, DEFAULT_CHUNK_OVERLAP)));
  return {
    chunkChars,
    chunkOverlap: Math.min(requestedOverlap, chunkChars - 1),
    embeddingBatchSize: Math.max(1, Math.floor(numeric(options.embeddingBatchSize ?? process.env.SKILLRAM_EMBEDDING_BATCH_SIZE, 16))),
  };
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function chunkText(text, { chunkChars = DEFAULT_CHUNK_CHARS, chunkOverlap = DEFAULT_CHUNK_OVERLAP } = {}) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [''];
  if (normalized.length <= chunkChars) return [normalized];
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + chunkChars);
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n', end), normalized.lastIndexOf(' ', end));
      if (boundary > start + Math.floor(chunkChars * 0.6)) end = boundary;
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - chunkOverlap);
  }
  return chunks.filter(Boolean);
}

export async function readRetrievalDocument(entry) {
  if (typeof entry.retrievalText === 'string') return entry.retrievalText;
  if (!entry.vaultSkillFile) return `${entry.name ?? ''}\n${entry.description ?? ''}`;
  return readFile(entry.vaultSkillFile, 'utf8');
}

export async function describeEntry(entry, options = {}) {
  const config = retrievalConfiguration(options);
  const contents = await readRetrievalDocument(entry);
  const contentHash = sha256(contents);
  const chunks = chunkText(contents, config).map((body, position) => {
    const text = `${entry.name} | ${entry.description ?? ''} | ${body}`;
    return { id: `${entry.id}:${position}`, position, contentHash: sha256(text), text };
  });
  return { entry, contentHash, chunks };
}

export async function buildRetrievalManifest(stateDir, index, options = {}) {
  const config = retrievalConfiguration(options);
  const described = [];
  for (const entry of index.entries) described.push(await describeEntry(entry, config));
  return writeRetrievalManifest(stateDir, described, config);
}

export async function writeRetrievalManifest(stateDir, described, options = {}) {
  const config = retrievalConfiguration(options);
  const entries = described.map((item) => ({ id: item.entry.id, contentHash: item.contentHash, chunks: item.chunks.length }));
  const existing = stateDir ? await loadRetrievalManifest(stateDir) : null;
  if (existing?.version === 2 && existing.chunkChars === config.chunkChars && existing.chunkOverlap === config.chunkOverlap
      && JSON.stringify(existing.entries) === JSON.stringify(entries)) return existing;
  const manifest = {
    version: 2,
    generatedAt: new Date().toISOString(),
    chunkChars: config.chunkChars,
    chunkOverlap: config.chunkOverlap,
    entries,
  };
  if (stateDir) await writePrivateJson(path.join(stateDir, 'retrieval-index.json'), manifest);
  return manifest;
}

export async function loadRetrievalManifest(stateDir) {
  try { return JSON.parse(await readFile(path.join(stateDir, 'retrieval-index.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read the private retrieval index: ${error.message}`);
  }
}

export async function writePrivateJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export async function ensureRetrievalManifest(stateDir, index, options = {}) {
  const config = retrievalConfiguration(options);
  const existing = stateDir ? await loadRetrievalManifest(stateDir) : null;
  if (existing?.version === 2 && existing.chunkChars === config.chunkChars && existing.chunkOverlap === config.chunkOverlap
      && existing.entries?.length === index.entries.length) {
    const known = new Set(existing.entries.map(({ id }) => id));
    if (index.entries.every(({ id }) => known.has(id))) return existing;
  }
  return buildRetrievalManifest(stateDir, index, config);
}
