# Sourced by the onboarding scripts in this directory; not run directly.

ONBOARDING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_PLUGIN_DIR="$(cd "$ONBOARDING_DIR/../.." && pwd)/claude-plugin"
PLUGIN_KEY="agent-memory@agent-memory"

die() {
	echo "$(basename "$0"): $*" >&2
	exit 1
}

# Puts node (and claude, when asked) on PATH. Only when missing: a login shell under nvm or Homebrew usually has
# them, but a non-interactive one (cron, ssh host 'cmd') often does not.
find_tools() {
	local need
	for need in node "$@"; do
		command -v "$need" >/dev/null 2>&1 && continue
		PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
		if ! command -v "$need" >/dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
			# nvm.sh reads unset variables, which would end a `set -u` script.
			set +u
			# shellcheck disable=SC1091
			. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 || true
			set -u
		fi
		command -v "$need" >/dev/null 2>&1 || die "$need not found on PATH"
	done
	export PATH
}

# Prints the installPath of the plugin's user-scope install in a Claude config dir, or nothing.
installed_plugin_root() {
	node -e '
const fs = require("fs");
let records;
try { records = JSON.parse(fs.readFileSync(process.argv[1] + "/plugins/installed_plugins.json", "utf8")).plugins?.[process.argv[2]]; } catch {}
const record = (records ?? []).find((r) => r.scope === "user");
if (record?.installPath && fs.existsSync(record.installPath + "/hooks/hook.mjs")) process.stdout.write(record.installPath);
' "$1" "$PLUGIN_KEY"
}

# Points the claude CLI at one profile. The default profile runs with CLAUDE_CONFIG_DIR unset: setting it, even to
# ~/.claude, moves where Claude Code keeps its global state.
use_claude_profile() {
	CLAUDE_DIR="${1:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
	CLAUDE_DIR="${CLAUDE_DIR%/}"
	if [ "$CLAUDE_DIR" = "$HOME/.claude" ]; then unset CLAUDE_CONFIG_DIR; else export CLAUDE_CONFIG_DIR="$CLAUDE_DIR"; fi
}
