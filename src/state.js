import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function resolveStateDir(value) {
  return path.resolve(value ?? process.env.SKILLRAM_HOME ?? path.join(os.homedir(), '.skillram'));
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot parse ${file}: ${error.message}`);
  }
}

export async function loadState(stateDir) {
  return await readJson(path.join(stateDir, 'state.json'), {
    version: 1,
    installedAt: null,
    entries: [],
    moves: [],
    integrations: [],
  });
}

export async function saveState(stateDir, state) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(stateDir, 'state.json');
  const temporary = path.join(stateDir, `.state-${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export function statePaths(stateDir) {
  return {
    state: path.join(stateDir, 'state.json'),
    index: path.join(stateDir, 'index.json'),
    vault: path.join(stateDir, 'vault'),
    runtime: path.join(stateDir, 'runtime'),
  };
}

export async function writeIndex(stateDir, entries) {
  const paths = statePaths(stateDir);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const compact = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: entries.map(({ id, provider, name, description, activationTokens, fullTokens, vaultSkillFile }) => ({
      id, provider, name, description: description.slice(0, 320), activationTokens, fullTokens, vaultSkillFile,
    })),
  };
  await writeFile(paths.index, `${JSON.stringify(compact)}\n`, { mode: 0o600 });
  return compact;
}

export async function loadIndex(stateDir) {
  const index = await readJson(statePaths(stateDir).index);
  if (!index) throw new Error(`No SkillRAM index found at ${statePaths(stateDir).index}. Run “skillram install” first.`);
  return index;
}
