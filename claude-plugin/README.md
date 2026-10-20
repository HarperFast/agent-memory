# `@harperfast/agent-memory` Claude Code Plugin

Integrates Harper `agent-memory` with Claude Code via remote HTTP MCP (`/mcp`), automatic session bootstrap (`SessionStart`), budgeted per-prompt recall (`UserPromptSubmit`), and live change notices (`/MemoryEvents`).

## Installation

Add the `HarperFast/agent-memory` marketplace and install the plugin:

```text
/plugin marketplace add HarperFast/agent-memory
/plugin install agent-memory --marketplace HarperFast/agent-memory
```

## Server Requirement

Enable the MCP adapter on your Harper `agent-memory` application (`config.yaml`):

```yaml
'@harperfast/agent-memory':
  package: '@harperfast/agent-memory'
  mcp: true
```

## Environment Configuration

Configure your Harper endpoint and user-bound credential:

1. Export `AGENT_MEMORY_URL` in your shell or Claude Code `settings.json` `env` block so `.mcp.json` can expand `${AGENT_MEMORY_URL}/mcp`:
   ```bash
   export AGENT_MEMORY_URL="https://memory.example.com:9926"
   ```
2. Set `AGENT_MEMORY_TOKEN` in `~/.config/agent-memory/env` (`chmod 600 ~/.config/agent-memory/env`) or in your environment:
   ```bash
   AGENT_MEMORY_URL="https://memory.example.com:9926"
   AGENT_MEMORY_TOKEN="your-harper-token-or-Basic-credential"
   ```
   Using `~/.config/agent-memory/env` for `AGENT_MEMORY_TOKEN` lets `bin/headers.mjs` (`headersHelper`) and the lifecycle hooks authenticate requests without exposing `AGENT_MEMORY_TOKEN` in subshells spawned by Claude's `Bash` tool.

### Optional Environment Variables

- `AGENT_MEMORY_BOOTSTRAP_BUDGET`: character budget for `SessionStart` bootstrap injection (default `4000`).
- `AGENT_MEMORY_BOOTSTRAP_TIMEOUT_MS`: timeout in ms for `SessionStart` bootstrap request (default `3000`).
- `AGENT_MEMORY_RECALL_BUDGET`: character budget for `UserPromptSubmit` recall injection (default `2000`).
- `AGENT_MEMORY_RECALL_TIMEOUT_MS`: hard timeout in ms for `UserPromptSubmit` recall request (default `1500`).
- `AGENT_MEMORY_RECALL_LIMIT`: maximum memories fetched per prompt (default `5`, max `50`).
- `AGENT_MEMORY_RECALL=off`: disable per-prompt `UserPromptSubmit` recall (prompts are otherwise truncated to `1000` characters and sent as `GET /Memory/?q=<prompt>`, which may appear in server/proxy access logs and be sent to the server's embedding provider).
- `AGENT_MEMORY_DISABLE_FOLLOWER=1`: disable the per-session detached `/MemoryEvents` SSE follower.

## Memory Routing

- **Send to `agent-memory` (MCP tools: `remember`, `revise`, `recall`, `get`, `withdraw`, `pin`, `unpin`, `confirm`, `watch`)**: team-relevant findings, architectural decisions, domain invariants, and shared engineering lessons.
- **Keep in Claude's native file memory (`~/.claude/projects/.../memory/`)**: machine-specific file paths, local worktree/harness state, and personal workflow preferences.
- **Single-home rule**: never write the same fact to both stores.
