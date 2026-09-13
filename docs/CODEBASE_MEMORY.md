# Codebase Memory MCP for Astel Social Engine

This repository includes bootstrap scripts for [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), used as **developer memory / code intelligence** for coding agents.

It is deliberately separate from the application's runtime memory. It is not part of the Threads / Instagram / Facebook production service and should not be deployed to Railway.

## What it does

Codebase Memory indexes the repository into a persistent local knowledge graph so coding agents can query architecture, symbols, call chains, dependencies, HTTP routes, impact of changes, and related code without repeatedly scanning the whole repository.

The official installer auto-detects supported coding agents. In particular, it can configure:

- Claude Code via `~/.claude.json`, plus its installed skill/agents/hooks.
- Codex CLI via `$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`), plus its managed activation pointer, skill, read-only graph agents, and supported lifecycle hooks.

The bootstrap scripts also enable:

- `auto_index = true`
- `auto_watch = true`
- `watcher_enabled = true`

and immediately index this repository with:

```text
codebase-memory-mcp cli index_repository --repo-path <repo-root>
```

## Windows

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\setup-codebase-memory.ps1
```

To re-index/configure an existing install without downloading the installer again:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\setup-codebase-memory.ps1 -SkipInstall
```

## macOS / Linux

From the repository root:

```bash
bash ./tools/setup-codebase-memory.sh
```

For an existing install:

```bash
bash ./tools/setup-codebase-memory.sh --skip-install
```

## Verification

After setup, restart Claude Code and/or Codex. In the coding agent, run `/mcp` and verify that `codebase-memory-mcp` is available. Codex may require explicit review/trust of installed hooks through `/hooks`.

The scripts print whether the expected Claude Code and Codex config files contain the Codebase Memory MCP entry, and list the indexed projects at the end.

Optional graph UI:

```text
codebase-memory-mcp --ui=true --port=9749
```

Then open `http://localhost:9749` locally.

## Security / scope

The bootstrap source is pinned to Codebase Memory commit `339b3f4097aa6ede22fc382ab7fd320d93c498b8` so the installer script itself is reviewable and reproducible. The upstream installer downloads the release binary and performs SHA-256 verification before activating it.

Codebase Memory runs locally. Do not add application access tokens, Meta tokens, OpenAI keys, Airtable keys, database credentials, or Railway secrets to its configuration.

This integration changes developer tooling only. It does **not** change production bot behavior, Meta webhooks, reply safety controls, database schema, or deployment configuration.
