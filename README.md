# SkillRAM — install every skill, load only the ones the task needs.

**Your agent is drowning in skills it will never use on this prompt.** Every skill you install burns context on every turn — a catalog the model re-reads before it does anything. Install 100 skills and you are paying a tax on all of them, forever, to use two.

SkillRAM ends the tax. It vaults every skill, routes each prompt with a local model, and injects **only** the instructions the task actually needs. Then it does what nothing else does: it treats loaded skills like **RAM** — a working set with a real replacement policy, a summary tier, refresh, and prefetch — so the right skills stay resident across a long session and the rest get out of the way.

```sh
npx skillram install
```

## The numbers

Measured on the public [SkillRouter Eval Core](https://github.com/zhengyanzhao1997/SkillRouter) benchmark — a 2,000-skill retrieval pool, 75 real tasks, running fully local on a laptop.

### 🔥 97.6% of your skill-context tokens, gone

| | Before SkillRAM | After SkillRAM |
| --- | --- | --- |
| Skill context per prompt | ~156,343 tokens | **~3,795 tokens** |
| Across 75 prompts | the whole catalog, every turn | **~11.4M tokens avoided** |

That is not a typo. On a 2,000-skill pool the model was staring at **156K tokens of skills it did not need** before writing a single line. SkillRAM cuts that to under 4K — a **97.6% reduction** — while still putting the right skill in front of it.

### 🎯 It still finds the right skill

| Benchmark (75 tasks / 2,000 skills) | Hit@1 | Recall@10 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- |
| Eval Core **easy** | **84.0%** | 83.5% | 0.885 | 0.762 |
| Eval Core **hard** (adversarial near-misses) | **66.7%** | 75.7% | 0.743 | 0.635 |

Two 0.6B models, no API calls, no data leaving your machine. The hard tier deliberately packs the pool with skills engineered to look right and be wrong — and SkillRAM still lands the exact top skill two times in three.

### 🧠 The part nobody else has: memory that remembers what matters

Loading the right skill once is easy. Keeping it resident across a 60-turn session — while the conversation drifts, compacts, and comes back — is where naive tooling falls apart. SkillRAM runs an actual cache-replacement policy over your session. When context compacts and something has to go, here is how much of the still-relevant working set survives:

| Eviction strategy | Working set retained after compaction |
| --- | --- |
| Index order (what everyone else effectively does) | **35.7%** |
| LRU (recency only) | 47–57% |
| **ARC / LFU (SkillRAM default)** | **62–76%** |

Index-order eviction throws away **two-thirds** of the skills your task still needs. SkillRAM keeps up to **76%** — because it knows which skills you keep coming back to and protects them. Measured by replaying the frozen retrieval output through the memory layer, so this number is memory quality alone, retrieval held constant.

> These are development-scale benchmark numbers on public data, run locally and reproducibly — not a marketing chart. Every command below regenerates them. See [Building a credible dataset](#building-a-credible-dataset) for what a production claim would require.

## Why you will not want to go back

- **Install 500 skills like it costs nothing** — because now it nearly does. The catalog tax is gone.
- **Your best skills stop getting evicted** at the worst moment. The memory hierarchy protects the working set.
- **Nothing leaves your laptop.** Local models, local routing, local everything. No keys, no cloud, no telemetry.
- **Fully reversible.** One `uninstall` puts every skill back byte-for-byte. Try it and bail if you hate it — you won't.
- **Works with Claude Code and Codex today.** One hook, both agents.

```text
╭────── YOUR CLAUDE + CODEX SKILL RECEIPT ──────╮
│ Claude skills                137 · ~18.4k tokens│
│ Codex skills                    24 · ~2.4k tokens│
│                                                │
│ Installed skills                           137 │
│ Installed plugins                            8 │
│ Estimated activation catalog    ~18.4k tokens │
│ Removable repeated body text    ~4.81k tokens │
│ Largest activation entry          react-expert│
│ Estimate method                     lexical-v1│
╰────────────────────────────────────────────────╯
```

## Runtime quickstart

```sh
# Preview every move. Managed/system/plugin-cache skills are skipped.
npx skillram install --dry-run

# Vault eligible skills and install Claude + Codex prompt hooks.
npx skillram install

# Inspect routing without loading instructions.
npx skillram route "review this React component" --top 2

# Load a named skill manually.
npx skillram load react-performance

# Compare the vaulted catalog with one representative task.
npx skillram measure "review this React component"

# Verify the vault, runtime, hooks, and local embedding endpoint.
npx skillram doctor

# Explain one decision or inspect privacy-safe hook history.
npx skillram why "review this React component"
npx skillram trace

# Run a synthetic smoke benchmark or a labeled routing suite.
npx skillram benchmark --share skillram-benchmark.svg
npx skillram eval routes.jsonl

# Restore every original directory and remove both hooks.
npx skillram uninstall
```

Claude Code reads the new hook from `~/.claude/settings.json`. Codex reads `~/.codex/hooks.json`; open `/hooks` once to review and trust the generated command hook. Restart an existing agent session after installation.

When upgrading an active 0.x vault, refresh the private manifest and copied hook runtime without moving the skills again:

```sh
npx skillram@latest reindex --no-embeddings
npx skillram@latest integrate --provider all
```

## How the RAM works

1. **Vault:** each eligible skill directory is moved intact to `~/.skillram/vault`, including scripts, references, and assets. A journal is written before the first move.
2. **Compact index:** `~/.skillram/index.json` keeps only the name, a description capped at 320 characters, provider, token estimates, and the vault location. The index is never put into model context.
3. **Private retrieval index:** SkillRAM hashes and chunks the complete vaulted `SKILL.md` bodies. `retrieval-index.json` stores only content hashes and chunk counts; `embeddings.json` stores vectors. Neither file is sent to Claude or Codex.
4. **Router:** full-body semantic retrieval with lexical candidates fused in by rank (RRF); the reranker is the terminal judge, and lexical never decides alone. A strict exact-name shortcut is available opt-in for small, distinctively named libraries. Confidence thresholds return no selection when evidence is weak. See [Why lexical never decides alone](#why-lexical-never-decides-alone).
5. **Enhanced reranker:** an optional local SkillRouter service retrieves approximately 20 full-body candidates with its released 0.6B encoder and reranks them with its released 0.6B cross-encoder. The service accepts only local loopback or private filesystem IPC requests.
6. **Loader:** selected instructions are read from the vault under a hard 8,000-token default budget. Exact duplicate bodies are suppressed, and an oversized skill is skipped rather than exceeding the budget.
7. **Session memory:** a per-session resident set, keyed by a one-way session hash, records when each skill was last referenced, last injected, and how often it was selected. An instruction body is injected only once while it stays resident. `PostCompact` restores the resident set under a replacement policy, and `SessionEnd` removes the session record. See [Memory hierarchy](#memory-hierarchy).
8. **Integration:** real `UserPromptSubmit` hooks inject selected instructions as `additionalContext`. When nothing matches—or a selected skill is already present in the session—the hook prints nothing and adds zero context.
9. **Restoration:** uninstall checks every source and destination before moving anything back. It refuses to overwrite a new directory, preserves unrelated hook configuration, and deletes body-derived retrieval caches after restoration.

SkillRAM does not move Codex system skills or mutate versioned plugin caches. Those are reported as skipped because provider updates could otherwise overwrite the vault operation.

## Memory hierarchy

The session layer is a cache, so it borrows the parts of a memory system that a cache needs: a replacement policy, more than one residency tier, a notion of a working set, and a way to write back what the session learned. Every default below is conservative, and each mechanism can be switched off independently.

### Residency tiers

A skill occupies one of three tiers on any given prompt.

| Tier | What enters context | Cost |
| --- | --- | --- |
| **L1 — resident** | the full `SKILL.md` body, wrapped in `<skillram-skill>` | hundreds to thousands of tokens |
| **L2 — summary** | name, description, and section headings, as `<skillram-available>` | roughly 20–60 tokens |
| **L3 — vaulted** | nothing | zero |

Before this, a skill was either fully resident or completely invisible, which made a retrieval miss unrecoverable: the agent could not ask for a capability it had no way to know existed. The router now ranks `top + summaryTop` skills and offers the surplus at L2, so a near miss becomes a prompt the agent can act on. It also gives low confidence a third option — demote to L2 — instead of forcing a choice between a wrong load and silence.

The summary tier is tracked separately from the resident set in the session file. A skill the agent has only seen a summary of must never be mistaken for one whose instructions are in context, so `loaded` derives from the resident set alone. Repeat summaries are suppressed for `--summary-repeat-after` prompts, because the same summary re-sent every turn is noise rather than information.

### Replacement policy

The resident set used to grow without bound, and the only eviction was accidental: `PostCompact` restored skills in index order until the token budget ran out, so whether a skill survived compaction depended on its position in `index.json`. Restoration is now explicit and ordered.

**Working set first.** Following Denning, skills referenced within the last `--working-set-window` prompts are restored before anything else. They are what the current task is using, so they should not compete on recency alone with skills the session has moved past.

**Then ARC.** Adaptive Replacement Cache balances recency against frequency and retunes that balance from its own misses, which matches how sessions actually behave — "used once forty turns ago" and "keep coming back to it" deserve different treatment. `--eviction-policy` also accepts `lru`, `lfu`, and `index` (the previous behavior) for comparison.

ARC assumes uniform page sizes, and skills differ in cost by an order of magnitude. Rather than distort ARC to handle variable-size entries, the two concerns are separated: **the policy decides priority, and the token budget decides admission.** The policy produces an ordering; the loader fills the budget in that order.

A skill dropped at compaction is removed from the resident set, because it is genuinely no longer in the model's context. Leaving it there caused deduplication to suppress it for the rest of the session — the skill was silently lost. ARC's ghost lists are what remember that it was evicted.

### Refresh

DRAM refreshes cells before their charge decays. A skill injected forty turns ago is still nominally resident, but the model's attention over it has faded. When a skill is still being selected and was last injected more than `--refresh-after` prompts ago, SkillRAM restates its shape compactly as `<skillram-refresh>` rather than re-sending the whole body. A refresh restarts the decay clock.

### Prefetch

Every prompt already appended its selected skills to `trace.jsonl`; nothing read it back. That file is an access trace, so co-occurrence across prompts predicts which skill tends to follow which — confidence is `P(right | left)`, guarded by a minimum support so a single coincidence does not become a prediction.

**Predictions warm L2 only, never L1.** A wrong full-body prefetch costs thousands of tokens; a wrong summary costs a few dozen. That asymmetry is what makes speculation cheap enough to be allowed to be wrong. Predicted skills also rank behind skills the router actually matched, so prefetching fills leftover summary budget and never displaces a real match.

### Prompt memo

An exact repeat of a prompt within a session reuses the previous selection instead of re-embedding and re-reranking it, in the spirit of a TLB short-circuiting address translation. Keyed by a hash of the normalized prompt, bounded to the most recent entries, and session-scoped.

### Section granularity

A memory system fetches the cache line containing an address, not the whole page. Bodies are already chunked for retrieval but loaded whole, so `--section-granularity` narrows a large skill to the sections a prompt matches, always keeping frontmatter and preamble and stamping how many sections were omitted.

**This is off by default and gated behind a size threshold.** Many skills are only correct as a complete procedure, and dropping a step is a worse failure than spending the tokens. Turn it on deliberately.

### Overlays (write-back)

A session often learns something durable about a skill — "this repo uses pnpm, not npm". Overlays persist those notes and compose them at load time under a labelled `<skillram-overlay>` block.

**Overlays never modify the vaulted `SKILL.md`.** Vaulting promises to return every skill byte-identical on uninstall, and rewriting a user's skill body to persist an inference the agent drew would break that promise in a way that is hard to notice and harder to undo. Notes live in `<state-dir>/overlays/`, are size-bounded with the newest kept, and are always visually separated from the author's own instructions. Because they are user-authored content rather than derived cache, restoring the vault leaves them in place.

```sh
npx skillram overlay add react-review "This repo uses pnpm, not npm."
npx skillram overlay list
npx skillram overlay clear react-review
```

### Measuring the hierarchy

SkillRouter Eval Core and SKILLRET are single-shot: one query, one ranked list, no session, no budget pressure, no eviction. They score identically with every mechanism above switched on or off, so they cannot evaluate any of it. `skillram eval-session` replays ordered prompt sequences against a real vault and asks which skills are actually resident at each turn.

```sh
npx skillram eval-session
npx skillram eval-session --compare
npx skillram eval-session my-sessions.json --eviction-policy lru --json
```

A suite defines its own synthetic skills inline, so it runs with no vaulted skills and no models. Each turn may declare `expectResident`, `expectSummary`, and `forbidden`; a session may declare `compactAfter`, `compactBudget`, and `compactExpect` to force eviction under pressure. Reported metrics are resident-set F1 and coverage, reuse rate (how often deduplication avoided a re-injection), summary recovery, post-compaction retention, forbidden activations, and injected tokens per turn.

`benchmarks/session.smoke.json` is a 4-session, 14-turn development smoke test. It is deliberately small, and it is not a production accuracy claim — it cannot rank eviction policies, and `--compare` shows `arc`, `lru`, and `lfu` scoring identically on it. What it does separate is a real replacement policy from none: `index`, the previous restore order, retains **0%** of the expected working set across compaction where every real policy retains **100%**.

Treat the defaults as reasoned starting points rather than tuned results. Ranking policies against each other needs a substantially larger suite built along the lines described in [Building a credible dataset](#building-a-credible-dataset).

## Receipt, roast, share

```sh
# Scan Claude and Codex by default, with an explicit breakdown.
npx skillram receipt
npx skillram receipt --provider claude
npx skillram receipt --provider codex
npx skillram receipt --provider all

# Scan an explicit directory and create a post-ready SVG
npx skillram receipt ./skills --share skill-tax.svg

# LLM-written from aggregate metrics; choose Anthropic or OpenAI
npx skillram roast --llm anthropic --tone brutal
npx skillram roast --llm openai --tone hacker

# Feed reproducible measurements into another tool
npx skillram receipt --json
```

SkillRAM reads standalone `SKILL.md` and `instructions.md` files, enabled installed plugins, plugin manifests, and legacy command Markdown. Claude plugin enablement follows user, project, and local `enabledPlugins` settings. Only the most recent cached version is measured. Marketplace skills are explicitly marked **not active** and never added to the activation estimate merely because their catalog was downloaded.

Receipt analysis is completely local. `roast` sends aggregate counts to the selected provider but never sends skill contents, descriptions, names, or paths. Hybrid routing remains local unless the user explicitly enables its cloud LLM fallback; that fallback sends the current prompt plus compact skill names and descriptions.

## Full-body hybrid routing

The router retrieves full-body embedding candidates — embedding chunks of the complete skill body, not only the name and description — using the **in-process MiniLM embedder by default** (no server, no configuration). It then **fuses in the lexical candidates by Reciprocal Rank Fusion** and lets the reranker make the final call. Skill vectors are cached in the private SkillRAM state directory; prompts are embedded transiently and are not cached. If no embedding backend is available, SkillRAM degrades to a low-confidence lexical fallback rather than failing closed.

### Why lexical never decides alone

An earlier design used lexical scoring as a terminal shortcut: if the top lexical score cleared a threshold, it returned that skill and skipped embeddings entirely. Raw lexical (BM25-style) scores are unbounded and driven by term statistics, so — exactly as the information-retrieval literature predicts — score *magnitude does not track correctness*, and the shortcut confidently short-circuited the reranker on prompts it got wrong.

We ran a same-dataset, end-to-end A/B to measure the fix: 500 skills and 150 queries from the public [SKILLRET](https://github.com/ThakiCloud/SKILLRET) set, identical 0.6B embeddings and identical reranker in every arm — **only the routing logic differs.**

| Router (SKILLRET, 500 skills, 150 queries, identical embeddings + reranker) | Hit@1 |
| --- | --- |
| **Old** — raw-score lexical shortcut, terminal | 64.7% |
| **New** — RRF fusion, reranker is terminal *(default)* | **91.3%** |
| New **+ forced** exact-name shortcut at this scale | 73.3% |

The old lexical shortcut fired on **88% of prompts at 61% precision**, capping its accuracy — it decided most queries itself and was wrong on two in five. Routing those same prompts through RRF fusion and letting the reranker decide lifts Hit@1 by **+26.6 points**. The third row is the cautionary one: forcing the exact-name shortcut on at 500 skills *lowers* accuracy to 73.3%, which is why it is off by default and auto-disables above the pool-size guard. (These numbers use `name | description` content and the lightweight similarity reranker, so absolute Hit@1 differs from the full-body Eval Core figures above; the comparison is apples-to-apples because every arm shares the same retrieval and reranking.)

The current router fuses lexical and embedding candidates by rank (RRF, the standard fix for incomparable score scales) and makes the **reranker the terminal judge** — the stage that reads each candidate in full. Lexical keeps the two jobs it is genuinely good at: contributing exact-term recall into the rerank pool, and serving as the offline fallback when no model is available.

#### Opt-in exact-name shortcut

If your library is small and your skills have distinctive names, you can re-enable a *strict* terminal shortcut that fires only when a prompt contains one skill's full name as a word-bounded phrase, unambiguously:

```sh
export SKILLRAM_EXACT_NAME_SHORTCUT=1      # off by default
export SKILLRAM_EXACT_NAME_MAX_POOL=300    # auto-disables above this many skills
```

It prints a one-time warning when enabled and **auto-disables above the pool-size guard**, because the same measurement showed even the strictest exact-name gate collapses to 7–13% precision on a large, generically named pool. On a small personal library where names are intentional, it is safe and fast; at scale, leave it off and let the reranker decide.

### Embedding backends

Embeddings are **on by default and work out of the box** — the default backend is an in-process model that needs no server. If for some reason no backend is available, the router degrades to lexical matching (much lower accuracy) and prints a one-time warning. Three backends, measured on the same 500-skill / 150-query SKILLRET slice through the identical RRF + rerank pipeline:

| Backend | Params | Setup | Hit@1 | Recall@10 |
| --- | --- | --- | --- | --- |
| **`all-MiniLM-L6-v2` (in-process) — default** | 22M | none (installed automatically) | **77.3%** | 88.7% |
| SkillRouter encoder (`--router skillrouter`) | 596M | Python venv + ~3 GB weights | **91.3%** | 98.7% |
| Lexical fallback (no model) | — | — | ~33–65% | — |

The **default in-process MiniLM backend** runs inside Node via onnxruntime — no Ollama, no Python, and no GPU (CPU is fine; an accelerator only makes it faster). It downloads a ~90 MB model once and caches it, and it is the zero-infrastructure way to get real semantic routing. It just works after `npx skillram install`.

`@huggingface/transformers` is an **optional dependency**: it installs automatically so the default backend works, but if it fails to build on an unusual platform the install still succeeds and routing uses the lexical fallback until you fix it. Nothing to configure for the common case.

**Want the highest accuracy?** Use the 0.6B SkillRouter encoder — 91.3% Hit@1, at the cost of a Python environment and ~3 GB of weights:

```sh
npx skillram models install skillrouter
npx skillram serve &                     # local model service
npx skillram reindex --router skillrouter
npx skillram route "review this React component" --router skillrouter
```

**Already run Ollama, or have your own embedding server?** Point SkillRAM at any Ollama-compatible endpoint instead of the in-process model:

```sh
export SKILLRAM_EMBEDDING_URL=http://127.0.0.1:11434/api/embed
export SKILLRAM_EMBEDDING_MODEL=nomic-embed-text
npx skillram reindex
```

Switching backends changes the vector identity, so `reindex` re-embeds the pool rather than mixing incompatible vectors. `reindex --no-embeddings` rebuilds hashes and chunk metadata without embedding. `SKILLRAM_EMBEDDINGS=off` uses lexical routing only.

### Routing modes

| Mode | Behavior | External requirement |
|---|---|---|
| `lexical` | Names and descriptions only | None |
| `hybrid` | Full-body embeddings with RRF-fused lexical candidates, reranker decides; lexical fallback if no backend | In-process MiniLM (default) |
| `semantic` | Always use full-body embeddings and lightweight reranking | In-process MiniLM (default) |
| `skillrouter` | Full-body SkillRouter encoder and cross-encoder reranker | Local model service |

### Enhanced local SkillRouter mode

The enhanced mode is optional because it installs Python inference dependencies and two model checkpoints. It never requires an OpenAI or Anthropic API key.

```sh
# Create a private Python environment under ~/.skillram and download the models.
npx skillram models install skillrouter

# Keep the localhost inference service running in one terminal.
npx skillram serve

# Confirm the endpoint, then persist this router in both prompt hooks.
npx skillram models status
npx skillram reindex --router skillrouter
npx skillram integrate --provider all --router skillrouter --retrieval-k 20

# Test the same route directly.
npx skillram why "remove the background from this product photo" --router skillrouter
```

The service binds to `127.0.0.1:8765`, a private user-specific Unix socket, and a mode-`700` filesystem IPC directory inside the selected SkillRAM state. It exposes `/embed`, `/rerank`, and `/health`; sandboxed hooks prefer filesystem IPC because Codex can prohibit both localhost and Unix-socket connections. IPC request and response files are mode `600`, atomically exchanged, and deleted after each request. Request logging never includes prompts or skill bodies. Model inference is local, but the initial installation downloads Python packages and model weights. SkillRouter’s repository code is MIT; its model weights, benchmark data, and upstream skill data can have separate terms that users must review.

`serve` eagerly loads both checkpoints before accepting requests, so wait for the “listening” message before running `reindex`. Restart `serve` after upgrading SkillRAM so the service and hook runtime use the same IPC protocol. Model weights installed in `~/.skillram` are automatically reused by disposable vault states such as `--state-dir /tmp/skillram-e2e-state`; they are not downloaded twice. Enhanced integrations default to a 60-second hook timeout; override it with `--hook-timeout` if local inference requires different limits.

Cloud LLM routing is disabled by default. Enable it only if sending the user prompt plus compact skill names and descriptions to the selected provider is acceptable:

```sh
export SKILLRAM_ROUTER_LLM=openai       # or anthropic
npx skillram route "an ambiguous task"
```

Full-body cloud reranking is a separate, more sensitive opt-in. SkillRAM refuses to send instruction bodies unless consent is explicit:

```sh
npx skillram route "an ambiguous task" \
  --reranker openai --allow-cloud-bodies
```

Anthropic is also supported with `--reranker anthropic`. Without `--allow-cloud-bodies` or `SKILLRAM_ALLOW_CLOUD_BODIES=1`, these modes fail closed.

Use `--router lexical` for deterministic lexical-only behavior. `--strict-router` exposes embedding or LLM errors during manual testing; hooks normally fail closed so a routing service outage does not interrupt Claude Code or Codex.

Router constants are defaults, not test fixtures. Every decision threshold can be overridden for evaluation:

```sh
npx skillram why "an ambiguous task" \
  --lexical-score 6 --lexical-margin 2 \
  --semantic-threshold 0.42 --semantic-margin 0.04 \
  --min-confidence 0.72 --embedding-timeout 2500
```

Lexical tuning also supports `--min-score`, `--name-weight`, `--description-weight`, and `--exact-name-weight`. The hook instruction budget is configurable at installation with `--budget`; SkillRAM writes the same value into the runtime command and Codex `additionalContextLimit`. Provider config paths, hook event names, API URLs, and default model names follow their respective platform contracts. The CLI version is read directly from `package.json`.

## Diagnose and explain

```sh
npx skillram doctor
npx skillram why "draw a product mockup"
npx skillram trace
```

`doctor` checks vault consistency, the copied runtime, Claude and Codex prompt/compaction/session-cleanup hooks, the compact index, and the optional local embedding endpoint. Codex hook trust remains an explicit manual check through `/hooks`.

Hook traces are stored locally in `~/.skillram/trace.jsonl`. They contain timestamps, provider, routing scores, selected IDs, injected IDs, deduplicated IDs, and token estimates. User prompt text and session IDs are not logged.

## Reproduce the headline numbers

Nothing above is a slide. Every figure comes from a command you can run:

```sh
# 97.6% token reduction + Hit@1 / Recall@10 / nDCG@10, local, on the public pool.
npx skillram eval-public /path/to/SkillRouter/data/eval_core \
  --tier hard --sample-tasks 75 --sample-skills 2000

# The memory hierarchy, retrieval held constant: replay a stored prediction file
# through the resident-set + eviction layer and compare every policy head to head.
npx skillram eval-memory predictions.json relevance.json --compare

# The full multi-turn session behaviour end to end (resident set, eviction,
# summary recovery, refresh, abstention) across every replacement policy.
npx skillram eval-session --compare
```

`eval-memory` is the honest one: it feeds the *same frozen retrieval* to every policy, so the only variable is memory. That is how we can say index-order eviction keeps 35.7% of the working set and ARC/LFU keep 62–76% — same inputs, different memory, measured.

## Benchmark routing

Run the built-in synthetic smoke suite:

```sh
npx skillram benchmark
npx skillram benchmark --share skillram-benchmark.svg
```

For meaningful accuracy numbers, create a labeled JSONL suite. Skill names or stable SkillRAM IDs are accepted:

```json
{"id":"react-review-01","prompt":"Can you look for correctness problems in this component?","expected":["react-review"],"forbidden":["react-performance"],"tags":["positive","paraphrase","react"]}
{"id":"react-performance-01","prompt":"This component rerenders hundreds of times","expected":["react-performance"],"tags":["positive","semantic","react"]}
{"id":"negative-near-miss-01","prompt":"Explain what React is","expected":[],"forbidden":["react-review","react-performance"],"tags":["negative","near-miss","react"]}
```

```sh
# Deterministic lexical baseline
npx skillram eval routes.jsonl --router lexical --top 2 --json

# Full hybrid router; repeat to measure stability if an LLM fallback is enabled
npx skillram eval routes.jsonl --top 2 --runs 3 --json
```

The evaluator rejects malformed JSON, duplicate IDs or prompts, unknown skills, contradictory expected/forbidden labels, and cases requiring more skills than `--top`. It reports exact-match accuracy, precision, recall, Hit@1, Hit@K, MRR, no-skill accuracy, forbidden/false/missed activations, per-tag metrics, routing-method counts, stability, median/p95 latency, memory, estimated activation tokens avoided, and selected instruction tokens. JSON reports include hashes of the dataset, compact index, and private retrieval manifest plus the effective router configuration.

### SkillRouter Eval Core

SkillRAM includes a real adapter for the public [SkillRouter Eval Core](https://github.com/zhengyanzhao1997/SkillRouter). Download the benchmark with the upstream repository’s `scripts/download_eval_data.sh`, install the enhanced models, then run either tier:

```sh
npx skillram eval-public /path/to/SkillRouter/data/eval_core --tier easy
npx skillram eval-public /path/to/SkillRouter/data/eval_core --tier hard
```

For a development run sized to finish in roughly 30 minutes on a machine that embeds about 1.3 skills/second, use:

```sh
npx skillram eval-public /path/to/SkillRouter/data/eval_core \
  --tier easy --quick --state-dir /tmp/skillram-e2e-state
```

`--quick` deterministically selects 15 scorable tasks, a 500-skill pool, and retrieval top-10. It always retains every core and tier-valid graded/degraded skill needed to score those tasks, then adds both lexical hard negatives and seeded random distractors. Customize it with `--sample-tasks`, `--sample-skills`, `--sample-seed`, and `--retrieval-k`. The generated dataset is stored under `<state-dir>/evaluations/datasets/` and reused when its source and settings match. Runtime still depends on hardware; the preset targets less than 30 minutes at the observed 1.3 embeddings/second with roughly one minute per reranked task. This is a regression/development benchmark, not a substitute for publishing the full approximately 80,000-skill Eval Core result.

Stop `skillram serve` before starting a public evaluation so it does not hold a second copy of both checkpoints in accelerator memory; restart it afterward. The evaluator prints each phase, completion percentage, throughput, and ETA. It automatically uses an embedding batch of 2 on Apple MPS/CPU and 16 on CUDA; override this conservatively with `--embedding-batch-size`.

Pool embeddings are streamed into private safetensor shards under `<state-dir>/evaluations/cache/skillrouter/` instead of retaining the full skill corpus in RAM. A `Ctrl-C` during pool embedding preserves completed shards, and reranking checkpoints every completed task. Re-running the identical dataset/model/tier command resumes automatically. Dataset and exact model hashes prevent stale caches from being reused; customize the location with `--eval-cache-dir` and shard frequency with `--checkpoint-every`.

This embeds the public full-text pool, retrieves the top 20, reranks those candidates, writes reproducible prediction JSON, and reports Hit@1, Recall@10, Precision@10, MRR, nDCG@10, and input hashes. It also estimates skill-context usage by comparing the discoverable name/description catalog before vaulting with the full instructions of the top two routed skills; change that assumption with `--load-k`. The estimate excludes the user prompt, conversation, tool output, model response, and provider-specific tokenization, so it is a directional skill-context estimate rather than an API billing measurement. CUDA is strongly preferable for the approximately 80,000-skill pool; MPS works with conservative batches but will be substantially slower. To score an existing prediction file without running inference:

```sh
npx skillram eval-public /path/to/eval_core predictions.json --tier easy --json
```

Public routing scores measure retrieval quality, not end-to-end task completion. Pair them with the native negative/no-skill suite and a SkillsBench-style execution study before making broad product-quality claims.

### SKILLRET

SkillRAM also accepts the public [SKILLRET](https://github.com/ThakiCloud/SKILLRET) v1.1 JSONL layout. Pin the dataset revision when publishing comparisons because v1.0 and v1.1 scores are not directly comparable. Download the Apache-2.0 benchmark metadata and source-licensed public skills, then run the held-out test split:

```sh
hf download ThakiCloud/SKILLRET \
  --repo-type dataset \
  --revision main \
  --local-dir /path/to/SKILLRET

npx skillram eval-public /path/to/SKILLRET \
  --dataset skillret --split test
```

The adapter reads `data/skills/test.jsonl`, `data/queries/test.jsonl`, and `data/qrels/test.jsonl`, embeds `name | description | skill_md`, retrieves and reranks the same way as the SkillRouter evaluation, and reports Hit@1, Recall@10, Precision@10, MRR, nDCG@10, MAP@10, and complete-gold-set retrieval at 10. SKILLRET v1.1 currently contains 6,006 test skills, 4,392 synthetic evaluation queries, and 7,187 binary relevance labels. It does not test no-skill abstention or downstream task execution.

### Monitor and compare evaluations

Read progress without loading either model or contacting the running evaluator:

```sh
npx skillram eval-status /path/to/SkillRouter/data/eval_core
npx skillram eval-status --json
```

Every completed `eval-public` run saves a normalized report under `<state-dir>/evaluations/reports/`. New runs include phase timings, total duration, amortized time per query, device, batch size, and peak process RSS. Compare all saved reports, or pass explicit public/native JSON reports:

```sh
npx skillram eval-report
npx skillram eval-report report-a.json report-b.json --json
npx skillram eval-report --output combined-evaluations.json --json
```

The unified report deliberately does not average unrelated benchmark families. It presents routing accuracy, retrieval metrics, latency, and hashes side-by-side so results remain attributable to their original evaluation protocol.

### Building a credible dataset

1. Collect sanitized prompts from real workflows. Do not generate every prompt by copying skill names or descriptions.
2. Include at least 5–10 cases per important skill: direct requests, paraphrases, terse prompts, noisy prompts, and multi-skill tasks.
3. Make 30–40% of the suite negative: unrelated prompts and difficult near-misses that share vocabulary with a skill but should load nothing.
4. Add ambiguous pairs between overlapping skills and use `forbidden` for costly or unsafe false activations.
5. Label prompts without looking at router output. Ideally use two reviewers and adjudicate disagreements.
6. Keep tuning and held-out evaluation sets separate. Tune thresholds on one set and publish results only from the untouched set.
7. Use at least 100 representative cases for an initial public result. Run deterministic local routing once and any LLM-assisted configuration 3–5 times.
8. Publish the JSON report, SkillRAM version, dataset/index hashes, provider, `--top`, router configuration, and dataset composition. Never present the built-in synthetic smoke test as production accuracy.

If `SKILLRAM_ROUTER_LLM` is enabled, benchmark prompts are sent to that provider during evaluation. Use `--router lexical` or unset the variable when prompts must remain entirely local.

## Secure API-key setup

On zsh, prompt for a key without placing it in shell history:

```sh
read -s "OPENAI_API_KEY?OpenAI API key: "; export OPENAI_API_KEY; echo
# or
read -s "ANTHROPIC_API_KEY?Anthropic API key: "; export ANTHROPIC_API_KEY; echo
```

The key remains in the current shell session. Remove it with `unset OPENAI_API_KEY` or `unset ANTHROPIC_API_KEY`. Do not commit keys or paste them directly into commands. If both keys exist, Anthropic is selected unless `--llm openai` is passed.

## How the estimate works

Token counts use a deterministic lexical approximation (words, punctuation, and a 1.28 multiplier), labeled `lexical-v1`. Repeated text counts only removable copies after the first occurrence. SkillRAM does not invent dollar costs or potential-reduction percentages.

Measurements describe the vaulted subset. “Activation tokens avoided” means the estimated name/description catalog removed from provider discovery; selected full instructions still consume context when a task actually needs them.

## Development

```sh
npm test
node bin/skillram.js receipt ./test --share /tmp/skillram-receipt.svg
node bin/skillram.js install ./test/fixtures --state-dir /tmp/skillram-test --no-integrations
```
