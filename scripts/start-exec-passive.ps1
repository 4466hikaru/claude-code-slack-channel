# scripts/start-exec-passive.ps1
#
# Launch Claude Code with the slack-channel server in PASSIVE execution mode.
# - SLACK_BRIDGE_DISABLE=1 -> server.ts boots passive (no Socket Mode, no
#   journal, no supervisor; tool calls return isError stubs).
# - SLACK_STATE_DIR=~/.claude/channels/slack-passive -> server.ts reads
#   .env and validates token format unconditionally at boot, BEFORE the
#   passive-mode short-circuit. Pointing at a dedicated dir keeps the
#   prod state dir (~/.claude/channels/slack/) completely untouched -
#   no read of prod .env / access.json / sessions / audit.log.
# - On first run, auto-provisions $PassiveStateDir + a placeholder .env
#   with fake tokens. Passive mode never opens a Socket Mode connection,
#   so the tokens are never sent over the wire; their only job is to
#   satisfy server.ts's boot-time format check.
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

$PassiveStateDir = Join-Path $HOME '.claude/channels/slack-passive'
$ProdStateDir    = Join-Path $HOME '.claude/channels/slack'

# Belt-and-suspenders: passive path must not equal prod path. The
# Join-Path values above are constants today; this guards against a
# future edit accidentally collapsing them.
if ($PassiveStateDir -eq $ProdStateDir) {
    Write-Error "[exec-passive] passive state dir collides with prod ($PassiveStateDir). Refusing to launch."
    exit 1
}

# First-run provisioning: create the passive state dir + a placeholder
# .env. The tokens are intentionally fake. server.ts validates the
# xoxb- / xapp- prefix at boot but never sends them because passive
# mode short-circuits before Socket Mode is opened.
if (-not (Test-Path $PassiveStateDir)) {
    New-Item -ItemType Directory -Force -Path $PassiveStateDir | Out-Null
    Write-Host "[exec-passive] Created passive state dir: $PassiveStateDir" -ForegroundColor DarkCyan
}

$PassiveEnv = Join-Path $PassiveStateDir '.env'
if (-not (Test-Path $PassiveEnv)) {
    @(
        'SLACK_BOT_TOKEN=xoxb-disabled',
        'SLACK_APP_TOKEN=xapp-disabled'
    ) | Set-Content -Path $PassiveEnv -Encoding ascii
    Write-Host "[exec-passive] Wrote placeholder .env (fake tokens; never sent because passive mode skips Socket Mode)" -ForegroundColor DarkCyan
}

$env:SLACK_BRIDGE_DISABLE = '1'
$env:SLACK_STATE_DIR      = $PassiveStateDir

Write-Host "[exec-passive] SLACK_BRIDGE_DISABLE=1 + SLACK_STATE_DIR=$PassiveStateDir" -ForegroundColor Cyan
Write-Host "[exec-passive] Passive mode: no Socket Mode, no journal, no supervisor. Slack tool calls return isError stubs." -ForegroundColor Cyan
Write-Host "[exec-passive] Prod state dir is NOT read or written. Route Slack via handoff / Issue / bridge-owner." -ForegroundColor Cyan

& claude @ClaudeArgs
