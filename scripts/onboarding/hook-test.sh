#!/usr/bin/env bash
# Runs the agent-memory plugin installed in one Claude profile the way Claude Code would, for one synthetic session:
# SessionStart, then UserPromptSubmit with a test prompt, then SessionEnd. Prints each hook's outcome and counts of
# what it would inject (never memory content), and exits non-zero when a hook did not get a healthy answer.
#
# Usage: hook-test.sh [claude-config-dir] [prompt]
#   claude-config-dir  default: $CLAUDE_CONFIG_DIR, else ~/.claude
#   prompt             the UserPromptSubmit text to recall for (default: a generic engineering question)
#
# The run uses its own temporary cache directory, so it leaves no session state or diagnostics behind.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
use_claude_profile "${1:-}"
PROMPT="${2:-how do we deploy and test changes to this service}"
find_tools
ROOT="$(installed_plugin_root "$CLAUDE_DIR")"
[ -n "$ROOT" ] || die "$PLUGIN_KEY is not installed in $CLAUDE_DIR (run install-claude-profile.sh)"
echo "$CLAUDE_DIR: $PLUGIN_KEY $(basename "$ROOT")"
node "$ONBOARDING_DIR/lib.mjs" probe-hooks "$ROOT" "$PROMPT"
