# claude-bridge-disabled.ps1
#
# Launch Claude Code with SLACK_BRIDGE_DISABLE=1 set in the environment
# so the spawned slack-channel MCP server (server.ts) boots into passive
# mode (no Socket Mode, no journal, no supervisor; tool calls return
# isError stubs).
#
# Use this wrapper for the EXECUTION session — the one that should NOT
# hold the Slack edge while the consultation session does. The other
# session (e.g. hikaru-agent-knowledge/) launches plain `claude` so its
# server.ts boots normally and owns the single Socket Mode connection.
#
# Usage:
#   PS> .\scripts\claude-bridge-disabled.ps1               # interactive
#   PS> .\scripts\claude-bridge-disabled.ps1 -- --resume   # pass-through args
#
# Why a wrapper instead of project-scoped settings.local.json env?
# `.claude/settings.local.json` SHOULD propagate `env` entries to
# spawned MCP child processes (per Claude Code's update-config semantics),
# but if that propagation turns out not to apply on Windows / this Claude
# Code build, this wrapper is the deterministic fallback. Either path
# achieves the same end state — server.ts sees SLACK_BRIDGE_DISABLE=1
# in process.env and isBridgeDisabled() returns true.

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArgs
)

$env:SLACK_BRIDGE_DISABLE = '1'

Write-Host "[bridge-disabled] SLACK_BRIDGE_DISABLE=1 set; spawning claude..." -ForegroundColor Cyan
Write-Host "[bridge-disabled] Expect server.ts stderr to show 'passive mode'" -ForegroundColor Cyan

& claude @ClaudeArgs
