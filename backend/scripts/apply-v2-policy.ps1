# Widens the bot's Turnkey policy to allow the pons v2 factory.
#
#   powershell -File scripts\apply-v2-policy.ps1
#   powershell -File scripts\apply-v2-policy.ps1 -Execute
#
# WHY A POWERSHELL COPY OF apply-v2-policy.sh EXISTS
# --------------------------------------------------
# The bash wrapper assumed Git Bash. On this machine `bash` resolves to WSL, which
# cannot see a `C:/...` path at all and has a different home directory -- so it found
# neither the script nor the key file. Rather than teach the operator to translate
# paths under pressure, while holding the one credential that can rewrite the
# treasury's guard rails, here is the same thing in the shell they actually have.
#
# WHAT IT DOES
# ------------
# Reads the two root values straight out of the key file into this process's
# environment and passes them to one command. They are never printed, never written
# anywhere, and never placed on a command line -- which is the point: a root
# credential pasted into a prompt ends up in shell history, the process list, and any
# scrollback that gets shared later.
#
# AFTERWARDS the key file should not survive. Root bypasses the policy engine
# entirely, so while it sits in plaintext beside the bot it undoes the whole reason
# the bot's own key is scoped. A fresh one can be minted from the Turnkey dashboard
# with a passkey, so deleting it loses nothing.

param(
    [switch]$Execute,
    [string]$KeyFile = "$HOME\ponsr-turnkey-root-key.txt"
)

$ErrorActionPreference = 'Stop'

# Run from backend/ regardless of where this was invoked, so npx finds node_modules.
$backend = Split-Path -Parent $PSScriptRoot
Set-Location $backend

# The plan needs no credentials, so it does not touch the key file. Reading a root
# credential to print a summary that never uses it is exposure bought for nothing --
# and this file is meant to be deleted, so the fewer things that open it, the better.
if (-not $Execute) {
    Write-Host "PLAN ONLY -- the key file is not opened." -ForegroundColor DarkGray
    Write-Host ""
    npx tsx scripts\turnkey-allow-v2-factory.ts
    exit $LASTEXITCODE
}

if (-not (Test-Path $KeyFile)) {
    Write-Host "Root key file not found: $KeyFile" -ForegroundColor Red
    Write-Host ""
    Write-Host "If you have already moved it into a password manager (good), set the two"
    Write-Host "values for this session instead and run the script directly:"
    Write-Host ""
    Write-Host '  $env:TURNKEY_ROOT_PUBLIC_KEY = "..."'
    Write-Host '  $env:TURNKEY_ROOT_PRIVATE_KEY = "..."'
    Write-Host '  npx tsx scripts\turnkey-allow-v2-factory.ts --execute'
    exit 1
}

# Only the two names needed. The file may hold other things that have no business in
# this environment.
$pub = $null
$priv = $null
foreach ($line in Get-Content $KeyFile) {
    if ($line -match '^\s*TURNKEY_ROOT_API_PUBLIC_KEY\s*=\s*(.+?)\s*$')  { $pub  = $Matches[1].Trim('"',"'") }
    if ($line -match '^\s*TURNKEY_ROOT_API_PRIVATE_KEY\s*=\s*(.+?)\s*$') { $priv = $Matches[1].Trim('"',"'") }
}

if ([string]::IsNullOrWhiteSpace($pub) -or [string]::IsNullOrWhiteSpace($priv)) {
    Write-Host "Could not read both TURNKEY_ROOT_API_PUBLIC_KEY and TURNKEY_ROOT_API_PRIVATE_KEY" -ForegroundColor Red
    Write-Host "from $KeyFile. Nothing was attempted."
    exit 1
}

Write-Host "Read the root credentials from $KeyFile (values not shown)."
Write-Host ""

$env:TURNKEY_ROOT_PUBLIC_KEY = $pub
$env:TURNKEY_ROOT_PRIVATE_KEY = $priv

try {
    npx tsx scripts\turnkey-allow-v2-factory.ts --execute
    $code = $LASTEXITCODE
} finally {
    # Cleared even on failure. This process may outlive the command -- an interactive
    # window keeps its environment, and a root credential left in it is a root
    # credential inherited by every child process started afterwards.
    Remove-Item Env:\TURNKEY_ROOT_PUBLIC_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\TURNKEY_ROOT_PRIVATE_KEY -ErrorAction SilentlyContinue
}

if ($Execute -and $code -eq 0) {
    Write-Host ""
    Write-Host "=============================================================="
    Write-Host "NEXT, AND DO NOT SKIP IT:"
    Write-Host ""
    Write-Host "  npx tsx scripts\turnkey-verify-policy.ts"
    Write-Host ""
    Write-Host "Two lines matter, not one:"
    Write-Host "  1b. tx to the v2 factory       must read ALLOWED"
    Write-Host "  3.  tx to an arbitrary address must still read denied"
    Write-Host ""
    Write-Host "A policy that is too wide looks exactly like a correct one until the"
    Write-Host "morning it matters. Line 3 is the only thing that tells them apart."
    Write-Host ""
    Write-Host "THEN: move $KeyFile into a password manager and delete it."
    Write-Host "=============================================================="
}

exit $code
