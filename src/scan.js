import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SKILL_FILE = /^(skill|instructions)\.md$/i;
const PLUGIN_MANIFEST = 'plugin.json';
const IGNORED = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build']);

export function estimateTokens(text) {
  if (!text) return 0;
  const words = text.trim().match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  return Math.max(1, Math.ceil(words.length * 1.28));
}

function frontmatterValue(frontmatter, key) {
  const lines = frontmatter.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^${key}:\\s*(.*)$`, 'i'));
    if (!match) continue;
    const raw = match[1].trim();
    if (raw === '|' || raw === '>') {
      const continuation = [];
      for (index += 1; index < lines.length && (/^\s+/.test(lines[index]) || !lines[index].trim()); index += 1) {
        if (lines[index].trim()) continuation.push(lines[index].trim());
      }
      return continuation.join(raw === '>' ? ' ' : '\n');
    }
    return raw.replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return '';
}

function parseSkill(contents, file) {
  let body = contents;
  let frontmatter = '';
  let name = path.basename(path.dirname(file)) === 'commands'
    ? path.basename(file, path.extname(file))
    : path.basename(path.dirname(file));
  let description = '';

  if (contents.startsWith('---')) {
    const end = contents.indexOf('\n---', 3);
    if (end !== -1) {
      frontmatter = contents.slice(3, end).trim();
      body = contents.slice(end + 4).trim();
      name = frontmatterValue(frontmatter, 'name') || name;
      description = frontmatterValue(frontmatter, 'description');
    }
  }

  const activationText = description || frontmatter || name;
  return {
    name,
    file,
    description,
    activationTokens: estimateTokens(activationText),
    fullTokens: estimateTokens(contents),
    body,
  };
}

async function exists(target) {
  try {
    await access(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isCommandFile(target) {
  return path.basename(path.dirname(target)) === 'commands' && target.toLowerCase().endsWith('.md');
}

async function findPluginFiles(root, results, manifests, depth = 0) {
  if (depth > 8) return;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isFile() && (SKILL_FILE.test(entry.name) || isCommandFile(target))) results.push(target);
    else if (entry.isFile() && entry.name === PLUGIN_MANIFEST && path.basename(path.dirname(target)) === '.claude-plugin') manifests.push(target);
    else if (entry.isDirectory() && !IGNORED.has(entry.name)) await findPluginFiles(target, results, manifests, depth + 1);
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function enabledClaudePluginRoots(home, cwd, env) {
  const settingsFiles = [
    path.join(home, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ];
  const enabled = {};
  for (const file of settingsFiles) Object.assign(enabled, (await readJson(file))?.enabledPlugins ?? {});

  const cacheRoot = env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    ? path.join(env.CLAUDE_CODE_PLUGIN_CACHE_DIR, 'cache')
    : path.join(home, '.claude', 'plugins', 'cache');
  const roots = [];
  for (const [id, active] of Object.entries(enabled)) {
    if (!active) continue;
    const separator = id.lastIndexOf('@');
    if (separator < 1) continue;
    const plugin = id.slice(0, separator);
    const marketplace = id.slice(separator + 1);
    const pluginRoot = path.join(cacheRoot, marketplace, plugin);
    const versions = await readdir(pluginRoot, { withFileTypes: true }).catch(() => []);
    const candidates = [];
    for (const entry of versions) {
      if (!entry.isDirectory()) continue;
      const target = path.join(pluginRoot, entry.name);
      const details = await stat(target).catch(() => null);
      if (details) candidates.push({ target, modified: details.mtimeMs });
    }
    candidates.sort((a, b) => b.modified - a.modified);
    if (candidates[0]) roots.push(candidates[0].target);
  }
  return roots;
}

async function projectDirectories(cwd) {
  const directories = [];
  let current = path.resolve(cwd);
  while (true) {
    directories.push(current);
    if (await exists(path.join(current, '.git'))) return directories;
    const parent = path.dirname(current);
    if (parent === current) return [path.resolve(cwd)];
    current = parent;
  }
}

export async function defaultRoots(provider = 'claude', { home = os.homedir(), cwd = process.cwd(), env = process.env } = {}) {
  const roots = [];
  const projectDirs = await projectDirectories(cwd);
  if (provider === 'claude' || provider === 'all') {
    roots.push(path.join(home, '.claude', 'skills'), path.join(projectDirs.at(-1), '.claude', 'skills'));
    roots.push(...await enabledClaudePluginRoots(home, projectDirs.at(-1), env));
  }
  if (provider === 'codex' || provider === 'all') {
    roots.push(
      path.join(home, '.codex', 'skills'),
      path.join(home, '.agents', 'skills'),
      ...projectDirs.map((directory) => path.join(directory, '.agents', 'skills')),
    );
  }
  return roots;
}

export function defaultMarketplaceRoots() {
  const pluginsRoot = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? path.join(os.homedir(), '.claude', 'plugins');
  return [path.join(pluginsRoot, 'marketplaces')];
}

async function scanRoots(roots, source, provider) {
  const files = [];
  const manifestFiles = [];
  for (const root of roots) await findPluginFiles(root, files, manifestFiles);

  const skills = [];
  for (const file of [...new Set(files.map((item) => path.resolve(item)))]) {
    const contents = await readFile(file, 'utf8');
    skills.push({ ...parseSkill(contents, file), source, provider });
  }
  const plugins = [];
  for (const file of [...new Set(manifestFiles.map((item) => path.resolve(item)))]) {
    try {
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      plugins.push({ name: manifest.name ?? path.basename(path.dirname(path.dirname(file))), version: manifest.version ?? null, file, source, provider });
    } catch {
      plugins.push({ name: path.basename(path.dirname(path.dirname(file))), version: null, file, source, provider, invalidManifest: true });
    }
  }
  for (const root of roots) {
    const parts = path.resolve(root).split(path.sep);
    const cacheIndex = parts.lastIndexOf('cache');
    if (cacheIndex < 0 || parts.length < cacheIndex + 4) continue;
    const name = parts[cacheIndex + 2];
    if (!plugins.some((plugin) => plugin.name === name && root.startsWith(path.dirname(path.dirname(plugin.file))))) {
      plugins.push({ name, version: parts[cacheIndex + 3] ?? null, file: null, source, provider, inferred: true });
    }
  }
  return { skills, plugins };
}

export async function scanSkills(inputRoots = [], { provider = 'claude' } = {}) {
  if (provider === 'all' && !inputRoots.length) {
    const claude = await scanSkills([], { provider: 'claude' });
    const codex = await scanSkills([], { provider: 'codex' });
    return {
      roots: [...new Set([...claude.roots, ...codex.roots])],
      skills: [...claude.skills, ...codex.skills],
      plugins: [...claude.plugins, ...codex.plugins],
      marketplaceRoots: claude.marketplaceRoots,
      marketplaceSkills: claude.marketplaceSkills,
      marketplacePlugins: claude.marketplacePlugins,
      provider: 'all',
    };
  }
  const candidates = inputRoots.length ? inputRoots.map((root) => path.resolve(root)) : await defaultRoots(provider);
  const roots = [];
  for (const candidate of candidates) if ((await exists(candidate)) && !roots.includes(candidate)) roots.push(candidate);

  const active = await scanRoots(roots, 'active', provider);
  let marketplaceRoots = [];
  let marketplace = { skills: [], plugins: [] };
  if (!inputRoots.length && (provider === 'claude' || provider === 'all')) {
    for (const candidate of defaultMarketplaceRoots()) if (await exists(candidate)) marketplaceRoots.push(candidate);
    marketplace = await scanRoots(marketplaceRoots, 'marketplace', 'claude');
  }
  return {
    roots,
    skills: active.skills,
    plugins: active.plugins,
    marketplaceRoots,
    marketplaceSkills: marketplace.skills,
    marketplacePlugins: marketplace.plugins,
    provider,
  };
}

function normalizedLines(skill) {
  return new Set(skill.body.split('\n')
    .map((line) => line.trim().toLowerCase().replace(/[`*_#>-]/g, '').replace(/\s+/g, ' '))
    .filter((line) => line.length >= 36));
}

export function analyze(scan) {
  const occurrences = new Map();
  for (const skill of scan.skills) {
    for (const line of normalizedLines(skill)) occurrences.set(line, (occurrences.get(line) ?? 0) + 1);
  }
  const duplicateLines = new Set([...occurrences].filter(([, count]) => count > 1).map(([line]) => line));
  const duplicateTokens = [...occurrences].reduce((sum, [line, count]) => sum + (count > 1 ? estimateTokens(line) * (count - 1) : 0), 0);
  const duplicateBySkill = new Map();
  for (const skill of scan.skills) {
    let tokens = 0;
    for (const line of normalizedLines(skill)) if (duplicateLines.has(line)) tokens += estimateTokens(line);
    duplicateBySkill.set(skill.name, tokens);
  }

  const catalogTokens = scan.skills.reduce((sum, skill) => sum + skill.activationTokens, 0);
  const fullTokens = scan.skills.reduce((sum, skill) => sum + skill.fullTokens, 0);
  const largest = [...scan.skills].sort((a, b) => b.activationTokens - a.activationTokens)[0] ?? null;
  const providerBreakdown = Object.fromEntries(['claude', 'codex'].map((provider) => {
    const skills = scan.skills.filter((skill) => skill.provider === provider);
    const plugins = scan.plugins.filter((plugin) => plugin.provider === provider);
    return [provider, {
      skills: skills.length,
      plugins: plugins.length,
      catalogTokens: skills.reduce((sum, skill) => sum + skill.activationTokens, 0),
    }];
  }));
  return { ...scan, catalogTokens, fullTokens, duplicateTokens, duplicateBySkill, largest, providerBreakdown, tokenEstimateMethod: 'lexical-v1' };
}
