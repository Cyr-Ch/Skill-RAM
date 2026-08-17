import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, readdir, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { analyze, defaultRoots, estimateTokens, scanSkills } from '../src/scan.js';
import { receiptData, receiptText } from '../src/format.js';
import { generateRoast, roastFacts } from '../src/roast.js';
import { writeReceiptSvg } from '../src/svg.js';
import { restoreVault, vaultSkills, vaultMeasurements } from '../src/vault.js';
import { loadIndex, loadState } from '../src/state.js';
import { handleAgentHook, handlePromptHook, loadSelection, rebuildRetrievalIndex, routePrompt } from '../src/runtime.js';
import { installIntegrations, removeIntegrations } from '../src/integrations.js';
import { routeHybrid, routeWithEmbeddings } from '../src/hybrid-router.js';
import { loadSession, readTraces } from '../src/session.js';
import { emptyArc, policyOrder, referenceArc, restoreOrder, staleSkills } from '../src/memory-policy.js';
import { recordRefresh } from '../src/session.js';
import { buildCooccurrence, predictNext } from '../src/prefetch.js';
import { selectSections } from '../src/skill-summary.js';
import { addOverlayNote, applyOverlay, clearOverlay, listOverlays, loadOverlay } from '../src/overlay.js';
import { loadSessionSuite, runSessionBenchmark } from '../src/session-benchmark.js';
import { planSessions, runMemoryReplay } from '../src/memory-replay.js';
import { createHash } from 'node:crypto';
import { runDoctor } from '../src/doctor.js';
import { runBenchmark } from '../src/benchmark.js';
import { chunkText, loadRetrievalManifest } from '../src/retrieval-index.js';
import { rerankCandidates } from '../src/reranker.js';
import { loadRoutedEntries } from '../src/router.js';
import { scorePublicPredictions, scoreSkillRetPredictions, scoreSkillRouterPredictions } from '../src/public-benchmark.js';
import { modelStatus, serveSkillRouter } from '../src/models.js';
import { requestFileJson } from '../src/local-http.js';
import { buildEvaluationReport, saveEvaluationReport } from '../src/evaluation-report.js';
import { evaluationStatus } from '../src/evaluation-status.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillram-'));
  for (const [name, description] of [['react-review', 'Review React components for correctness and performance'], ['react-performance', 'Optimize React rendering and component performance']]) {
    const directory = path.join(root, name);
    await mkdir(directory);
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nAlways measure the component before making optimization recommendations.\nUse evidence from the profiler.\n`);
  }
  return root;
}

function runHookProcess(bin, stateDir, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'hook', '--provider', 'claude'], { env: { ...process.env, SKILLRAM_HOME: stateDir } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(input));
  });
}

test('estimates tokens deterministically', () => {
  assert.equal(estimateTokens('hello world'), 3);
  assert.equal(estimateTokens(''), 0);
});

test('parses folded YAML descriptions used by real skills', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillram-yaml-'));
  const directory = path.join(root, 'folded');
  await mkdir(directory);
  await writeFile(path.join(directory, 'SKILL.md'), '---\nname: folded\ndescription: >\n  Use this skill when reviewing\n  a TypeScript service.\n---\nDo the review.');
  const scan = await scanSkills([root]);
  assert.equal(scan.skills[0].description, 'Use this skill when reviewing a TypeScript service.');
  assert.ok(scan.skills[0].activationTokens > 3);
});

test('scans, analyzes, and formats skill receipts', async () => {
  const report = analyze(await scanSkills([await fixture()]));
  assert.equal(report.skills.length, 2);
  assert.equal(report.plugins.length, 0);
  assert.ok(report.catalogTokens > 0);
  assert.equal(report.duplicateTokens, estimateTokens('always measure the component before making optimization recommendations.'));
  assert.match(report.largest.name, /^react-/);
  assert.match(receiptText(report), /YOUR CLAUDE SKILL RECEIPT/);
  assert.equal(receiptData(report).installedSkills, 2);
  assert.equal(receiptData(report).provider, 'claude');
  assert.equal(roastFacts(report).overlapTopics[0].topic, 'react');
});

test('keeps Claude and Codex roots isolated', async () => {
  const home = '/tmp/fake-home';
  const cwd = '/tmp/fake-project';
  const claude = await defaultRoots('claude', { home, cwd, env: {} });
  const codex = await defaultRoots('codex', { home, cwd, env: {} });
  assert.ok(claude.some((root) => root.includes('/.claude/skills')));
  assert.ok(claude.every((root) => !root.includes('/.codex/')));
  assert.ok(codex.some((root) => root.includes('/.codex/skills')));
  assert.ok(codex.every((root) => !root.includes('/.claude/')));
});

test('includes only enabled Claude plugin cache roots', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'skillram-home-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'skillram-project-'));
  const settings = path.join(home, '.claude');
  await mkdir(settings, { recursive: true });
  await writeFile(path.join(settings, 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@market': true, 'disabled@market': false } }));
  const enabledRoot = path.join(home, '.claude', 'plugins', 'cache', 'market', 'demo', '1.0.0');
  const disabledRoot = path.join(home, '.claude', 'plugins', 'cache', 'market', 'disabled', '1.0.0');
  await mkdir(enabledRoot, { recursive: true });
  await mkdir(disabledRoot, { recursive: true });
  const roots = await defaultRoots('claude', { home, cwd, env: {} });
  assert.ok(roots.includes(enabledRoot));
  assert.ok(!roots.includes(disabledRoot));
});

test('discovers plugin manifests and legacy command skills', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillram-plugin-'));
  await mkdir(path.join(root, 'demo', '.claude-plugin'), { recursive: true });
  await mkdir(path.join(root, 'demo', 'commands'), { recursive: true });
  await writeFile(path.join(root, 'demo', '.claude-plugin', 'plugin.json'), '{"name":"demo","version":"1.2.3"}');
  await writeFile(path.join(root, 'demo', 'commands', 'review.md'), '---\ndescription: Review this change\n---\nReview the selected code.');
  const scan = await scanSkills([root]);
  assert.equal(scan.plugins.length, 1);
  assert.equal(scan.plugins[0].name, 'demo');
  assert.equal(scan.skills.length, 1);
  assert.equal(scan.skills[0].name, 'review');
});

test('counts enabled cached plugins without optional manifests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cache'));
  const pluginRoot = path.join(root, 'cache', 'market', 'manifestless', '2.0.0');
  await mkdir(path.join(pluginRoot, 'skills', 'demo'), { recursive: true });
  await writeFile(path.join(pluginRoot, 'skills', 'demo', 'SKILL.md'), '---\ndescription: Do a demo task\n---\nDo the task.');
  const scan = await scanSkills([pluginRoot]);
  assert.equal(scan.plugins.length, 1);
  assert.equal(scan.plugins[0].name, 'manifestless');
  assert.equal(scan.plugins[0].inferred, true);
});

test('writes a privacy-safe SVG card', async () => {
  const root = await fixture();
  const report = analyze(await scanSkills([root]));
  const output = path.join(root, 'receipt.svg');
  await writeReceiptSvg(report, output);
  const svg = await readFile(output, 'utf8');
  assert.match(svg, /SKILLRAM \/ CLAUDE RECEIPT/);
  assert.doesNotMatch(svg, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('generates a roast from aggregate facts only', async () => {
  const report = analyze(await scanSkills([await fixture()]));
  let request;
  const result = await generateRoast(report, {
    llm: 'anthropic',
    anthropicApiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Two React skills walk into a context window.' }] }) };
    },
  });
  assert.equal(result, 'Two React skills walk into a context window.');
  assert.doesNotMatch(JSON.stringify(request.messages), /react-review/);
  assert.match(JSON.stringify(request.messages), /estimatedActivationTokens/);
});

test('requires an API key for LLM roasts', async () => {
  const report = analyze(await scanSkills([await fixture()]));
  await assert.rejects(() => generateRoast(report, { anthropicApiKey: '', openaiApiKey: '' }), /ANTHROPIC_API_KEY or OPENAI_API_KEY/);
});

test('generates roasts with the OpenAI Responses API', async () => {
  const report = analyze(await scanSkills([await fixture()]));
  let url;
  let request;
  const result = await generateRoast(report, {
    llm: 'openai',
    openaiApiKey: 'openai-test-key',
    fetchImpl: async (target, options) => {
      url = target;
      request = { headers: options.headers, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: 'Your catalog has two React experts and one context window.' }] }] }) };
    },
  });
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(request.headers.authorization, 'Bearer openai-test-key');
  assert.equal(request.body.model, 'gpt-5.6-luna');
  assert.doesNotMatch(request.body.input, /react-review/);
  assert.match(result, /two React experts/);
});

test('vaults, routes, injects, measures, and restores skills', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-state-'));
  const original = await readFile(path.join(root, 'react-performance', 'SKILL.md'), 'utf8');
  const installed = await vaultSkills({ inputRoots: [root], provider: 'claude', stateDir });
  assert.equal(installed.applied, true);
  assert.equal(installed.entries.length, 2);
  await assert.rejects(access(path.join(root, 'react-performance', 'SKILL.md')));

  const index = await loadIndex(stateDir);
  assert.equal(index.entries.length, 2);
  assert.doesNotMatch(JSON.stringify(index), /Always measure the component/);
  const privateIndex = await loadRetrievalManifest(stateDir);
  assert.equal(privateIndex.entries.length, 2);
  assert.match(privateIndex.entries[0].contentHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(privateIndex), /Always measure the component/);
  const routed = await routePrompt(stateDir, 'Optimize this React component rendering performance', { provider: 'claude', top: 1, embeddings: false });
  assert.equal(routed.length, 1);
  assert.equal(routed[0].entry.name, 'react-performance');

  const hook = await handlePromptHook(stateDir, {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Optimize this React component rendering performance',
  }, { provider: 'claude', top: 1, embeddings: false });
  assert.match(hook.output.hookSpecificOutput.additionalContext, /react-performance/);
  assert.match(hook.output.hookSpecificOutput.additionalContext, /Always measure the component/);
  const measurement = vaultMeasurements(await loadState(stateDir), hook.result);
  assert.ok(measurement.estimatedActivationTokensBefore > 0);
  assert.equal(measurement.estimatedActivationTokensAfter, 0);
  assert.equal(measurement.selectedSkills, 1);

  const restored = await restoreVault(stateDir);
  assert.equal(restored.restored, 2);
  assert.equal(await readFile(path.join(root, 'react-performance', 'SKILL.md'), 'utf8'), original);
  await assert.rejects(access(path.join(stateDir, 'retrieval-index.json')));
});

test('installs and removes Claude and Codex hooks without replacing existing hooks', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-state-'));
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'skillram-integrations-'));
  await vaultSkills({ inputRoots: [root], provider: 'all', stateDir });
  await mkdir(path.join(fakeHome, '.claude'), { recursive: true });
  await writeFile(path.join(fakeHome, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] } }));

  const integrations = await installIntegrations(stateDir, { provider: 'all', home: fakeHome, router: 'skillrouter', retrievalK: 12 });
  assert.equal(integrations.length, 2);
  const claude = JSON.parse(await readFile(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  const codex = JSON.parse(await readFile(path.join(fakeHome, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(claude.hooks.SessionStart[0].hooks[0].command, 'existing-hook');
  assert.match(claude.hooks.UserPromptSubmit[0].hooks[0].command, /hook --provider claude/);
  assert.match(codex.hooks.UserPromptSubmit[0].hooks[0].command, /hook --provider codex/);
  assert.match(codex.hooks.PostCompact[0].hooks[0].command, /hook --provider codex/);
  assert.match(codex.hooks.SessionEnd[0].hooks[0].command, /hook --provider codex/);
  assert.match(codex.hooks.UserPromptSubmit[0].hooks[0].command, /--router 'skillrouter'/);
  assert.match(codex.hooks.UserPromptSubmit[0].hooks[0].command, /--retrieval-k '12'/);
  assert.equal(codex.hooks.UserPromptSubmit[0].hooks[0].timeout, 60);
  await installIntegrations(stateDir, { provider: 'codex', home: fakeHome, additionalContextLimit: 4096 });
  assert.equal((await loadState(stateDir)).integrations.length, 2);
  const upgradedCodex = JSON.parse(await readFile(path.join(fakeHome, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(upgradedCodex.hooks.UserPromptSubmit.length, 1);
  assert.equal(upgradedCodex.hooks.UserPromptSubmit[0].hooks[0].additionalContextLimit, 4096);
  assert.match(upgradedCodex.hooks.UserPromptSubmit[0].hooks[0].command, /--budget 4096/);
  const runtimeOutput = await runHookProcess(path.join(stateDir, 'runtime', 'bin', 'skillram.js'), stateDir, {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Review this React component',
  });
  assert.match(runtimeOutput, /additionalContext/);

  assert.equal(await removeIntegrations(stateDir), 2);
  const cleaned = JSON.parse(await readFile(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  assert.equal(cleaned.hooks.SessionStart[0].hooks[0].command, 'existing-hook');
  assert.equal(cleaned.hooks.UserPromptSubmit, undefined);
  assert.equal(cleaned.hooks.PostCompact, undefined);
  assert.equal(cleaned.hooks.SessionEnd, undefined);
  await restoreVault(stateDir);
});

test('does not inject a skill when the router has no evidence', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-state-'));
  await vaultSkills({ inputRoots: [root], provider: 'claude', stateDir });
  const hook = await handlePromptHook(stateDir, { hook_event_name: 'UserPromptSubmit', prompt: 'Book a flight to Berlin' }, { provider: 'claude', embeddings: false });
  assert.equal(hook, null);
  await restoreVault(stateDir);
});

test('uses local embeddings for semantic matches that lexical routing misses', async () => {
  const entries = [
    { id: 'image', provider: 'all', name: 'imagegen', description: 'Create raster illustrations and visual assets', activationTokens: 4 },
    { id: 'review', provider: 'all', name: 'code-review', description: 'Inspect source changes for defects', activationTokens: 4 },
  ];
  const requests = [];
  const routed = await routeWithEmbeddings({ entries }, 'draw a picture of a lighthouse', {
    top: 1,
    embeddingUrl: 'http://127.0.0.1:11434/api/embed',
    embeddingModel: 'nomic-embed-text',
    fetchImpl: async (url, options) => {
      const request = { url, body: JSON.parse(options.body) };
      requests.push(request);
      const embeddings = request.body.input_type === 'query' ? [[1, 0]] : [[0.96, 0.04], [0, 1]];
      return { ok: true, json: async () => ({ embeddings }) };
    },
  });
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/embed');
  assert.equal(requests[0].body.model, 'nomic-embed-text');
  assert.equal(requests[1].body.input_type, 'document');
  assert.equal(routed[0].entry.id, 'image');
  assert.equal(routed[0].method, 'embedding-full-body');
});

test('uses an opt-in LLM only after local routes are uncertain', async () => {
  const entries = [
    { id: 'image', provider: 'all', name: 'imagegen', description: 'Create raster illustrations', activationTokens: 4 },
    { id: 'review', provider: 'all', name: 'code-review', description: 'Inspect source changes', activationTokens: 4 },
  ];
  const urls = [];
  const routed = await routeHybrid({ entries }, 'make something visual', {
    top: 1,
    embeddingUrl: 'http://127.0.0.1:11434/api/embed',
    routerLlm: 'openai',
    openaiApiKey: 'test-key',
    fetchImpl: async (url, options) => {
      urls.push(url);
      if (url.includes('11434')) {
        const body = JSON.parse(options.body);
        return { ok: true, json: async () => ({ embeddings: body.input_type === 'query' ? [[1, 0]] : [[0.3, 0.95], [0.29, 0.96]] }) };
      }
      return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: '{"ids":["image"],"confidence":0.91}' }] }] }) };
    },
  });
  assert.deepEqual(urls, ['http://127.0.0.1:11434/api/embed', 'http://127.0.0.1:11434/api/embed', 'https://api.openai.com/v1/responses']);
  assert.equal(routed[0].entry.id, 'image');
  assert.equal(routed[0].method, 'llm:openai');
});

test('hybrid router loads nothing when every signal is weak', async () => {
  const entries = [{ id: 'review', provider: 'all', name: 'code-review', description: 'Inspect source changes', activationTokens: 4 }];
  const routed = await routeHybrid({ entries }, 'book a flight', {
    embeddingUrl: 'http://127.0.0.1:11434/api/embed',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ embeddings: body.input_type === 'query' ? [[1, 0]] : [[0, 1]] }) };
    },
  });
  assert.deepEqual(routed, []);
});

test('matches hyphenated skill names against natural-language prompt words', async () => {
  const entries = [{
    id: 'marker', provider: 'all', name: 'skillram-marker',
    description: 'Use when testing whether SkillRAM prompt-hook injection works.',
    activationTokens: 4,
  }];
  // Default routing sends this to semantic+rerank; with the model unavailable it degrades to
  // the low-confidence lexical fallback. The terminal shortcut is opt-in, so it stays off.
  const defaultRouted = await routeHybrid({ entries }, 'Test the SkillRAM marker hook', { embeddings: false });
  assert.equal(defaultRouted[0].entry.id, 'marker');
  assert.equal(defaultRouted[0].method, 'lexical');
  // Opted in, the prompt contains the full skill name as a phrase, so it takes the exact-name
  // shortcut rather than relying on accumulated word overlap.
  const opted = await routeHybrid({ entries }, 'Test the SkillRAM marker hook', { embeddings: false, exactNameShortcut: true });
  assert.equal(opted[0].method, 'exact-name');
});

test('the exact-name shortcut is off by default and never fires on generic overlap', async () => {
  const entries = [
    { id: 'a', provider: 'all', name: 'react-review', description: 'Review React components', activationTokens: 4 },
    { id: 'b', provider: 'all', name: 'react-performance', description: 'Optimize React rendering', activationTokens: 4 },
  ];
  const d1 = {};
  await routeHybrid({ entries }, 'review this react component', { embeddings: false, diagnostics: d1 });
  assert.equal(d1.lexical.shortcut, false, 'shortcut is off by default');
  // Even opted in, generic word overlap that never names a skill must not shortcut.
  const d2 = {};
  const routed = await routeHybrid({ entries }, 'review this react component', { embeddings: false, exactNameShortcut: true, diagnostics: d2 });
  assert.equal(d2.lexical.shortcut, false, 'no exact-name match, so no terminal shortcut even when enabled');
  assert.equal(routed[0]?.method, 'lexical', 'falls back to lexical when the model is unavailable');
  assert.ok(routed[0].confidence <= 0.6, 'fallback confidence is capped, not treated as certain');
});

test('injects once, restores after compaction, and clears at session end', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-session-'));
  await vaultSkills({ inputRoots: [root], provider: 'claude', stateDir });
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'session-1', prompt: 'Review this React component' };
  assert.ok(await handleAgentHook(stateDir, input, { provider: 'claude', embeddings: false }));
  assert.equal(await handleAgentHook(stateDir, input, { provider: 'claude', embeddings: false }), null);
  const compact = await handleAgentHook(stateDir, { hook_event_name: 'PostCompact', session_id: 'session-1' }, { provider: 'claude' });
  assert.match(compact.output.hookSpecificOutput.additionalContext, /react-review/);
  assert.equal(await handleAgentHook(stateDir, input, { provider: 'claude', embeddings: false }), null);
  await handleAgentHook(stateDir, { hook_event_name: 'SessionEnd', session_id: 'session-1' }, { provider: 'claude' });
  assert.ok(await handleAgentHook(stateDir, input, { provider: 'claude', embeddings: false }));
  const traces = await readTraces(stateDir);
  assert.ok(traces.some((event) => event.deduplicated?.length));
  assert.ok(traces.some((event) => event.event === 'compact' && event.restored?.length));
  assert.ok(traces.some((event) => event.event === 'session-end'));
  await restoreVault(stateDir);
});

test('doctor validates a complete installation', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-doctor-'));
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'skillram-doctor-home-'));
  await vaultSkills({ inputRoots: [root], provider: 'all', stateDir });
  await installIntegrations(stateDir, { provider: 'all', home: fakeHome });
  const report = await runDoctor(stateDir, { fetchImpl: async () => ({ ok: true }) });
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((check) => check.name === 'codex-prompt-hook' && check.status === 'pass'));
  await removeIntegrations(stateDir);
  await restoreVault(stateDir);
});

test('benchmarks labeled routes with precision and recall', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-benchmark-'));
  const cases = path.join(stateDir, 'routes.jsonl');
  await vaultSkills({ inputRoots: [root], provider: 'all', stateDir });
  await writeFile(cases, [
    JSON.stringify({ id: 'positive-review', prompt: 'Review this React component', expected: ['react-review'], forbidden: ['react-performance'], tags: ['positive', 'review'] }),
    JSON.stringify({ id: 'negative-travel', prompt: 'Book a flight', expected: [], tags: ['negative'] }),
  ].join('\n'));
  const report = await runBenchmark(stateDir, { file: cases, provider: 'all', top: 1, runs: 2, embeddings: false });
  assert.equal(report.accuracy, 1);
  assert.equal(report.precision, 1);
  assert.equal(report.recall, 1);
  assert.equal(report.stability, 1);
  assert.equal(report.datasetCases, 2);
  assert.equal(report.cases, 4);
  assert.equal(report.forbiddenActivations, 0);
  assert.equal(report.byTag.positive.accuracy, 1);
  assert.match(report.datasetSha256, /^[a-f0-9]{64}$/);
  await restoreVault(stateDir);
});

test('rejects benchmark cases with unknown skills or duplicate prompts', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-benchmark-invalid-'));
  const cases = path.join(stateDir, 'invalid.jsonl');
  await vaultSkills({ inputRoots: [root], provider: 'all', stateDir });
  await writeFile(cases, JSON.stringify({ prompt: 'Do something', expected: ['missing-skill'] }));
  await assert.rejects(() => runBenchmark(stateDir, { file: cases, embeddings: false }), /Unknown skill/);
  await writeFile(cases, [
    JSON.stringify({ prompt: 'Same prompt', expected: [] }),
    JSON.stringify({ prompt: 'same PROMPT', expected: [] }),
  ].join('\n'));
  await assert.rejects(() => runBenchmark(stateDir, { file: cases, embeddings: false }), /Duplicate benchmark prompt/);
  await restoreVault(stateDir);
});

test('chunks long skill bodies with overlap without losing text boundaries', () => {
  const input = `${'a'.repeat(700)}\n${'b'.repeat(700)}\n${'c'.repeat(700)}`;
  const chunks = chunkText(input, { chunkChars: 1000, chunkOverlap: 100 });
  assert.ok(chunks.length >= 3);
  assert.match(chunks[0], /^a+/);
  assert.match(chunks.at(-1), /c+$/);
});

test('invalidates cached vectors when full skill instructions change', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-cache-'));
  const entry = { id: 'image', provider: 'all', name: 'imagegen', description: 'Create visuals', activationTokens: 4, retrievalText: 'Draw raster illustrations.' };
  let documentRequests = 0;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.input_type === 'document') documentRequests += 1;
    return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) };
  };
  const embOpts = { stateDir, fetchImpl, semanticThreshold: 0, embeddingUrl: 'http://127.0.0.1:11434/api/embed' };
  await routeWithEmbeddings({ entries: [entry] }, 'make art', embOpts);
  await routeWithEmbeddings({ entries: [entry] }, 'make art', embOpts);
  entry.retrievalText = 'Generate a transparent product cutout.';
  await routeWithEmbeddings({ entries: [entry] }, 'make art', embOpts);
  assert.equal(documentRequests, 2);
  const manifest = await loadRetrievalManifest(stateDir);
  assert.equal(manifest.entries.length, 1);
});

test('reranks retrieved candidates against full bodies using the local service', async () => {
  const candidates = [
    { entry: { id: 'a', name: 'alpha', description: 'Generic', retrievalText: 'Handle database migrations safely.' }, score: 0.8 },
    { entry: { id: 'b', name: 'beta', description: 'Generic', retrievalText: 'Create and edit raster images.' }, score: 0.7 },
  ];
  let payload;
  const ranked = await rerankCandidates('remove an image background', candidates, {
    reranker: 'skillrouter',
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ranked: [{ id: 'b', score: 0.94 }, { id: 'a', score: 0.08 }] }) };
    },
  });
  assert.equal(ranked[0].entry.id, 'b');
  assert.equal(ranked[0].method, 'skillrouter-rerank');
  assert.match(payload.candidates[1].body, /raster images/);
});

test('requires explicit consent before cloud reranking full skill bodies', async () => {
  const candidates = [{ entry: { id: 'a', name: 'alpha', description: 'Generic', retrievalText: 'Private instructions.' }, score: 0.8 }];
  await assert.rejects(() => rerankCandidates('task', candidates, {
    reranker: 'openai', openaiApiKey: 'test-key', fetchImpl: async () => { throw new Error('must not call'); },
  }), /allow-cloud-bodies/);
});

test('fails reindexing quickly with an actionable error when the SkillRouter service is offline', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-service-offline-'));
  await vaultSkills({ inputRoots: [root], provider: 'all', stateDir });
  await assert.rejects(() => rebuildRetrievalIndex(stateDir, {
    router: 'skillrouter', fetchImpl: async () => { throw new Error('offline'); },
  }), /model service is not running/);
  await restoreVault(stateDir);
});

test('keeps confident lexical routing when the enhanced service is unreachable', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-service-fallback-'));
  await vaultSkills({ inputRoots: [root], provider: 'all', stateDir });
  const routed = await routePrompt(stateDir, 'Review this React component', {
    router: 'skillrouter', serviceSocket: path.join(stateDir, 'missing.sock'),
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(routed[0].entry.name, 'react-review');
  assert.equal(routed[0].method, 'lexical');
  await restoreVault(stateDir);
});

test('never exceeds the loader budget and suppresses duplicate instruction bodies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillram-loader-'));
  const first = path.join(root, 'first.md');
  const second = path.join(root, 'second.md');
  const large = path.join(root, 'large.md');
  await writeFile(first, 'same instructions');
  await writeFile(second, 'same instructions');
  await writeFile(large, 'word '.repeat(100));
  const routed = [first, second, large].map((vaultSkillFile, position) => ({ entry: { id: String(position), vaultSkillFile }, score: 1 }));
  const loaded = await loadRoutedEntries(routed, { tokenBudget: 20 });
  assert.equal(loaded.loaded.length, 1);
  assert.ok(loaded.tokens <= 20);
  assert.ok(loaded.skipped.some(({ reason }) => reason === 'duplicate-content'));
  assert.ok(loaded.skipped.some(({ reason }) => reason === 'token-budget'));
});

test('scores SkillRouter Eval Core prediction files with ranked metrics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillram-public-eval-'));
  await writeFile(path.join(root, 'relevance.json'), JSON.stringify({
    one: { task_type: 'single', core_gt_ids: ['good'], relevance: { good: 3, close: 1 } },
    two: { task_type: 'multi', core_gt_ids: ['x', 'y'], relevance: { x: 2, y: 2 } },
    skipped: { task_type: 'generic_only', core_gt_ids: ['generic'] },
  }));
  const predictions = path.join(root, 'predictions.json');
  await writeFile(predictions, JSON.stringify({ one: ['bad', 'good'], two: ['x', 'other', 'y'] }));
  const report = await scoreSkillRouterPredictions(root, predictions, { tier: 'easy', k: 3 });
  assert.equal(report.cases, 2);
  assert.equal(report.hit1, 0.5);
  assert.equal(report.recallAtK, 1);
  assert.ok(report.mrr > 0.5 && report.mrr < 1);
  assert.match(report.predictionsSha256, /^[a-f0-9]{64}$/);
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    sample: { seed: 'fixture', tasks: 2, skills: 3 },
    sampleStats: { selectedTasks: 2, selectedSkills: 3 },
  }));
  await writeFile(`${predictions}.metrics.json`, JSON.stringify({
    totalSeconds: 4,
    contextTokens: { catalogTokensPerPromptBefore: 100, meanLoadedInstructionTokensPerQuery: 25, estimatedReduction: 0.75, estimatedTokensAvoided: 150, queries: 2 },
  }));
  const merged = await scorePublicPredictions(root, predictions, { dataset: 'skillrouter', tier: 'easy', k: 3 });
  assert.equal(merged.sample.selectedSkills, 3);
  assert.equal(merged.tokenUsage.estimatedReduction, 0.75);
});

test('scores SKILLRET qrels with multi-skill retrieval metrics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillram-skillret-'));
  const qrels = path.join(root, 'data', 'qrels');
  await mkdir(qrels, { recursive: true });
  await writeFile(path.join(qrels, 'test.jsonl'), [
    JSON.stringify({ query_id: 'q1', skill_id: 'a', relevance: 1 }),
    JSON.stringify({ query_id: 'q1', skill_id: 'b', relevance: 1 }),
    JSON.stringify({ query_id: 'q2', skill_id: 'c', relevance: 1 }),
  ].join('\n'));
  const predictions = path.join(root, 'predictions.json');
  await writeFile(predictions, JSON.stringify({ q1: ['a', 'wrong', 'b'], q2: ['wrong', 'c'] }));
  const report = await scoreSkillRetPredictions(root, predictions, { split: 'test', k: 3 });
  assert.equal(report.benchmark, 'SKILLRET');
  assert.equal(report.cases, 2);
  assert.equal(report.recallAtK, 1);
  assert.equal(report.completenessAtK, 1);
  assert.ok(report.mapAtK > 0.5 && report.mapAtK < 1);
  await writeFile(`${predictions}.metrics.json`, JSON.stringify({ totalSeconds: 12, peakRssMb: 345 }));
  const withPerformance = await scorePublicPredictions(root, predictions, { dataset: 'skillret', split: 'test', k: 3 });
  assert.equal(withPerformance.performance.peakRssMb, 345);
});

test('persists public results and builds a non-aggregating unified report', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-eval-report-'));
  await saveEvaluationReport(stateDir, {
    benchmark: 'SKILLRET', split: 'test', cases: 10, k: 10,
    hit1: 0.7, recallAtK: 0.9, precisionAtK: 0.2, mrr: 0.8, ndcgAtK: 0.75,
    mapAtK: 0.72, completenessAtK: 0.6, predictionsSha256: 'abc',
  });
  const report = await buildEvaluationReport(stateDir);
  assert.equal(report.reports.length, 1);
  assert.equal(report.reports[0].benchmark, 'SKILLRET');
  assert.equal(report.reports[0].hit1, 0.7);
  assert.equal('average' in report, false);
});

test('reports public evaluation checkpoints without loading models', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-eval-status-'));
  const cache = path.join(stateDir, 'evaluations', 'cache', 'skillrouter', 'easy-fixture');
  const dataRoot = path.join(stateDir, 'dataset');
  await mkdir(cache, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(cache, 'pool-state.json'), JSON.stringify({ tier: 'easy', completed: 25, shards: [] }));
  await writeFile(path.join(cache, 'queries.json'), '{}');
  await writeFile(path.join(dataRoot, 'manifest.json'), JSON.stringify({ easy: { records: 100 } }));
  const report = await evaluationStatus(stateDir, { dataRoot });
  assert.equal(report.evaluations.length, 1);
  assert.equal(report.evaluations[0].completed, 25);
  assert.equal(report.evaluations[0].total, 100);
  assert.equal(report.evaluations[0].queryCache, true);
});

test('reuses shared SkillRouter models for disposable vault states', async () => {
  const requested = await mkdtemp(path.join(os.tmpdir(), 'skillram-requested-models-'));
  const shared = await mkdtemp(path.join(os.tmpdir(), 'skillram-shared-models-'));
  const root = path.join(shared, 'models', 'skillrouter');
  const scripts = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts') : path.join(root, '.venv', 'bin');
  const python = path.join(scripts, process.platform === 'win32' ? 'python.exe' : 'python');
  await mkdir(scripts, { recursive: true });
  await mkdir(path.join(root, 'models', 'embedding'), { recursive: true });
  await mkdir(path.join(root, 'models', 'reranker'), { recursive: true });
  await writeFile(python, 'fixture');
  await writeFile(path.join(root, 'models', 'embedding', 'config.json'), '{}');
  await writeFile(path.join(root, 'models', 'reranker', 'config.json'), '{}');
  const status = await modelStatus(requested, {
    sharedStateDir: shared,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(status.installed, true);
  assert.equal(status.sharedFallback, true);
  assert.equal(status.root, root);
});

test('treats an existing healthy SkillRAM model service as a successful serve', async () => {
  const result = await serveSkillRouter('/tmp/skillram-no-models-needed', {
    serviceSocket: null,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, service: 'skillram-skillrouter', protocol: 2, device: 'test', embeddingLoaded: true, rerankerLoaded: true }),
    }),
  });
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.health.device, 'test');
});

test('exchanges private model requests through hook-safe file IPC', async () => {
  const ipcRoot = await mkdtemp(path.join(os.tmpdir(), 'skillram-ipc-'));
  const responder = (async () => {
    const requests = path.join(ipcRoot, 'requests');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const files = await readdir(requests).catch(() => []);
      const requestName = files.find((name) => name.endsWith('.json') && !name.endsWith('.tmp'));
      if (requestName) {
        const request = JSON.parse(await readFile(path.join(requests, requestName), 'utf8'));
        const responses = path.join(ipcRoot, 'responses');
        const temporary = path.join(responses, `.${request.id}.tmp`);
        await writeFile(temporary, JSON.stringify({ id: request.id, status: 200, body: { ok: true, protocol: 2 } }));
        await rename(temporary, path.join(responses, `${request.id}.json`));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('test IPC request was not observed');
  })();
  const response = await requestFileJson(ipcRoot, '/health', { timeout: 2000 });
  await responder;
  assert.deepEqual(response, { ok: true, protocol: 2 });
});

test('records session access metadata and migrates version 1 sessions', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-memory-'));
  await vaultSkills({ inputRoots: [root], provider: 'claude', stateDir });
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'memory-1', prompt: 'Review this React component' };
  await handlePromptHook(stateDir, input, { provider: 'claude', embeddings: false });
  await handlePromptHook(stateDir, input, { provider: 'claude', embeddings: false });
  const session = await loadSession(stateDir, 'claude', 'memory-1');
  const [id] = session.loaded;
  assert.equal(session.version, 2);
  assert.equal(session.promptCount, 2);
  assert.ok(session.entries[id].hits >= 2, 'a re-selected skill counts as a hit even when deduplicated');
  assert.ok(session.entries[id].lastPrompt >= 2);

  const legacy = { loaded: ['claude-react-review'], updatedAt: new Date().toISOString() };
  const file = path.join(stateDir, 'sessions', `${createHash('sha256').update('claude\0legacy-1').digest('hex')}.json`);
  await writeFile(file, JSON.stringify(legacy));
  const migrated = await loadSession(stateDir, 'claude', 'legacy-1');
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.loaded, ['claude-react-review']);
  assert.equal(migrated.entries['claude-react-review'].hits, 1);
  await restoreVault(stateDir);
});

test('restores the working set first and evicts by policy under a tight budget', async () => {
  const session = {
    promptCount: 30,
    entries: {
      stale: { lastPrompt: 2, hits: 9, lastInjectedPrompt: 2 },
      recent: { lastPrompt: 29, hits: 1, lastInjectedPrompt: 29 },
      frequent: { lastPrompt: 28, hits: 12, lastInjectedPrompt: 28 },
    },
    arc: { t1: ['recent'], t2: ['frequent'], b1: [], b2: [], p: 0 },
  };
  const ordered = restoreOrder(session, ['stale', 'recent', 'frequent'], { policy: 'arc', promptIndex: 30 });
  assert.deepEqual(ordered.slice(0, 2).sort(), ['frequent', 'recent'], 'working set restores before evictable skills');
  assert.equal(ordered[2], 'stale', 'a skill untouched for 28 prompts falls outside the working set');
  assert.deepEqual(policyOrder(session, ['stale', 'recent', 'frequent'], { policy: 'lru' }), ['recent', 'frequent', 'stale']);
  assert.deepEqual(policyOrder(session, ['stale', 'recent', 'frequent'], { policy: 'lfu' }), ['frequent', 'stale', 'recent']);
  assert.deepEqual(staleSkills(session, ['stale', 'recent'], { promptIndex: 30, refreshAfter: 20 }), ['stale']);
});

test('adapts the ARC target between recency and frequency on ghost hits', async () => {
  let arc = emptyArc();
  for (const id of ['a', 'b', 'c']) arc = referenceArc(arc, id, 2);
  assert.ok(arc.b1.length >= 1, 'exceeding capacity evicts into the recency ghost list');
  const evicted = arc.b1[arc.b1.length - 1];
  const before = arc.p;
  arc = referenceArc(arc, evicted, 2);
  assert.ok(arc.p > before, 'a ghost hit in B1 raises the recency target');
  assert.ok(arc.t2.includes(evicted), 'a re-referenced skill is promoted to the frequent list');
});

test('predicts co-occurring skills from the prompt trace', async () => {
  const traces = [
    { event: 'prompt', selected: ['pdf', 'tables'] },
    { event: 'prompt', selected: ['pdf', 'tables'] },
    { event: 'prompt', selected: ['pdf', 'tables'] },
    { event: 'prompt', selected: ['unrelated'] },
  ];
  const table = buildCooccurrence(traces);
  const predicted = predictNext(table, ['pdf'], { limit: 3 });
  assert.equal(predicted[0].id, 'tables');
  assert.equal(predicted[0].confidence, 1);
  assert.deepEqual(predictNext(table, ['unrelated'], { limit: 3 }), [], 'a skill with no co-occurrence predicts nothing');
  assert.deepEqual(predictNext(buildCooccurrence(traces.slice(0, 1)), ['pdf'], { minSupport: 2 }), [], 'a single coincidence is not a prediction');
});

test('summarizes unloaded near misses and reuses memoized selections', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-tiers-'));
  await vaultSkills({ inputRoots: [root], provider: 'claude', stateDir });
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'tier-1', prompt: 'Review React component performance' };
  const first = await handlePromptHook(stateDir, input, { provider: 'claude', embeddings: false, top: 1, summaryTop: 2 });
  assert.ok(first.summaries.length >= 1, 'a ranked but unloaded skill is offered as a summary');
  assert.match(first.output.hookSpecificOutput.additionalContext, /skillram-available/);
  const summarized = first.summaries[0].id;
  assert.ok(!first.result.loaded.some(({ entry }) => entry.id === summarized), 'summarized skills are not loaded');

  const session = await loadSession(stateDir, 'claude', 'tier-1');
  assert.ok(session.summaries[summarized] >= 1, 'the summary tier is tracked apart from the resident set');
  assert.ok(!session.loaded.includes(summarized), 'a summarized skill never counts as loaded');
  assert.ok(Object.keys(session.memo).length >= 1, 'the selection is memoized for an identical repeat');
  await restoreVault(stateDir);
});

test('narrows a large skill to prompt-relevant sections and keeps it whole when small', async () => {
  const body = ['---', 'name: big', 'description: A large skill', '---', '# big', 'Preamble line.',
    ...Array.from({ length: 6 }, (_, index) => `## Section ${index}\n${'filler '.repeat(140)}topic${index}`)].join('\n');
  const trimmed = selectSections(body, 'help me with topic3', { maxTokens: 400 });
  assert.match(trimmed, /name: big/, 'frontmatter always survives the trim');
  assert.match(trimmed, /Preamble line/, 'the preamble always survives the trim');
  assert.match(trimmed, /Section 3/, 'the matching section is kept');
  assert.match(trimmed, /sections; \d+ omitted/, 'the omission is disclosed to the agent');
  assert.ok(estimateTokens(trimmed) < estimateTokens(body), 'trimming reduces tokens');
  const small = '---\nname: s\ndescription: d\n---\n# s\nOne short body.\n';
  assert.equal(selectSections(small, 'anything', { maxTokens: 400 }), small, 'a skill with no sections is never trimmed');
});

test('composes overlay notes at load time without modifying the vaulted skill', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-overlay-'));
  await vaultSkills({ inputRoots: [root], provider: 'claude', stateDir });
  const index = await loadIndex(stateDir);
  const entry = index.entries[0];
  const before = await readFile(entry.vaultSkillFile, 'utf8');

  await addOverlayNote(stateDir, entry.id, 'This repo uses pnpm, not npm.', { sessionId: 'overlay-1' });
  await addOverlayNote(stateDir, entry.id, 'This repo uses pnpm, not npm.', { sessionId: 'overlay-1' });
  const overlay = await loadOverlay(stateDir, entry.id);
  assert.equal(overlay.notes.length, 1, 'the same note recorded twice is stored once');

  const loaded = await loadSelection(stateDir, [entry.id]);
  assert.match(loaded.loaded[0].contents, /skillram-overlay/);
  assert.match(loaded.loaded[0].contents, /pnpm/);
  assert.equal(await readFile(entry.vaultSkillFile, 'utf8'), before, 'the vaulted SKILL.md is byte-identical');

  const listed = await listOverlays(stateDir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, entry.id, 'overlay ids round-trip through the filename encoding');

  await clearOverlay(stateDir, entry.id);
  assert.deepEqual((await loadOverlay(stateDir, entry.id)).notes, []);
  const plain = await loadSelection(stateDir, [entry.id]);
  assert.ok(!plain.loaded[0].contents.includes('skillram-overlay'));
  await restoreVault(stateDir);
  assert.equal(await readFile(path.join(root, entry.name, 'SKILL.md'), 'utf8'), before, 'restore returns the original body');
});

test('bounds overlay size and keeps the most recent notes', async () => {
  const overlay = { id: 'x', notes: Array.from({ length: 5 }, (_, index) => ({ text: `note ${index} ${'word '.repeat(60)}` })) };
  const applied = applyOverlay('# body', overlay, { maxTokens: 120 });
  assert.match(applied, /^# body/);
  assert.match(applied, /note 4/, 'the newest note is always kept');
  assert.ok(!applied.includes('note 0'), 'the oldest notes are dropped when over budget');
  assert.equal(applyOverlay('# body', { id: 'x', notes: [] }), '# body', 'an empty overlay changes nothing');
});

test('a skill evicted at compaction can be injected again', async () => {
  const root = await fixture();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-evict-'));
  await vaultSkills({ inputRoots: [root], provider: 'claude', stateDir });
  const prompts = ['Review this React component', 'Optimize React rendering performance'];
  for (const prompt of prompts) {
    await handlePromptHook(stateDir, { hook_event_name: 'UserPromptSubmit', session_id: 'evict-1', prompt }, { provider: 'claude', embeddings: false, top: 1, summaryTop: 0 });
  }
  const before = await loadSession(stateDir, 'claude', 'evict-1');
  assert.equal(before.loaded.length, 2, 'both skills are resident before compaction');

  // A budget that fits one skill forces the other out of context.
  await handleAgentHook(stateDir, { hook_event_name: 'PostCompact', session_id: 'evict-1' }, { provider: 'claude', tokenBudget: 40 });
  const after = await loadSession(stateDir, 'claude', 'evict-1');
  assert.ok(after.loaded.length < before.loaded.length, 'an over-budget skill is evicted from the resident set');

  const evicted = before.loaded.find((id) => !after.loaded.includes(id));
  const prompt = prompts[before.loaded.indexOf(evicted)];
  const again = await handlePromptHook(stateDir, { hook_event_name: 'UserPromptSubmit', session_id: 'evict-1', prompt }, { provider: 'claude', embeddings: false, top: 1, summaryTop: 0 });
  assert.ok(again, 'an evicted skill is injectable again rather than suppressed by deduplication');
  assert.ok(again.result.loaded.some(({ entry }) => entry.id === evicted));
  await restoreVault(stateDir);
});

test('refreshing a stale skill restarts its decay clock', async () => {
  const session = {
    promptCount: 30,
    entries: { old: { lastPrompt: 30, lastInjectedPrompt: 5, hits: 4 } },
    arc: emptyArc(),
  };
  assert.deepEqual(staleSkills(session, ['old'], { promptIndex: 30, refreshAfter: 20 }), ['old']);
  recordRefresh(session, ['old'], 30);
  assert.deepEqual(staleSkills(session, ['old'], { promptIndex: 31, refreshAfter: 20 }), [], 'a refreshed skill is not stale again on the next prompt');
});

test('a migrated version 1 session carries every version 2 field', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-migrate-'));
  await mkdir(path.join(stateDir, 'sessions'), { recursive: true });
  const file = path.join(stateDir, 'sessions', `${createHash('sha256').update('claude\0v1').digest('hex')}.json`);
  await writeFile(file, JSON.stringify({ loaded: ['a', 'b'] }));
  const session = await loadSession(stateDir, 'claude', 'v1');
  assert.deepEqual(session.summaries, {}, 'the summary tier exists after migration');
  assert.deepEqual(session.arc, emptyArc(), 'ARC state exists after migration');
  assert.equal(session.entries.a.lastInjectedPrompt, 1, 'legacy skills get an injection timestamp');
});

test('the session benchmark separates a real replacement policy from index order', async () => {
  const suite = await loadSessionSuite(new URL('../benchmarks/session.smoke.json', import.meta.url).pathname);
  const [arc, index] = await Promise.all([
    runSessionBenchmark(suite, { evictionPolicy: 'arc' }),
    runSessionBenchmark(suite, { evictionPolicy: 'index' }),
  ]);
  assert.equal(arc.turns, index.turns);
  assert.equal(arc.forbiddenActivations, 0, 'unrelated prompts activate nothing');
  assert.equal(arc.postCompactRetention, 1, 'a real policy keeps the working set across compaction');
  assert.ok(index.postCompactRetention < arc.postCompactRetention, 'index order loses the working set');
  await assert.rejects(() => runSessionBenchmark({ skills: [], sessions: [] }), /non-empty skills/);
  await assert.rejects(
    () => runSessionBenchmark({ skills: [{ name: 'a', description: 'd' }], sessions: [{ id: 's', turns: [{ prompt: 'p', expectResident: ['nope'] }] }] }),
    /unknown skill nope/,
  );
});

test('reads a bounded tail of the trace regardless of how long the install has run', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'skillram-trace-scale-'));
  const line = (index) => JSON.stringify({ at: '2026-08-16T00:00:00Z', event: 'prompt', promptIndex: index, selected: ['a'] });
  await writeFile(path.join(stateDir, 'trace.jsonl'), `${Array.from({ length: 20000 }, (_, i) => line(i)).join('\n')}\n`);
  const traces = await readTraces(stateDir, 200);
  assert.equal(traces.length, 200, 'the newest entries are returned');
  assert.equal(traces.at(-1).promptIndex, 19999, 'the tail is the newest end of the file');
  assert.equal(traces[0].promptIndex, 19800);
  // A window smaller than one line must still make progress rather than spin or truncate.
  const tiny = await readTraces(stateDir, 5, { tailBytes: 8 });
  assert.equal(tiny.length, 5);
  assert.equal(tiny.at(-1).promptIndex, 19999);
  const short = await readTraces(stateDir, 50000);
  assert.equal(short.length, 20000, 'asking for more than exists returns everything');
});

test('the scaled SKILLRET session suite loads and separates policies by retention', async () => {
  const file = new URL('../benchmarks/session.skillret.json', import.meta.url).pathname;
  let suite;
  try { suite = await loadSessionSuite(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.ok(suite.skills.length >= 500, 'the scaled suite carries a realistic pool');
  assert.ok(suite.source?.neutralizedBodies, 'bodies are neutralized so offensive-security skills do not trip on-access antivirus');
  const [arc, index] = await Promise.all([
    runSessionBenchmark(suite, { evictionPolicy: 'arc' }),
    runSessionBenchmark(suite, { evictionPolicy: 'index' }),
  ]);
  assert.ok(arc.postCompactRetention > index.postCompactRetention, 'a frequency-aware policy retains the returning skill better than index order');
  assert.equal(typeof arc.abstentionRate, 'number', 'the negative archetype produces an abstention rate');
});

test('memory replay isolates policy from retrieval using frozen predictions', async () => {
  // Frozen rankings: task A retrieves gold skill s-a, and so on. Retrieval never varies.
  const predictions = {
    A: ['s-a', 's-x', 's-y'], B: ['s-b', 's-x'], C: ['s-c', 's-y'],
    D: ['s-d', 's-z'], E: ['s-e'], F: ['s-f'], G: ['s-g'], H: ['s-h'],
  };
  const gold = { A: ['s-a'], B: ['s-b'], C: ['s-c'], D: ['s-d'], E: ['s-e'], F: ['s-f'], G: ['s-g'], H: ['s-h'] };
  const policies = ['arc', 'lru', 'lfu', 'index'].map((policy) => runMemoryReplay(predictions, gold, { policy, compactBudget: 700 }));
  // The core invariant: with retrieval frozen, every policy sees the identical gold-retrieved
  // rate, so any downstream difference is attributable to memory alone. This is the whole
  // point of replaying stored predictions instead of re-routing.
  const retrieved = new Set(policies.map(({ goldRetrieved }) => goldRetrieved));
  assert.equal(retrieved.size, 1, 'retrieval quality is held constant across every policy');
  assert.ok(policies[0].goldRetrieved > 0, 'the frozen predictions actually surface gold skills');
  for (const report of policies) {
    assert.ok(report.postCompactRetention === null || (report.postCompactRetention >= 0 && report.postCompactRetention <= 1), 'retention is a valid rate');
  }
  assert.ok(planSessions(Object.keys(predictions)).some((session) => session.archetype === 'return'), 'the plan builds a returning archetype');
});

test('the exact-name shortcut is pool-size gated and disabled at scale', async () => {
  const small = { entries: [
    { id: 'pe', provider: 'all', name: 'pdf-extraction', description: 'Extract text from PDFs' },
    { id: 'rr', provider: 'all', name: 'react-review', description: 'Review React components' },
  ] };
  const d1 = {};
  const routed = await routeHybrid(small, 'run pdf-extraction on this document', { embeddings: false, exactNameShortcut: true, diagnostics: d1 });
  assert.equal(d1.lexical.shortcut, true, 'a distinctive named skill in a small library takes the shortcut when opted in');
  assert.equal(routed[0].method, 'exact-name');

  // The same name in a large pool must not shortcut even when opted in: precision collapses
  // at scale, so it defers to semantic + rerank instead.
  const big = { entries: Array.from({ length: 400 }, (_, i) => ({ id: `s${i}`, provider: 'all', name: `skill-${i}`, description: 'd' })) };
  big.entries.push({ id: 'pe', provider: 'all', name: 'pdf-extraction', description: 'Extract text' });
  const d2 = {};
  await routeHybrid(big, 'run pdf-extraction here', { embeddings: false, exactNameShortcut: true, diagnostics: d2 });
  assert.equal(d2.lexical.shortcut, false, 'above the pool-size guard the terminal shortcut is disabled');
});

test('falls back to lexical with capped confidence when the embedding backend is unreachable', async () => {
  const entries = [{ id: 'pe', provider: 'all', name: 'pdf-extraction', description: 'Extract text from PDFs' }];
  // Embeddings enabled (default) but the endpoint refuses: must degrade, not throw or abstain.
  const diagnostics = {};
  const routed = await routeHybrid({ entries }, 'run pdf-extraction on this file', {
    embeddingUrl: 'http://127.0.0.1:9/none', embeddingTimeout: 300, diagnostics,
  });
  assert.equal(routed[0]?.entry.id, 'pe', 'the lexical fallback still routes');
  assert.equal(routed[0].method, 'lexical');
  assert.ok(routed[0].confidence <= 0.6, 'fallback confidence is capped');
  assert.equal(diagnostics.selectedMethod, 'lexical-fallback');
  assert.ok(diagnostics.embedding.error, 'the embedding failure is recorded in diagnostics');
});

test('selects the in-process embedding backend without loading it for other backends', async () => {
  const { usesLocalEmbedder, localEmbedderModel } = await import('../src/local-embedder.js');
  assert.equal(usesLocalEmbedder({ embeddingBackend: 'minilm' }), true);
  assert.equal(usesLocalEmbedder({ embeddingBackend: 'local' }), true);
  assert.equal(usesLocalEmbedder({ embeddingBackend: null }), false);
  assert.equal(usesLocalEmbedder({}), false);
  assert.match(localEmbedderModel(), /MiniLM/i);
  assert.equal(localEmbedderModel({ embeddingModel: 'Xenova/bge-small-en' }), 'Xenova/bge-small-en');
});
