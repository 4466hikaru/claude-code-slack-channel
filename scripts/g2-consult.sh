#!/usr/bin/env bash
# G2-friendly shortcut for terminal -> Slack/Codex consult relay.
# Queue registration only; delegates all safety behavior to terminal-consult.ts.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [[ -n "${BUN_BIN:-}" ]]; then
  BUN="${BUN_BIN}"
elif [[ -x "${HOME}/.bun/bin/bun" ]]; then
  BUN="${HOME}/.bun/bin/bun"
else
  BUN="bun"
fi

exec "${BUN}" "${REPO_ROOT}/scripts/terminal-consult.ts" "$@"