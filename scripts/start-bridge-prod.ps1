# scripts/start-bridge-prod.ps1
#
# Launch Claude Code with the slack-channel server in PROD bridge mode.
# - Owns the singular Slack Socket Mode connection (no SLACK_BRIDGE_DISABLE)
# - Uses the default state dir: ~/.claude/channels/slack
# - This must be the ONLY session holding the prod Slack edge.
#
# Usage:
#   PS> .\scripts\start-bridge-prod.ps1               # interactive
#   PS> .\scripts\start-bridge-prod.ps1 -- --resume   # pass-through args
#
# See docs/environment-separation.md for the prod / passive / dev model.

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArgs
)

# Defensive: clear any inherited env vars that would put server.ts into
# passive or dev mode. Prod is "default behavior" but if the parent shell
# set SLACK_BRIDGE_DISABLE / SLACK_STATE_DIR (e.g. during testing or
# session reuse), inheriting them would silently break prod.
if ($env:SLACK_BRIDGE_DISABLE) {
    Write-Host "[bridge-prod] Clearing inherited SLACK_BRIDGE_DISABLE=$env:SLACK_BRIDGE_DISABLE" -ForegroundColor Yellow
    Remove-Item Env:\SLACK_BRIDGE_DISABLE
}
if ($env:SLACK_STATE_DIR) {
    Write-Host "[bridge-prod] Clearing inherited SLACK_STATE_DIR=$env:SLACK_STATE_DIR (using prod default)" -ForegroundColor Yellow
    Remove-Item Env:\SLACK_STATE_DIR
}

Write-Host "[bridge-prod] PROD bridge - Slack Socket Mode owner; state dir = ~/.claude/channels/slack" -ForegroundColor Cyan
Write-Host "[bridge-prod] Reminder: only ONE prod bridge session may run at a time." -ForegroundColor Cyan

& claude @ClaudeArgs
