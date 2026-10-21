# Engineering deployment

Harper engineering's shared agent memory runs as `agent-memory-app` on the two-node
`agent-memory.engineering.harperfabric.com` cluster. Both nodes sit on GPU Fabric hosts, so
host-manager injects the host's local vLLM as `models.embedding.default` (nomic-embed-text-v1.5) and
`models.generative.default`.

- `deploy.sh`: packs the plugin from this checkout and runs a replicated `deploy_component` through
  the operations socket inside one node's container. Access is the SSH key only.
- `provision-user.sh <username> <role> <local|ssh:user@host|none> [--rotate]`: creates a Harper user
  and writes its credentials to that machine's `~/.config/agent-memory/env` (mode 0600). The
  password is never printed.

Root config set once per node (not part of the app): `mcp.application.mountPath: /mcp`.

Roles and their `ScopeGrant` rows:

| Role | Who | Read | Write |
| --- | --- | --- | --- |
| `eng` | engineers | `global`, `customer:*` | `global`, `customer:*` |
| `eng-agents` | interactive agents | `global`, `customer:*` | `global`, `customer:*` |
| `dispatch-worker` | fleet workers (separate users) | `global` | `global` |
