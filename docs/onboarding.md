# Onboarding: agent-memory in Claude Code and Codex

This guide takes an engineer from nothing to Claude Code (and optionally Codex) sessions that bootstrap from,
recall from and write to a team's agent-memory server. It covers each step in order: get credentials, install
into each Claude profile, add Codex, verify, then update, roll back or uninstall.

You need Node.js 22 or later and the `claude` CLI on `PATH`, plus a clone of this repository, where the scripts
live:

```sh
git clone https://github.com/HarperFast/agent-memory.git && cd agent-memory
```

Every script reads the server's URL and your credential from `~/.config/agent-memory/env`. Set
`AGENT_MEMORY_ENV_FILE` to use another path. No script takes a host, URL or password as an argument, and none
prints the token.

## 1. Get credentials

### Self-serve (Dispatch)

Open Dispatch's **Connect agent-memory** page and sign in with GitHub. (If your Dispatch has no such page yet, use
the admin route below.) Your username is your verified company email. Your role is one of two:

- `eng` if your agents run on a company AI plan. Reads and writes `global` and `customer:*` memories.
- `eng-public` if they run on an individual (non-company) AI plan. Public only: it never receives a `customer:*`
  memory, nor a `global` one flagged as possible customer detail. Like every `global` reader, it still sees customer
  detail that someone put in `global` and the check missed, so keep customer detail under `customer:` labels.

The page shows your password once, as the contents of the credential file. Save it as `~/.config/agent-memory/env`,
readable only by you (`chmod 600`):

```sh
AGENT_MEMORY_URL=https://memory.example.com
AGENT_MEMORY_TOKEN=Basic <base64 user:password>
AGENT_MEMORY_USER=<username>
```

Give each machine its own credential: **add a machine** with a label (lowercase letters, digits and `-`, up to 32).
That creates `<email>.<label>`, which can be rotated without touching your other machines. A machine with your role
acts for you: it can correct your memories and shares your private ones. A machine with the other role, such as an
`eng-public` machine for an `eng` person, is a standalone user: it does not share or edit your private memories, so
customer detail you keep there never reaches an individual-plan agent.

**Rotate** issues a new password for your user or one machine. The old password stops working at once, so every
machine using it is logged out (401) until it gets the new file. Then rerun `install-codex.sh` on any machine with
Codex, which keeps its own copy of the credential. Claude profiles read the env file directly and need nothing.

If the page says your user exists but self-serve does not manage it, an admin created it before. Ask an admin to
adopt it ([`deploy/engineering/README.md`](../deploy/engineering/README.md#self-serve-provisioning)), or to rotate
it for you with the admin route below.

### Admin route (`provision-user.sh`)

An admin with SSH access to a cluster node can create any user with
[`deploy/engineering/provision-user.sh`](../deploy/engineering/provision-user.sh). The script generates a
password, sends it to the cluster on stdin, and writes the credential file straight onto the target machine with
mode 0600. The password is never printed. The cluster comes from the environment, never from the repository
([`deploy/engineering/README.md`](../deploy/engineering/README.md)):

```sh
export AGENT_MEMORY_DEPLOY_HOST=<ssh host of one node>
export AGENT_MEMORY_CONTAINER_MATCH=<substring of the agent-memory container name>
export AGENT_MEMORY_URL=<cluster base URL>

# The person: role eng, or eng-public for agents on an individual AI plan.
deploy/engineering/provision-user.sh <person> eng <target>

# Their agents: role eng-agents (eng-public for an eng-public person), acting for the person, so the agents can
# correct the person's memories and share user:<person>.
deploy/engineering/provision-user.sh <person>-agents eng-agents <target> --acts-for <person>
```

`<target>` is where the credentials go:

- `local` writes this machine's `~/.config/agent-memory/env`.
- `ssh:<user@host>` writes the file on that machine.
- `file:<path>` writes that file on this machine, for a credential that goes on to another system.
- `none` creates the user without writing credentials anywhere. Rerun with `--rotate` later to issue some.

`--acts-for` refuses to pair `eng-public` with any other role: the pair would share one private scope, and private
memories are never checked for customer detail. Leave `--acts-for` off to make such a machine user standalone.

A machine has one env file, so its sessions act as whoever's credentials are in it. On a machine where Claude
Code or Codex works on someone's behalf, write the agent user's credentials there, and keep the person's own
credentials for where they authenticate themselves.

To revoke delegation, upsert `actsFor: null` on the agent user's `ScopeGrant` row. To issue a new password, rerun
with `--rotate`, then rerun `install-codex.sh` on that machine.

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
argument sets the marketplace source, for example a local checkout path or `HarperFast/agent-memory#<ref>`. It is
used only when the profile has no `agent-memory` marketplace yet: to switch an existing profile's source, remove
the marketplace first ([Roll back](#6-roll-back-or-uninstall)).

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
another copy of the plugin, pass its `hooks/hook.mjs` path as the second argument. The hook commands name the env file the MCP entry's
credential came from, so the hooks and the MCP entry use the same credential. After a password rotation, rerun
the script: the hooks read the new password from the file, but the MCP entry keeps the old one until then.

The first run backs up an existing `config.toml` and `hooks.json` to `*.pre-agent-memory`. No backup means the file
did not exist yet, or already had agent-memory in it. Rerunning the script replaces its own entries where they
stand and keeps every other server and hook.

## 4. Verify

```sh
scripts/onboarding/hook-test.sh                  # the default profile
scripts/onboarding/hook-test.sh ~/.claude-work   # another profile; a second argument sets the test prompt
```

The test runs the installed plugin's hooks for one synthetic session, with a temporary cache directory, and
prints each hook's outcome and counts of what it would inject. It never prints memory content. The hooks get the
profile's `settings.json` `env`, as they do in a session:

```text
/Users/you/.claude: agent-memory@agent-memory 5fdfffed67e7
SessionStart: injected, 3712 chars, orientation=5 memories=4 topics=0
UserPromptSubmit: injected, 1650 chars, orientation=0 memories=2 topics=1
```

It exits non-zero unless session start got an answer from the server and recall either got one or is switched off:

| Outcome                                       | Meaning                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `injected`, `empty`, `deduped`, `over_budget` | The server answered. `empty` is normal for a new server or a prompt that matches nothing. |
| `disabled` (recall)                           | Recall is switched off (`AGENT_MEMORY_RECALL=off`). Accepted.                             |
| `skipped`                                     | The hook did not ask; for recall, the test prompt had no distinctive term. Use another.   |
| `unconfigured (<reason>)`                     | The env file is missing, or has no valid URL or token. Fix it, or provision again.        |
| `http_401`, `http_403`                        | The server refused the credential. Rotate it on the Dispatch page, or ask an admin.       |
| `timeout`, `error`, `hook_timeout`            | The URL is wrong, or the server is unreachable from this machine.                         |
| `hook_failed`, `bad_output`                   | The hook process itself failed: check that `node` is version 22 or later.                 |
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
