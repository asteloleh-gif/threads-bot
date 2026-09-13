#!/usr/bin/env bash
set -euo pipefail

# Pin the installer source so the bootstrap itself is reviewable and reproducible.
# The official installer still downloads the latest release binary and verifies
# the release SHA-256 checksum before installing it.
CBM_SOURCE_COMMIT="339b3f4097aa6ede22fc382ab7fd320d93c498b8"
INSTALLER_URL="https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/${CBM_SOURCE_COMMIT}/install.sh"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [[ "${1:-}" != "--skip-install" ]]; then
  tmp_installer="$(mktemp)"
  trap 'rm -f "$tmp_installer"' EXIT

  echo "Downloading reviewed Codebase Memory installer..."
  curl -fsSL "$INSTALLER_URL" -o "$tmp_installer"

  echo "Installing Codebase Memory MCP and configuring detected coding agents..."
  bash "$tmp_installer"
fi

if ! command -v codebase-memory-mcp >/dev/null 2>&1; then
  echo "error: codebase-memory-mcp was not found. Re-run without --skip-install." >&2
  exit 1
fi

CBM="$(command -v codebase-memory-mcp)"
echo "Codebase Memory binary: $CBM"
"$CBM" --version

# Keep the graph fresh automatically for active development sessions.
"$CBM" config set auto_index true
"$CBM" config set auto_watch true
"$CBM" config set watcher_enabled true

echo "Indexing repository: $REPO_ROOT"
"$CBM" cli index_repository --repo-path "$REPO_ROOT"

echo "Indexed projects:"
"$CBM" cli list_projects

claude_config="$HOME/.claude.json"
codex_home="${CODEX_HOME:-$HOME/.codex}"
codex_config="$codex_home/config.toml"

claude_status="not detected/configured"
codex_status="not detected/configured"
if [[ -f "$claude_config" ]] && grep -q "codebase-memory-mcp" "$claude_config"; then
  claude_status="configured"
fi
if [[ -f "$codex_config" ]] && grep -q "codebase-memory-mcp" "$codex_config"; then
  codex_status="configured"
fi

printf '\nAgent integration status:\n'
printf '  Claude Code: %s\n' "$claude_status"
printf '  Codex CLI:   %s\n' "$codex_status"
printf '\nSetup complete. Restart Claude Code / Codex so they reload MCP configuration and hooks.\n'
printf 'In the agent, use /mcp to verify codebase-memory-mcp. Codex may also ask you to trust installed hooks via /hooks.\n'
