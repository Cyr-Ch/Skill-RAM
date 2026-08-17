import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { estimateTokens } from './scan.js';

// Write-back for things a session learns about a skill ("this repo uses pnpm, not npm").
//
// A dirty cache line is eventually written back to memory. The equivalent here deliberately
// stops short of that: amendments are stored as overlays inside the SkillRAM state
// directory and composed at load time, and the vaulted SKILL.md is never modified. Vaulting
// promises to hand a skill back byte-identical on uninstall, and silently rewriting a
// user's skill body to persist an inference the agent drew would break that promise in a
// way that is hard to notice and harder to undo.
//
// Overlays are user-authored content, not derived cache, so restoring the vault leaves them
// in place; `clearOverlay` is the way to remove one.
export const DEFAULT_MAX_NOTES = 12;
export const DEFAULT_OVERLAY_TOKENS = 400;

function overlayDirectory(stateDir) {
  return path.join(stateDir, 'overlays');
}

// Skill ids come from the index rather than user input, but the id reaches the filesystem
// here, so keep the encoding total and collision-free instead of trusting the shape.
function overlayFile(stateDir, id) {
  return path.join(overlayDirectory(stateDir), `${Buffer.from(String(id)).toString('base64url')}.json`);
}

export async function loadOverlay(stateDir, id) {
  try {
    const value = JSON.parse(await readFile(overlayFile(stateDir, id), 'utf8'));
    return { id, notes: Array.isArray(value.notes) ? value.notes : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { id, notes: [] };
    throw error;
  }
}

export async function loadOverlays(stateDir, ids) {
  const overlays = new Map();
  for (const id of new Set(ids)) {
    const overlay = await loadOverlay(stateDir, id);
    if (overlay.notes.length) overlays.set(id, overlay);
  }
  return overlays;
}

export async function addOverlayNote(stateDir, id, text, { sessionId = null, promptIndex = null, maxNotes = DEFAULT_MAX_NOTES } = {}) {
  const note = String(text ?? '').trim();
  if (!note) throw new Error('An overlay note cannot be empty.');
  const overlay = await loadOverlay(stateDir, id);
  // Same fact learned twice is one fact.
  const notes = overlay.notes.filter((existing) => existing.text !== note);
  notes.push({ text: note, sessionId, promptIndex, at: new Date().toISOString() });
  const value = { id, notes: notes.slice(-Math.max(1, maxNotes)) };
  const directory = overlayDirectory(stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = overlayFile(stateDir, id);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return value;
}

export async function clearOverlay(stateDir, id) {
  await unlink(overlayFile(stateDir, id)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function listOverlays(stateDir) {
  let files = [];
  try { files = await readdir(overlayDirectory(stateDir)); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const overlays = [];
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const id = Buffer.from(path.basename(file, '.json'), 'base64url').toString('utf8');
    const overlay = await loadOverlay(stateDir, id);
    if (overlay.notes.length) overlays.push(overlay);
  }
  return overlays.sort((left, right) => left.id.localeCompare(right.id));
}

// Appended, never interleaved, and clearly labelled: the agent must be able to tell the
// skill author's instructions from what a session inferred.
export function applyOverlay(contents, overlay, { maxTokens = DEFAULT_OVERLAY_TOKENS } = {}) {
  if (!overlay?.notes?.length) return contents;
  const kept = [];
  let spent = 0;
  for (const note of [...overlay.notes].reverse()) {
    const cost = estimateTokens(note.text);
    if (kept.length && spent + cost > maxTokens) break;
    kept.unshift(note);
    spent += cost;
  }
  if (!kept.length) return contents;
  const lines = kept.map(({ text }) => `- ${text}`).join('\n');
  return `${contents}\n\n<skillram-overlay note="learned in earlier sessions, not part of the original skill">\n${lines}\n</skillram-overlay>`;
}
