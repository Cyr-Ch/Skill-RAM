import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { estimateTokens } from './scan.js';

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'this', 'to', 'use', 'when', 'with', 'you', 'your']);

export function tokenize(value) {
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map((word) => word.length > 4 ? word.replace(/(?:ing|ed|es|s)$/i, '') : word);
}

export function routeEntries(index, prompt, { top = 2, provider = 'all', minScore = 2, nameWeight = 6, descriptionWeight = 2, exactNameWeight = 12 } = {}) {
  const query = new Set(tokenize(prompt));
  if (!query.size) return [];
  return index.entries.map((entry) => {
    if (provider !== 'all' && entry.provider !== provider && entry.provider !== 'all') return { entry, score: 0, matches: [] };
    const nameWords = new Set(tokenize(entry.name));
    const descriptionWords = new Set(tokenize(entry.description));
    const matches = [];
    let score = 0;
    for (const word of query) {
      if (nameWords.has(word)) { score += nameWeight; matches.push(word); }
      if (descriptionWords.has(word)) { score += descriptionWeight; matches.push(word); }
    }
    if (prompt.toLowerCase().includes(entry.name.toLowerCase())) score += exactNameWeight;
    return { entry, score, matches: [...new Set(matches)] };
  }).filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score || a.entry.activationTokens - b.entry.activationTokens || a.entry.name.localeCompare(b.entry.name))
    .slice(0, Math.max(0, top));
}

export async function loadRoutedEntries(routed, { tokenBudget = 8000, trim = null } = {}) {
  const loaded = [];
  const skipped = [];
  const contentHashes = new Set();
  let tokens = 0;
  for (const result of routed) {
    const raw = await readFile(result.entry.vaultSkillFile, 'utf8');
    const contents = trim ? trim(raw, result) : raw;
    const cost = estimateTokens(contents);
    const contentHash = createHash('sha256').update(contents).digest('hex');
    if (contentHashes.has(contentHash)) { skipped.push({ id: result.entry.id, reason: 'duplicate-content' }); continue; }
    if (tokens + cost > tokenBudget) { skipped.push({ id: result.entry.id, reason: 'token-budget', tokens: cost }); continue; }
    loaded.push({ ...result, contents, tokens: cost });
    contentHashes.add(contentHash);
    tokens += cost;
    if (tokens >= tokenBudget) break;
  }
  return { loaded, tokens, skipped };
}

export function formatLoadedContext(loaded) {
  if (!loaded.length) return '';
  const attribute = (value) => String(value).replace(/[&"<>]/g, (character) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]);
  return ['SkillRAM selected the following task-relevant skill instructions:', ...loaded.map(({ entry, contents }) =>
    `\n<skillram-skill name="${attribute(entry.name)}" provider="${attribute(entry.provider)}" root="${attribute(path.dirname(entry.vaultSkillFile))}">\nRelative scripts, references, and assets resolve from the root path above.\n${contents}\n</skillram-skill>`),
  ].join('\n');
}
