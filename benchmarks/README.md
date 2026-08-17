# SkillRAM benchmarks

`marker.routes.jsonl` is an end-to-end smoke dataset for the disposable `skillram-marker` skill used in the installation guide. It checks direct, paraphrased, terse, noisy, near-miss, and unrelated prompts.

It is intentionally small and must not be presented as production routing accuracy. Public accuracy claims should use a held-out dataset with real skills, at least 100 representative prompts, 30–40% negative cases, human-reviewed labels, and the dataset methodology described in the project README.

```sh
node bin/skillram.js eval benchmarks/marker.routes.jsonl \
  --state-dir /tmp/skillram-e2e-state \
  --router lexical --top 1 --runs 3

node bin/skillram.js eval benchmarks/marker.routes.jsonl \
  --state-dir /tmp/skillram-e2e-state \
  --top 1 --runs 3

# Force full-body Ollama retrieval instead of taking lexical shortcuts.
node bin/skillram.js eval benchmarks/marker.routes.jsonl \
  --state-dir /tmp/skillram-e2e-state \
  --router semantic --top 1 --runs 3

# After installing and starting the optional SkillRouter models.
node bin/skillram.js eval benchmarks/marker.routes.jsonl \
  --state-dir /tmp/skillram-e2e-state \
  --router skillrouter --top 1 --runs 3
```

For the approximately 80K-skill public benchmark, use `skillram eval-public` with a downloaded SkillRouter Eval Core directory. Keep those results separate from this smoke fixture and from end-to-end task-completion measurements.

Stop the long-running `skillram serve` process before `eval-public` to avoid loading duplicate model copies. Public-evaluation pool embeddings and task-level reranking progress are cached automatically, so an interrupted run can resume with the same command.

`skillram eval-public` also supports the SKILLRET JSONL dataset with `--dataset skillret --split test`. Use `skillram eval-status` during a long run and `skillram eval-report` after completion to compare saved public reports without averaging incompatible benchmark families.

## Session suites

`session.smoke.json` exercises the memory hierarchy rather than single-shot retrieval: resident sets, eviction under a tight budget, summary-tier recovery, and refresh. Skills are defined inline, so it needs no vaulted skills and no models.

```sh
node bin/skillram.js eval-session
node bin/skillram.js eval-session --compare
```

Like `marker.routes.jsonl`, it is a development smoke test. Four sessions cannot rank eviction policies against each other, and it must not be presented as production accuracy.
