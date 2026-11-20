# Onboarding: agent-memory in Claude Code and Codex

This guide takes an engineer from nothing to Claude Code (and optionally Codex) sessions that bootstrap from,
recall from and write to a team's agent-memory server. It covers each step in order: provision a user, install
into each Claude profile, add Codex, verify, then update, roll back or uninstall.

You need Node.js 22 or later and the `claude` CLI on `PATH`, plus a clone of this repository, where the scripts
live:

```sh
git clone https://github.com/HarperFast/agent-memory.git && cd agent-memory
```

Every script reads the server's URL and your credential from `~/.config/agent-memory/env`. Set
`AGENT_MEMORY_ENV_FILE` to use another path. No script takes a host, URL or password as an argument, and none
prints the token.

## 1. Provision a user (admin)

An admin with SSH access to a cluster node creates the user with
[`deploy/engineering/provision-user.sh`](../deploy/engineering/provision-user.sh). The script generates a
password, sends it to the cluster on stdin, and writes the credential file straight onto the target machine with
mode 0600. The password is never printed. The cluster comes from the environment, never from the repository
([`deploy/engineering/README.md`](../deploy/engineering/README.md)):

```sh
export AGENT_MEMORY_DEPLOY_HOST=<ssh host of one node>
export AGENT_MEMORY_CONTAINER_MATCH=<substring of the agent-memory container name>
export AGENT_MEMORY_URL=<cluster base URL>

# The person: role eng.
deploy/engineering/provision-user.sh <person> eng <target>

# Their agents: role eng-agents, acting for the person, so the agents can correct the person's memories and
# share user:<person>.
deploy/engineering/provision-user.sh <person>-agents eng-agents <target> --acts-for <person>
```

`<target>` is where the credentials go:

- `local` writes this machine's `~/.config/agent-memory/env`.
- `ssh:<user@host>` writes the file on that machine.
- `none` creates the user without writing credentials anywhere. Rerun with `--rotate` later to issue some.

A machine has one env file, so its sessions act as whoever's credentials are in it. On a machine where Claude
Code or Codex works on someone's behalf, write the `eng-agents` user's credentials there, and keep the person's
own `eng` credentials for where they authenticate themselves.

The file looks like this:

```sh
AGENT_MEMORY_URL=https://memory.example.com
AGENT_MEMORY_TOKEN=Basic <base64 user:password>
AGENT_MEMORY_USER=<username>
```

To revoke delegation, upsert `actsFor: null` on the agent user's `ScopeGrant` row. To issue a new password, rerun
with `--rotate`.

## 2. Install into each Claude profile

```sh
scripts/onboarding/install-claude-profile.sh                # the default profile (~/.claude, or $CLAUDE_CONFIG_DIR)
scripts/onboarding/install-claude-profile.sh ~/.claude-work # any other profile, by its config dir
```

For each profile, the script:

1. Refuses to start if the env file has no usable URL and token.
2. Adds the `HarperFast/agent-memory` marketplace, or refreshes it if it is already there.
3. Installs the plugin at user scope, or updates an existing install.
4. Sets `AGENT_MEMORY_URL` (and a non-default `AGENT_MEMORY_ENV_FILE`) in the profile's `settings.json` `env`
   block. The plugin's MCP server entry expands `${AGENT_MEMORY_URL}/mcp` from there.

The token stays in the env file and is never written to `settings.json`. Rerunning the script is safe. A second
argument replaces the marketplace source, for example a local checkout path or `HarperFast/agent-memory#<ref>`.

Start a new session afterwards: a running session keeps the plugin version it started with.

Without a checkout, the same install by hand:

```text
/plugin marketplace add HarperFast/agent-memory
/plugin install agent-memory@agent-memory
```

Then add `"env": { "AGENT_MEMORY_URL": "<the URL from your env file>" }` to the profile's `settings.json`.

A harness that gives Claude Code its own `HOME` must pass `AGENT_MEMORY_ENV_FILE`, or the hooks find no token.
Session start then injects a notice saying what is missing.

## 3. Add Codex (optional)

```sh
scripts/onboarding/install-codex.sh                  # ~/.codex, or $CODEX_HOME
scripts/onboarding/install-codex.sh ~/.codex-other   # another Codex home
```

The script gives Codex the same memory as Claude Code:

- An `[mcp_servers.agent-memory]` streamable-HTTP entry in `config.toml`. It carries the `Authorization` header,
  so the script sets the file to mode 0600.
- `SessionStart`, `UserPromptSubmit` and `SessionEnd` hooks in `hooks.json` that run the plugin's hook.
- A `trusted_hash` for each of those hooks in `config.toml`, so Codex runs them without asking you to review
  them.

The hooks run a copy of the plugin in `<codex-home>/agent-memory/plugin`, taken from the plugin installed in
`~/.claude` (or `$CLAUDE_CONFIG_DIR`), or from this checkout when no Claude install exists. They don't run
Claude's cached copy because Claude Code deletes a replaced version's directory 14 days after an update. To use
a particular hook, pass its path as the second argument.

The first run backs up `config.toml` and `hooks.json` to `*.pre-agent-memory`. Rerunning the script replaces its
own entries and keeps every other server and hook.

## 4. Verify

```sh
scripts/onboarding/hook-test.sh                  # the default profile
scripts/onboarding/hook-test.sh ~/.claude-work   # another profile; a second argument sets the test prompt
```

The test runs the installed plugin's hooks for one synthetic session, with a temporary cache directory, and
prints each hook's outcome and counts of what it would inject. It never prints memory content:

```text
/Users/you/.claude: agent-memory@agent-memory 5fdfffed67e7
SessionStart: injected, 3712 chars, orientation=5 memories=4 topics=0
UserPromptSubmit: injected, 1650 chars, orientation=0 memories=2 topics=1
```

It exits non-zero unless both hooks got a healthy answer:

| Outcome                                       | Meaning                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `injected`, `empty`, `deduped`, `over_budget` | The server answered. `empty` is normal for a new server or a prompt that matches nothing. |
| `skipped`, `disabled`                         | The hook chose not to ask, for example because recall is set to off.                      |
| `unconfigured (<reason>)`                     | The env file is missing, or has no valid URL or token. Fix it, or provision again.        |
| `http_401`, `http_403`                        | The server refused the credential. Ask the admin to rotate it or check the user's role.   |
| `timeout`, `error`, `hook_timeout`            | The URL is wrong, or the server is unreachable from this machine.                         |
| `no_diagnostics`                              | The install predates the plugin's diagnostics log. Update it ([below](#5-update)).        |

In a session, `/mcp` should list `agent-memory` as connected. Every real session start and recall is logged too;
summarize the log with `node <plugin root>/bin/diagnostics.mjs`
([claude-plugin/README.md › Diagnostics](../claude-plugin/README.md#diagnostics)).

## 5. Update

The plugin has no fixed version number. Claude Code versions it by this repository's commit, so every commit to
`main` is a new plugin version, and an update brings an install to the current `main`. Third-party marketplaces
do not auto-update by default, so update each profile yourself:

```sh
claude plugin marketplace update agent-memory && claude plugin update agent-memory@agent-memory
# for another profile: prefix both commands with CLAUDE_CONFIG_DIR=<config dir>, or rerun install-claude-profile.sh
```

Or turn on auto-update for the `agent-memory` marketplace in `/plugin`. Either way the new version loads in new
sessions: `/reload-plugins` reloads the version a running session started with.

After updating the Claude plugin, rerun `install-codex.sh` to move Codex to the same code.

`claude plugin list` shows the installed version, a 12-character commit of this repository. To check whether an
install includes a given fix, run this in a checkout:

```sh
git merge-base --is-ancestor <fix commit> <installed version> && echo included
```

## 6. Roll back or uninstall

To roll back, pin the marketplace to a known-good tag or full commit SHA. Removing the marketplace also uninstalls
its plugin:

```sh
claude plugin marketplace remove agent-memory
claude plugin marketplace add HarperFast/agent-memory#<tag or full commit sha>
claude plugin install agent-memory@agent-memory --scope user
```

A pinned marketplace stays on that ref through updates. To follow `main` again, remove it and add
`HarperFast/agent-memory` without a ref. For Codex, rerun `install-codex.sh` after the Claude rollback.

To uninstall from a Claude profile:

```sh
claude plugin uninstall agent-memory@agent-memory
claude plugin marketplace remove agent-memory
```

Then delete `AGENT_MEMORY_URL` and `AGENT_MEMORY_ENV_FILE` from the profile's `settings.json` `env` block.

To uninstall from Codex, restore `config.toml.pre-agent-memory` and `hooks.json.pre-agent-memory`, or delete these
by hand:

- the `[mcp_servers.agent-memory]` block and the `[hooks.state."…hooks.json:…"]` blocks for its hooks in
  `config.toml`
- the agent-memory hooks in `hooks.json`
- `<codex-home>/agent-memory`

Finally, delete `~/.config/agent-memory/env`. An admin can deactivate the user on the cluster.
