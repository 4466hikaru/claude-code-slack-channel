# scripts/start-exec-passive.ps1
#
# Launch Claude Code with the slack-channel server in PASSIVE execution mode.
# - SLACK_BRIDGE_DISABLE=1 -> server.ts boots passive (no Socket Mode, no
#   journal, no supervisor; tool calls return isError stubs).
# - This is the default for any session whose job is implementation,
#   testing, or PR creation - not Slack I/O.
# - Route Slack replies via the handoff filesystem channel, GitHub Issues,
#   or the session that owns the prod Slack edge (start-bridge-prod.ps1).
#
# Usage:
#   PS> .\scripts\start-exec-passive.ps1               # interactive
#   PS> .\scripts\start-exec-passive.ps1 -- --resume   # pass-through args
#
# See docs/environment-separation.md for the prod / passive / dev model.

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArgs
)

$env:SLACK_BRIDGE_DISABLE = '1'

Write-Host "[exec-passive] SLACK_BRIDGE_DISABLE=1 - server.ts will boot in passive mode" -ForegroundColor Cyan
Write-Host "[exec-passive] Slack tool calls return isError stubs; route Slack via handoff / Issue / bridge-owner." -ForegroundColor Cyan

& claude @ClaudeArgs
