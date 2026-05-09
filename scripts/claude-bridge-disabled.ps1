# claude-bridge-disabled.ps1
#
# Backward-compatible alias for scripts/start-exec-passive.ps1.
# Forwards all arguments unchanged. New work should invoke
# start-exec-passive.ps1 directly.
#
# Rationale and operating model: docs/environment-separation.md

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArgs
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $ScriptDir 'start-exec-passive.ps1') @ClaudeArgs
