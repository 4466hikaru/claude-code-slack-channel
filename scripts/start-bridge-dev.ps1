# scripts/start-bridge-dev.ps1
#
# Launch Claude Code with the slack-channel server in DEV bridge mode.
# - SLACK_STATE_DIR=~/.claude/channels/slack-dev -> fully isolated state dir
# - Requires a separate dev Slack app (separate xoxb / xapp tokens
#   provisioned into the dev state dir's .env file)
# - SKELETON: dev tokens / state dir not yet provisioned. Refuses to
#   launch until the TODO block below is satisfied. Replace this block
#   when you provision dev infra.
#
# Usage:
#   PS> .\scripts\start-bridge-dev.ps1               # interactive
#   PS> .\scripts\start-bridge-dev.ps1 -- --resume   # pass-through args
#
# See docs/environment-separation.md for the prod / passive / dev model.

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArgs
)

$DevStateDir  = Join-Path $HOME '.claude/channels/slack-dev'
$ProdStateDir = Join-Path $HOME '.claude/channels/slack'

# Belt-and-suspenders: dev path must not equal prod path. The Join-Path
# values above are constants today; this guards against a future edit
# accidentally collapsing them.
if ($DevStateDir -eq $ProdStateDir) {
    Write-Error "[bridge-dev] dev state dir collides with prod ($DevStateDir). Refusing to launch."
    exit 1
}

# TODO (provision before first use):
#   1. New-Item -ItemType Directory -Force -Path $DevStateDir
#   2. Create a separate dev Slack app (separate workspace OR a clearly
#      named '-dev' app in the same workspace).
#   3. Generate fresh xoxb-/xapp- tokens for the dev app.
#   4. Write "$DevStateDir/.env" with the dev tokens (restrict to user,
#      equivalent of chmod 0o600). Format mirrors the prod
#      ~/.claude/channels/slack/.env.
#   5. (Optional) Seed "$DevStateDir/access.json" with the dev workspace's
#      allowlist - keep DISJOINT from prod access.json.
# Until provisioned, server.ts boots and immediately fails on missing
# .env. The check below short-circuits with a clearer message.

if (-not (Test-Path (Join-Path $DevStateDir '.env'))) {
    Write-Warning "[bridge-dev] dev state dir not provisioned (no .env at $DevStateDir/.env)."
    Write-Warning "[bridge-dev] Follow the TODO block in this script before launching. Aborting."
    exit 1
}

# Defensive: clear any inherited passive flag (caller may have it set
# from a prior exec-passive session).
if ($env:SLACK_BRIDGE_DISABLE) {
    Write-Host "[bridge-dev] Clearing inherited SLACK_BRIDGE_DISABLE=$env:SLACK_BRIDGE_DISABLE" -ForegroundColor Yellow
    Remove-Item Env:\SLACK_BRIDGE_DISABLE
}

$env:SLACK_STATE_DIR = $DevStateDir

Write-Host "[bridge-dev] DEV bridge - state dir = $DevStateDir" -ForegroundColor Cyan
Write-Host "[bridge-dev] WARNING: dev session must use a SEPARATE Slack app - never share prod tokens." -ForegroundColor Yellow

& claude @ClaudeArgs
