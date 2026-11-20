#!/usr/bin/env bash
# Installs (or updates) the agent-memory Claude Code plugin in one Claude profile.
#
# Usage: install-claude-profile.sh [claude-config-dir] [marketplace-source]
#   claude-config-dir   the profile to install into (default: $CLAUDE_CONFIG_DIR, else ~/.claude)
#   marketplace-source  what `claude plugin marketplace add` gets the first time (default: HarperFast/agent-memory;
#                       a local checkout path or owner/repo#ref also work)
#
# Reads AGENT_MEMORY_URL from ~/.config/agent-memory/env (or $AGENT_MEMORY_ENV_FILE) and sets it in the profile's
# settings.json `env` block, which the plugin's MCP server entry needs. The token stays in the env file: nothing
# secret is written to settings.json. Safe to rerun; a rerun brings an existing install to the latest version.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
use_claude_profile "${1:-}"
SOURCE="${2:-HarperFast/agent-memory}"
find_tools claude
mkdir -p "$CLAUDE_DIR"

# Before touching the profile: refuse to install a plugin that would have no endpoint or credential.
node "$ONBOARDING_DIR/lib.mjs" claude-settings "$CLAUDE_DIR/settings.json"

if claude plugin marketplace list 2>/dev/null | grep -qw agent-memory; then
	claude plugin marketplace update agent-memory >/dev/null
else
	claude plugin marketplace add "$SOURCE"
fi
if [ -n "$(installed_plugin_root "$CLAUDE_DIR")" ]; then
	claude plugin update "$PLUGIN_KEY" --scope user
else
	claude plugin install "$PLUGIN_KEY" --scope user
fi

ROOT="$(installed_plugin_root "$CLAUDE_DIR")"
[ -n "$ROOT" ] || die "the plugin did not install into $CLAUDE_DIR"
echo "$CLAUDE_DIR: $PLUGIN_KEY $(basename "$ROOT") installed; new sessions load it (running ones keep their version)"
