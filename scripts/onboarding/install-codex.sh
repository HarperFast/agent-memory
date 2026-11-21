#!/usr/bin/env bash
# Adds agent-memory to one Codex home: an [mcp_servers.agent-memory] streamable-HTTP entry and SessionStart,
# UserPromptSubmit and SessionEnd hooks that run the Claude Code plugin's hook.
#
# Usage: install-codex.sh [codex-home] [hook.mjs]
#   codex-home  default: $CODEX_HOME, else ~/.codex
#   hook.mjs    a plugin's hooks/hook.mjs; that plugin directory is what gets copied (default: the plugin installed
#               in $CLAUDE_CONFIG_DIR or ~/.claude, else this checkout's claude-plugin/hooks/hook.mjs)
#
# The plugin's runtime is copied to <codex-home>/agent-memory/plugin and the hooks run that copy: Claude Code
# deletes a replaced plugin version's directory 14 days after an update, so hooks pointing into its cache would
# break. Rerun after updating the Claude plugin to bring Codex to the same code.
#
# The Authorization header (from ~/.config/agent-memory/env or $AGENT_MEMORY_ENV_FILE) is written into config.toml,
# which is set to mode 0600. config.toml and hooks.json are backed up once, to *.pre-agent-memory. The hooks are
# marked trusted in config.toml, so Codex runs them without a review prompt. Safe to rerun.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
CODEX_DIR="${1:-${CODEX_HOME:-$HOME/.codex}}"
HOOK="${2:-}"
find_tools
if [ -z "$HOOK" ]; then
	ROOT="$(installed_plugin_root "${CLAUDE_CONFIG_DIR:-$HOME/.claude}")"
	if [ -n "$ROOT" ]; then HOOK="$ROOT/hooks/hook.mjs"; else
		HOOK="$REPO_PLUGIN_DIR/hooks/hook.mjs"
		echo "no installed Claude plugin found; using this checkout's $HOOK"
	fi
fi
[ -f "$HOOK" ] || die "missing $HOOK"
NODE_BIN="$(command -v node)" node "$ONBOARDING_DIR/lib.mjs" configure-codex "$CODEX_DIR" "$(cd "$(dirname "$HOOK")/.." && pwd)"
