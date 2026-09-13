param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

# Pin the installer source so the bootstrap itself is reviewable and reproducible.
# The official installer still downloads the latest release binary and verifies
# the release SHA-256 checksum before installing it.
$CbmSourceCommit = "339b3f4097aa6ede22fc382ab7fd320d93c498b8"
$InstallerUrl = "https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/$CbmSourceCommit/install.ps1"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Find-CbmBinary {
    $command = Get-Command codebase-memory-mcp.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $command = Get-Command codebase-memory-mcp -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $defaultPath = Join-Path $env:LOCALAPPDATA "Programs\codebase-memory-mcp\codebase-memory-mcp.exe"
    if (Test-Path -LiteralPath $defaultPath -PathType Leaf) { return $defaultPath }

    return $null
}

if (-not $SkipInstall) {
    $tempInstaller = Join-Path $env:TEMP "codebase-memory-mcp-install-$CbmSourceCommit.ps1"
    Write-Host "Downloading reviewed Codebase Memory installer..."
    Invoke-WebRequest -Uri $InstallerUrl -OutFile $tempInstaller
    Unblock-File -LiteralPath $tempInstaller -ErrorAction SilentlyContinue

    Write-Host "Installing Codebase Memory MCP and configuring detected coding agents..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tempInstaller
    if ($LASTEXITCODE -ne 0) {
        throw "Codebase Memory installer exited with code $LASTEXITCODE"
    }
}

$Cbm = Find-CbmBinary
if (-not $Cbm) {
    throw "codebase-memory-mcp was not found. Run this script without -SkipInstall first."
}

Write-Host "Codebase Memory binary: $Cbm"
& $Cbm --version
if ($LASTEXITCODE -ne 0) { throw "codebase-memory-mcp --version failed" }

# Keep the graph fresh automatically for active development sessions.
& $Cbm config set auto_index true
if ($LASTEXITCODE -ne 0) { throw "Failed to enable auto_index" }
& $Cbm config set auto_watch true
if ($LASTEXITCODE -ne 0) { throw "Failed to enable auto_watch" }
& $Cbm config set watcher_enabled true
if ($LASTEXITCODE -ne 0) { throw "Failed to enable watcher_enabled" }

Write-Host "Indexing repository: $RepoRoot"
& $Cbm cli index_repository --repo-path $RepoRoot
if ($LASTEXITCODE -ne 0) { throw "Repository indexing failed" }

Write-Host "Indexed projects:"
& $Cbm cli list_projects
if ($LASTEXITCODE -ne 0) { throw "Could not list indexed projects" }

$ClaudeConfig = Join-Path $HOME ".claude.json"
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$CodexConfig = Join-Path $CodexHome "config.toml"

$ClaudeConfigured = (Test-Path -LiteralPath $ClaudeConfig) -and
    (Select-String -LiteralPath $ClaudeConfig -Pattern "codebase-memory-mcp" -Quiet -ErrorAction SilentlyContinue)
$CodexConfigured = (Test-Path -LiteralPath $CodexConfig) -and
    (Select-String -LiteralPath $CodexConfig -Pattern "codebase-memory-mcp" -Quiet -ErrorAction SilentlyContinue)

Write-Host ""
Write-Host "Agent integration status:"
Write-Host ("  Claude Code: " + $(if ($ClaudeConfigured) { "configured" } else { "not detected/configured" }))
Write-Host ("  Codex CLI:   " + $(if ($CodexConfigured) { "configured" } else { "not detected/configured" }))
Write-Host ""
Write-Host "Setup complete. Restart Claude Code / Codex so they reload MCP configuration and hooks."
Write-Host "In the agent, use /mcp to verify codebase-memory-mcp. Codex may also ask you to trust installed hooks via /hooks."
