#!/usr/bin/env bash
# Run a bounded SkillRouter Eval Core evaluation that finishes inside a ~30 minute budget.
#
# The full pool is roughly 79,000 skills. At the observed 1.5 embeddings/second on Apple
# MPS that is about 15 hours for the embedding phase alone, so a bounded sample is the
# only way to stay inside the budget. Defaults match the easy-tier run already saved under
# <state-dir>/evaluations/reports/, so tiers stay directly comparable.
#
# Usage:
#   scripts/run-eval-core.sh [tier] [tasks] [skills] [retrieval-k]
#
# Examples:
#   scripts/run-eval-core.sh                # hard tier, 15 tasks, 500 skills, k=10
#   scripts/run-eval-core.sh easy 20 700 10

set -euo pipefail

TIER="${1:-hard}"
SAMPLE_TASKS="${2:-15}"
SAMPLE_SKILLS="${3:-500}"
RETRIEVAL_K="${4:-10}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT="${SKILLRAM_EVAL_DATA_ROOT:-$REPO_ROOT/SkillRouter/data/eval_core}"
STATE_DIR="${SKILLRAM_EVAL_STATE_DIR:-/tmp/skillram-e2e-state}"
SEED="${SKILLRAM_EVAL_SEED:-skillram-dev-v1}"

case "$TIER" in
  easy|hard) ;;
  *) echo "tier must be easy or hard, got '$TIER'" >&2; exit 2 ;;
esac

if [ ! -f "$DATA_ROOT/relevance.json" ]; then
  echo "No Eval Core dataset at $DATA_ROOT (expected relevance.json)." >&2
  echo "Download it with the upstream SkillRouter scripts/download_eval_data.sh." >&2
  exit 2
fi

# A live model service holds a second copy of both checkpoints in accelerator memory and
# will slow or OOM the evaluation. Refuse to compete with it.
if pgrep -f "skillrouter_service.py" >/dev/null 2>&1; then
  echo "The SkillRAM model service is running. Stop it before evaluating:" >&2
  echo "  pkill -f skillrouter_service.py" >&2
  exit 2
fi

# Saved reports are keyed by benchmark and partition, so a re-run of the same tier
# overwrites the previous one. Keep a timestamped copy first.
REPORT="$STATE_DIR/evaluations/reports/skillrouter-eval-core-$TIER.json"
if [ -f "$REPORT" ]; then
  BACKUP="$REPORT.$(date +%Y%m%dT%H%M%S).bak"
  cp "$REPORT" "$BACKUP"
  echo "Backed up existing $TIER report to $BACKUP"
fi

LOG_DIR="${SKILLRAM_EVAL_LOG_DIR:-$STATE_DIR/evaluations/logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/eval-core-$TIER-$(date +%Y%m%dT%H%M%S).log"

echo "Eval Core $TIER tier: $SAMPLE_TASKS tasks, $SAMPLE_SKILLS skills, k=$RETRIEVAL_K, seed $SEED"
echo "Data root:  $DATA_ROOT"
echo "State dir:  $STATE_DIR"
echo "Log:        $LOG"
echo

START=$(date +%s)
set +e
node "$REPO_ROOT/bin/skillram.js" eval-public "$DATA_ROOT" \
  --tier "$TIER" \
  --sample-tasks "$SAMPLE_TASKS" \
  --sample-skills "$SAMPLE_SKILLS" \
  --sample-seed "$SEED" \
  --retrieval-k "$RETRIEVAL_K" \
  --state-dir "$STATE_DIR" 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}
set -e
ELAPSED=$(( $(date +%s) - START ))

echo
printf 'Elapsed: %dm %ds\n' $(( ELAPSED / 60 )) $(( ELAPSED % 60 ))

if [ "$STATUS" -ne 0 ]; then
  echo "Evaluation failed with exit code $STATUS. See $LOG" >&2
  echo "Pool embeddings and per-task reranking are checkpointed, so re-running this" >&2
  echo "same command resumes instead of starting over." >&2
  exit "$STATUS"
fi

echo "Report: $REPORT"
echo
echo "Compare saved reports with:"
echo "  node $REPO_ROOT/bin/skillram.js eval-report --state-dir $STATE_DIR"
