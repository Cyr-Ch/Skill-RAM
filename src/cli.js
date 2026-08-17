import { parseArgs } from './args.js';
import path from 'node:path';
import { analyze, scanSkills } from './scan.js';
import { receiptData, receiptText } from './format.js';
import { generateRoast } from './roast.js';
import { writeReceiptSvg } from './svg.js';
import { resolveStateDir, loadState, loadIndex } from './state.js';
import { restoreVault, vaultSkills } from './vault.js';
import { installIntegrations, removeIntegrations } from './integrations.js';
import { currentMeasurements, handleAgentHook, loadSelection, rebuildRetrievalIndex, routePrompt } from './runtime.js';
import { formatLoadedContext, loadRoutedEntries } from './router.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { readTraces } from './session.js';
import { addOverlayNote, clearOverlay, listOverlays, loadOverlay } from './overlay.js';
import { formatBenchmark, runBenchmark, writeBenchmarkSvg } from './benchmark.js';
import { createRequire } from 'node:module';
import { createSkillRouterEvalSample, installSkillRouterModels, modelStatus, runSkillRouterEval, serveSkillRouter } from './models.js';
import { detectPublicDataset, formatPublicBenchmark, scorePublicPredictions } from './public-benchmark.js';
import { buildEvaluationReport, formatEvaluationReport, saveEvaluationReport, writeEvaluationReport } from './evaluation-report.js';
import { evaluationStatus, formatEvaluationStatus } from './evaluation-status.js';
import { formatSessionBenchmark, loadSessionSuite, runSessionBenchmark } from './session-benchmark.js';
import { formatMemoryReplay, loadPredictionsAndGold, runMemoryReplay } from './memory-replay.js';

const packageVersion = createRequire(import.meta.url)('../package.json').version;

const help = `SkillRAM — vault and load skills on demand

Usage:
  skillram receipt [paths...] [--provider claude|codex|all] [--share [receipt.svg]] [--json]
  skillram roast [paths...] [--provider claude|codex|all] [--llm anthropic|openai] [--tone brutal|professional|hacker]
  skillram install [paths...] [--provider claude|codex|all] [--dry-run]
  skillram vault [paths...] [--provider claude|codex|all] [--dry-run]
  skillram integrate [--provider claude|codex|all]
  skillram reindex [--no-embeddings]
  skillram route <prompt> [--provider claude|codex|all] [--top 2] [--router hybrid|lexical|semantic|skillrouter]
  skillram load <skill-id-or-name...> [--budget 8000]
  skillram measure [representative prompt]
  skillram doctor
  skillram why <prompt>
  skillram trace [prompt]
  skillram benchmark [routes.jsonl] [--runs 3] [--share [benchmark.svg]]
  skillram eval <routes.jsonl> [--runs 3]
  skillram eval-session [suite.json] [--eviction-policy arc|lru|lfu|index] [--compare]
  skillram eval-memory <predictions.json> <relevance.json> [--compare]
  skillram models install skillrouter
  skillram models status
  skillram serve [--host 127.0.0.1] [--port 8765]
  skillram eval-public <data-root> [predictions.json] [--dataset skillrouter|skillret] [--quick]
  skillram eval-status [data-root]
  skillram eval-report [report.json...]
  skillram overlay add <skill> <note>
  skillram overlay list [skill]
  skillram overlay clear <skill>
  skillram status
  skillram uninstall

Examples:
  npx skillram receipt
  npx skillram receipt ~/.claude/skills --share
  OPENAI_API_KEY=... npx skillram roast --llm openai --tone hacker
  npx skillram install --dry-run
  npx skillram install
  npx skillram route "review this React component"

Receipt analysis runs locally. Roast sends aggregate metrics—not skill contents—to the selected LLM.`;

export async function run(argv) {
  const { command, options } = parseArgs(argv);
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(help);
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log(packageVersion);
    return;
  }
  const commands = new Set(['receipt', 'roast', 'install', 'vault', 'integrate', 'reindex', 'route', 'load', 'hook', 'measure', 'doctor', 'why', 'trace', 'benchmark', 'eval', 'models', 'serve', 'eval-public', 'eval-status', 'eval-report', 'eval-session', 'eval-memory', 'overlay', 'status', 'uninstall']);
  if (!commands.has(command)) throw new Error(`Unknown command: ${command}\n\n${help}`);

  const provider = options.provider ?? 'all';
  if (!['claude', 'codex', 'all'].includes(provider)) throw new Error('Provider must be claude, codex, or all.');
  if (options.top !== undefined && (!Number.isInteger(options.top) || options.top < 1 || options.top > 20)) throw new Error('--top must be an integer from 1 to 20.');
  if (options.budget !== undefined && (!Number.isInteger(options.budget) || options.budget < 1)) throw new Error('--budget must be a positive integer.');
  if (options.runs !== undefined && (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 50)) throw new Error('--runs must be an integer from 1 to 50.');
  if (options.router && !['hybrid', 'lexical', 'semantic', 'skillrouter'].includes(options.router)) throw new Error('--router must be hybrid, lexical, semantic, or skillrouter.');
  if (options.routerLlm && !['anthropic', 'openai'].includes(options.routerLlm)) throw new Error('--router-llm must be anthropic or openai.');
  if (options.reranker && !['none', 'similarity', 'skillrouter', 'openai', 'anthropic'].includes(options.reranker)) throw new Error('--reranker must be none, similarity, skillrouter, openai, or anthropic.');
  if (options.tier && !['easy', 'hard'].includes(options.tier)) throw new Error('--tier must be easy or hard.');
  if (options.dataset && !['auto', 'skillrouter', 'skillret'].includes(options.dataset)) throw new Error('--dataset must be auto, skillrouter, or skillret.');
  if (options.split && !['train', 'test'].includes(options.split)) throw new Error('--split must be train or test.');
  for (const key of ['lexicalScore', 'lexicalMargin', 'semanticThreshold', 'semanticMargin', 'minConfidence', 'embeddingTimeout', 'minScore', 'nameWeight', 'descriptionWeight', 'exactNameWeight', 'retrievalK', 'rerankerTimeout', 'rerankThreshold', 'chunkChars', 'chunkOverlap', 'embeddingBatchSize', 'checkpointEvery', 'loadK', 'sampleTasks', 'sampleSkills', 'port', 'hookTimeout']) {
    if (options[key] !== undefined && !Number.isFinite(options[key])) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be numeric.`);
  }
  for (const key of ['lexicalScore', 'lexicalMargin', 'semanticMargin', 'embeddingTimeout', 'minScore', 'nameWeight', 'descriptionWeight', 'exactNameWeight', 'rerankerTimeout', 'chunkChars', 'chunkOverlap']) {
    if (options[key] !== undefined && options[key] < 0) throw new Error(`Router numeric options cannot be negative.`);
  }
  for (const key of ['semanticThreshold', 'minConfidence', 'rerankThreshold']) {
    if (options[key] !== undefined && (options[key] < 0 || options[key] > 1)) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be between 0 and 1.`);
  }
  if (options.retrievalK !== undefined && (!Number.isInteger(options.retrievalK) || options.retrievalK < 1 || options.retrievalK > 1000)) throw new Error('--retrieval-k must be an integer from 1 to 1000.');
  if (options.embeddingBatchSize !== undefined && (!Number.isInteger(options.embeddingBatchSize) || options.embeddingBatchSize < 1 || options.embeddingBatchSize > 512)) throw new Error('--embedding-batch-size must be an integer from 1 to 512.');
  if (options.checkpointEvery !== undefined && (!Number.isInteger(options.checkpointEvery) || options.checkpointEvery < 1 || options.checkpointEvery > 10000)) throw new Error('--checkpoint-every must be an integer from 1 to 10000.');
  if (options.loadK !== undefined && (!Number.isInteger(options.loadK) || options.loadK < 1 || options.loadK > 20)) throw new Error('--load-k must be an integer from 1 to 20.');
  if (options.sampleTasks !== undefined && (!Number.isInteger(options.sampleTasks) || options.sampleTasks < 1 || options.sampleTasks > 10000)) throw new Error('--sample-tasks must be a positive integer.');
  if (options.sampleSkills !== undefined && (!Number.isInteger(options.sampleSkills) || options.sampleSkills < 1)) throw new Error('--sample-skills must be a positive integer.');
  if (options.chunkChars !== undefined && (!Number.isInteger(options.chunkChars) || options.chunkChars < 500)) throw new Error('--chunk-chars must be an integer of at least 500.');
  if (options.chunkOverlap !== undefined && (!Number.isInteger(options.chunkOverlap) || options.chunkOverlap < 0 || options.chunkOverlap >= (options.chunkChars ?? 4000))) throw new Error('--chunk-overlap must be a non-negative integer smaller than --chunk-chars.');
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error('--port must be an integer from 1 to 65535.');
  if (options.hookTimeout !== undefined && (!Number.isInteger(options.hookTimeout) || options.hookTimeout < 1 || options.hookTimeout > 600)) throw new Error('--hook-timeout must be an integer from 1 to 600 seconds.');
  if (options.embeddingTimeout !== undefined && options.embeddingTimeout < 1) throw new Error('--embedding-timeout must be positive.');
  if (options.rerankerTimeout !== undefined && options.rerankerTimeout < 1) throw new Error('--reranker-timeout must be positive.');
  const stateDir = resolveStateDir(options.stateDir);

  if (command === 'models') {
    const action = options.paths[0] ?? 'status';
    const model = options.paths[1] ?? 'skillrouter';
    if (model !== 'skillrouter') throw new Error('Only the skillrouter model bundle is currently supported.');
    if (action === 'install') {
      const status = await installSkillRouterModels(stateDir, { python: options.python });
      console.log(`SkillRouter models installed at ${status.root}`);
    } else if (action === 'status') {
      console.log(JSON.stringify(await modelStatus(stateDir), null, 2));
    } else throw new Error('models action must be install or status.');
    return;
  }

  if (command === 'serve') {
    const result = await serveSkillRouter(stateDir, { host: options.host ?? '127.0.0.1', port: options.port ?? 8765 });
    if (result?.alreadyRunning) console.log(`SkillRAM model service is already running on ${result.health.device ?? 'the local device'}.`);
    return;
  }

  if (command === 'eval-public') {
    const sourceDataRoot = options.paths[0];
    if (!sourceDataRoot) throw new Error('eval-public requires a public benchmark data directory.');
    const dataset = await detectPublicDataset(sourceDataRoot, options.dataset ?? 'auto');
    const tier = options.tier ?? 'easy';
    const split = options.split ?? 'test';
    const sampleRequested = options.quick || options.sampleTasks !== undefined || options.sampleSkills !== undefined;
    if (sampleRequested && dataset !== 'skillrouter') throw new Error('Bounded sampling currently supports SkillRouter Eval Core only.');
    const sampleTasks = options.sampleTasks ?? (options.quick ? 15 : 30);
    const sampleSkills = options.sampleSkills ?? (options.quick ? 500 : 1000);
    const dataRoot = sampleRequested ? await createSkillRouterEvalSample(stateDir, sourceDataRoot, {
      tier, sampleTasks, sampleSkills,
      sampleSeed: options.sampleSeed ?? 'skillram-dev-v1', output: options.sampleOutput,
    }) : sourceDataRoot;
    if (sampleRequested) console.log(`Using bounded development sample: ${dataRoot}`);
    const generatedPredictions = !options.paths[1];
    const predictions = options.paths[1] ?? await runSkillRouterEval(stateDir, dataRoot, {
      dataset, tier, split, retrievalK: options.retrievalK ?? (options.quick ? 10 : 20), embeddingBatchSize: options.embeddingBatchSize,
      checkpointEvery: options.checkpointEvery ?? 512, loadK: options.loadK ?? 2,
      cacheDir: options.evalCacheDir,
      output: options.output ?? (sampleRequested ? path.join(stateDir, 'evaluations', `${path.basename(dataRoot)}-predictions.json`) : undefined),
    });
    const report = await scorePublicPredictions(dataRoot, predictions, { dataset, tier, split, k: 10 });
    report.generatedAt = new Date().toISOString();
    if (generatedPredictions) report.modelManifest = (await modelStatus(stateDir)).manifest;
    report.reportFile = await saveEvaluationReport(stateDir, report);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatPublicBenchmark(report));
    return;
  }

  if (command === 'eval-session') {
    const file = options.paths[0] ?? new URL('../benchmarks/session.smoke.json', import.meta.url).pathname;
    const suite = await loadSessionSuite(file);
    const shared = {
      tokenBudget: options.tokenBudget, top: options.top, summaryTop: options.summaryTop,
      router: options.router ?? 'lexical', embeddings: false,
    };
    const clean = Object.fromEntries(Object.entries(shared).filter(([, value]) => value !== undefined));
    const policies = options.compare ? ['arc', 'lru', 'lfu', 'index'] : [options.evictionPolicy ?? 'arc'];
    const reports = [];
    for (const evictionPolicy of policies) {
      reports.push(await runSessionBenchmark(suite, { ...clean, evictionPolicy }));
    }
    if (options.json) console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
    else console.log(reports.map(formatSessionBenchmark).join('\n\n'));
    return;
  }

  if (command === 'eval-memory') {
    const [predictionsFile, relevanceFile] = options.paths;
    if (!predictionsFile || !relevanceFile) throw new Error('eval-memory requires a predictions.json and a relevance.json.');
    const { predictions, gold } = await loadPredictionsAndGold(predictionsFile, relevanceFile);
    const policies = options.compare ? ['arc', 'lru', 'lfu', 'index'] : [options.evictionPolicy ?? 'arc'];
    const reports = policies.map((policy) => runMemoryReplay(predictions, gold, {
      policy, top: options.top ?? 2, tokenBudget: options.tokenBudget, compactBudget: options.compactBudget,
    }));
    if (options.json) console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
    else console.log(reports.map(formatMemoryReplay).join('\n\n'));
    return;
  }

  if (command === 'overlay') {
    const [action, skill, ...rest] = options.paths;
    if (action === 'list' || action === undefined) {
      const overlays = skill ? [await loadOverlay(stateDir, skill)] : await listOverlays(stateDir);
      const present = overlays.filter(({ notes }) => notes.length);
      if (options.json) console.log(JSON.stringify(present, null, 2));
      else if (!present.length) console.log('No skill overlays recorded.');
      else {
        for (const overlay of present) {
          console.log(overlay.id);
          for (const note of overlay.notes) console.log(`  - ${note.text}`);
        }
      }
      return;
    }
    if (!skill) throw new Error('overlay add and overlay clear require a skill id.');
    if (action === 'add') {
      const note = rest.join(' ').trim();
      if (!note) throw new Error('overlay add requires note text.');
      const index = await loadIndex(stateDir);
      if (!index.entries.some((entry) => entry.id === skill || entry.name === skill)) {
        throw new Error(`No vaulted skill matches “${skill}”. Run “skillram status” to list vaulted skills.`);
      }
      const entry = index.entries.find((value) => value.id === skill || value.name === skill);
      const overlay = await addOverlayNote(stateDir, entry.id, note);
      console.log(`Recorded ${overlay.notes.length} overlay note(s) for ${entry.id}. The vaulted SKILL.md is unchanged.`);
      return;
    }
    if (action === 'clear') {
      await clearOverlay(stateDir, skill);
      console.log(`Cleared overlay notes for ${skill}.`);
      return;
    }
    throw new Error('overlay action must be add, list, or clear.');
  }

  if (command === 'eval-status') {
    const report = await evaluationStatus(stateDir, { dataRoot: options.paths[0] });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatEvaluationStatus(report));
    return;
  }

  if (command === 'eval-report') {
    const report = await buildEvaluationReport(stateDir, options.paths);
    if (options.output) await writeEvaluationReport(options.output, report);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatEvaluationReport(report));
    return;
  }

  if (command === 'install' || command === 'vault') {
    const result = await vaultSkills({ inputRoots: options.paths, provider, stateDir, dryRun: options.dryRun });
    console.log(`${options.dryRun ? 'Would vault' : result.applied ? 'Vaulted' : 'Found'} ${result.entries.length} eligible skills.`);
    if (options.dryRun) for (const entry of result.entries) console.log(`  + [${entry.provider}] ${entry.name}`);
    if (result.skipped.length) {
      console.log(`Skipped ${result.skipped.length} managed or unsupported skills:`);
      for (const entry of result.skipped) console.log(`  - ${entry.name}: ${entry.reason}`);
    }
    if (result.applied && command === 'install' && options.integrations !== false) {
      try {
        const integrations = await installIntegrations(stateDir, { provider, additionalContextLimit: options.budget ?? 8000, ...options });
        console.log(`Installed ${integrations.length} prompt-hook integrations.`);
      } catch (error) {
        await restoreVault(stateDir);
        throw error;
      }
    }
    if (result.applied) console.log(`State: ${stateDir}`);
    return;
  }

  if (command === 'integrate') {
    const integrations = await installIntegrations(stateDir, { provider, additionalContextLimit: options.budget ?? 8000, ...options });
    console.log(`Installed ${integrations.length} prompt-hook integrations.`);
    return;
  }

  if (command === 'reindex') {
    const result = await rebuildRetrievalIndex(stateDir, { provider, ...options });
    console.log(`Indexed ${result.entries} skills across ${result.chunks} private full-body chunks${result.embeddings ? ' and cached embeddings' : ''}.`);
    return;
  }

  if (command === 'uninstall') {
    const restored = await restoreVault(stateDir);
    const integrations = await removeIntegrations(stateDir);
    console.log(`Restored ${restored.restored} skills and removed ${integrations} integrations.`);
    if (restored.cacheCleanupFailed) console.log(`Warning: ${restored.cacheCleanupFailed} private retrieval cache files could not be removed.`);
    return;
  }

  if (command === 'route') {
    const prompt = options.paths.join(' ').trim();
    if (!prompt) throw new Error('route requires a prompt.');
    const routed = await routePrompt(stateDir, prompt, { provider, top: options.top ?? 2, ...options });
    if (options.json) console.log(JSON.stringify(routed.map(({ entry, score, matches, method, confidence }) => ({ id: entry.id, provider: entry.provider, name: entry.name, score, matches, method, confidence })), null, 2));
    else if (!routed.length) console.log('No relevant skills matched.');
    else for (const result of routed) console.log(`${result.entry.id}\t${result.score}\t${result.method ?? 'lexical'}\t${result.matches.join(',')}`);
    return;
  }

  if (command === 'doctor') {
    const report = await runDoctor(stateDir);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
    return;
  }

  if (command === 'why' || command === 'trace') {
    const prompt = options.paths.join(' ').trim();
    if (!prompt) {
      if (command === 'why') throw new Error('why requires a prompt.');
      const history = await readTraces(stateDir);
      console.log(options.json ? JSON.stringify(history, null, 2) : history.length ? history.map((event) => `${event.at}\t${event.provider}\t${event.event}\tselected=${(event.selected ?? []).join(',') || '-'}\tinjected=${(event.injected ?? []).join(',') || '-'}`).join('\n') : 'No routing traces recorded.');
      return;
    }
    const diagnostics = {};
    const routed = await routePrompt(stateDir, prompt, { provider, top: options.top ?? 2, diagnostics, ...options });
    const result = { selected: routed.map(({ entry, score, method, confidence }) => ({ id: entry.id, name: entry.name, score, method, confidence })), diagnostics };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'benchmark' || command === 'eval') {
    const file = options.paths[0];
    if (command === 'eval' && !file) throw new Error('eval requires a routes.jsonl file.');
    const report = await runBenchmark(stateDir, { file, provider, top: options.top ?? 2, ...options });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatBenchmark(report));
    if (options.share) {
      await writeBenchmarkSvg(report, options.share);
      console.log(`Share card saved to ${options.share}`);
    }
    return;
  }

  if (command === 'load') {
    if (!options.paths.length) throw new Error('load requires at least one skill id or name.');
    const result = await loadSelection(stateDir, options.paths, { tokenBudget: options.budget ?? 8000 });
    console.log(formatLoadedContext(result.loaded));
    return;
  }

  if (command === 'hook') {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw || '{}');
    const result = await handleAgentHook(stateDir, input, { provider, top: options.top ?? 2, tokenBudget: options.budget ?? 8000, ...options });
    if (result) process.stdout.write(`${JSON.stringify(result.output)}\n`);
    return;
  }

  if (command === 'measure') {
    const prompt = options.paths.join(' ').trim();
    let result = null;
    if (prompt) {
      const routed = await routePrompt(stateDir, prompt, { provider, top: options.top ?? 2, ...options });
      result = await loadRoutedEntries(routed, { tokenBudget: options.budget ?? 8000 });
    }
    console.log(JSON.stringify(await currentMeasurements(stateDir, result), null, 2));
    return;
  }

  if (command === 'status') {
    const state = await loadState(stateDir);
    console.log(JSON.stringify({ stateDir, status: state.status ?? 'not-installed', skills: state.entries.length, integrations: state.integrations.length, installedAt: state.installedAt }, null, 2));
    return;
  }

  const report = analyze(await scanSkills(options.paths, { provider }));
  if (command === 'receipt') {
    console.log(options.json ? JSON.stringify(receiptData(report), null, 2) : receiptText(report));
    if (!report.roots.length) console.log('\nNo active skill directories found. Pass one or more paths to scan.');
    if (options.share) {
      await writeReceiptSvg(report, options.share);
      console.log(`\nShare card saved to ${options.share}`);
    }
  } else {
    console.log(await generateRoast(report, { tone: options.tone, model: options.model, llm: options.llm }));
  }
}
