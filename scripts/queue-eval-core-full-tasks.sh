#!/usr/bin/env bash
# Wait for any in-flight Eval Core run to finish, then evaluate both tiers across every
# scorable task so tier-to-tier comparisons stop being noise-limited.
#
# Eval Core has 87 tasks, of which 75 are scorable; the sampler drops the 12 generic_only
# tasks, so --sample-tasks 75 selects all of them. At 15 tasks a single task moves Hit@1
# by 6.7 points, which is why the 15-task easy and hard numbers cannot be compared.
#
# Budget at the observed 1.2 embeddings/second and ~45 s/task reranking:
#   2,000 skills / 1.2 = ~28 min embedding, 75 x 45 s = ~56 min reranking, ~84 min per tier.
#
# Usage: scripts/queue-eval-core-full-tasks.sh [tasks] [skills] [retrieval-k]

set -euo pipefail

SAMPLE_TASKS="${1:-75}"
SAMPLE_SKILLS="${2:-2000}"
RETRIEVAL_K="${3:-10}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$REPO_ROOT/scripts/run-eval-core.sh"

# Only one evaluation may hold the models at a time. This box has 16 GB of unified memory
# and a single GPU, and a run peaks near 3.5 GB, so concurrent runs contend rather than
# parallelize. Wait the current one out instead of competing with it.
if pgrep -f "service/eval_core.py" >/dev/null 2>&1; then
  echo "Waiting for the in-flight Eval Core run to finish..."
  while pgrep -f "service/eval_core.py" >/dev/null 2>&1; do
    sleep 30
  done
  echo "In-flight run finished. Starting queued evaluations."
  sleep 5
fi

FAILED=0
for TIER in easy hard; do
  echo
  echo "==================================================================="
  echo "Eval Core $TIER · $SAMPLE_TASKS tasks · $SAMPLE_SKILLS skills · k=$RETRIEVAL_K"
  echo "==================================================================="
  if ! "$RUNNER" "$TIER" "$SAMPLE_TASKS" "$SAMPLE_SKILLS" "$RETRIEVAL_K"; then
    echo "Tier $TIER failed; continuing with the remaining tiers." >&2
    FAILED=$((FAILED + 1))
  fi
done

echo
echo "Queued evaluations finished with $FAILED failed tier(s)."
node "$REPO_ROOT/bin/skillram.js" eval-report --state-dir "${SKILLRAM_EVAL_STATE_DIR:-/tmp/skillram-e2e-state}" || true
exit "$FAILED"
