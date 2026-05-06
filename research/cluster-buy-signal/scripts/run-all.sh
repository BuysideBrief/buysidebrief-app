#!/usr/bin/env bash
# run-all.sh — orchestrates the full cluster-buy-signal backtest.
#
# Designed to run detached:
#   nohup ./research/cluster-buy-signal/scripts/run-all.sh > research/cluster-buy-signal/run.log 2>&1 &
#
# Each step is idempotent — pass --force to rebuild every step from scratch.

set -euo pipefail

# Resolve directories from this script's path so the orchestrator works
# regardless of cwd. ROOT = research/cluster-buy-signal; REPO = repo root.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"

LOG="$ROOT/run.log"
echo "==== run-all.sh started at $(date -u +%FT%TZ) ====" >> "$LOG"
echo "REPO=$REPO ROOT=$ROOT" >> "$LOG"

EXTRA=()
if [[ "${1:-}" == "--force" ]]; then EXTRA+=(--force); fi

NODE_BIN="${NODE_BIN:-node}"
ENV_FILE="$REPO/.env.local"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "FATAL: $ENV_FILE missing" | tee -a "$LOG" >&2
  exit 1
fi

# Run each script with the project-standard dotenv invocation.
# Working dir is the REPO so dotenv resolves modules and the path is sane.
run_step() {
  local label="$1"; shift
  echo "" >> "$LOG"
  echo "---- $label @ $(date -u +%FT%TZ) ----" >> "$LOG"
  if (cd "$REPO" && DOTENV_CONFIG_PATH="$ENV_FILE" "$NODE_BIN" -r dotenv/config "$@") >> "$LOG" 2>&1; then
    echo "---- $label OK ----" >> "$LOG"
  else
    local ec=$?
    echo "---- $label FAILED (exit $ec) ----" >> "$LOG"
    return $ec
  fi
}

run_step "01-fetch-filings"     "$ROOT/scripts/01-fetch-filings.js"     ${EXTRA[@]+"${EXTRA[@]}"}
run_step "02-assign-cohorts"    "$ROOT/scripts/02-assign-cohorts.js"    ${EXTRA[@]+"${EXTRA[@]}"}
run_step "03-fetch-prices"      "$ROOT/scripts/03-fetch-prices.js"      ${EXTRA[@]+"${EXTRA[@]}"}
run_step "04-calculate-returns" "$ROOT/scripts/04-calculate-returns.js" ${EXTRA[@]+"${EXTRA[@]}"}
run_step "05-analyze"           "$ROOT/scripts/05-analyze.js"

echo "" >> "$LOG"
echo "==== run-all.sh DONE at $(date -u +%FT%TZ) ====" >> "$LOG"
