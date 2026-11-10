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

Root config set once per node (not part of the app): `mcp.application.mountPath: /mcp`, and
`authentication.authorizeLocal: false` (the node sits behind a local TLS proxy, so loopback requests
would otherwise be treated as `super_user`).

Roles and their `ScopeGrant` rows:

| Role              | Who                            | Read                   | Write                  |
| ----------------- | ------------------------------ | ---------------------- | ---------------------- |
| `eng`             | engineers                      | `global`, `customer:*` | `global`, `customer:*` |
| `eng-agents`      | interactive agents             | `global`, `customer:*` | `global`, `customer:*` |
| `dispatch-worker` | fleet workers (separate users) | `global`               | `global`               |

## Embedding truncation

`config.yaml` sets `embeddingTruncate: true` and `limits.embeddingInputChars: 12000`: vLLM cuts each input at
nomic's 2,048 tokens. `resources.js`'s `nomic-prefixed` backend adds the task prefix and passes `truncate` on to
`default`. That works only when each node's `models.embedding.default` entry carries `truncation: 'vllm'`, which
host-manager writes into the root config; without it every embedding is refused, so writes fail and search serves
full-text only. Before running `deploy.sh` with this config:

1. Both nodes run Harper 5.4 or later (5.3 ignores `truncate`; with the 12,000 cap, long prose would then fail).
2. Both nodes' root config shows `truncation: 'vllm'` on `models.embedding.default`, and the host's vLLM is 0.18
   or later (`hm.vllmVersion`; host-manager defaults to 0.21). Older vLLM ignores `truncation_side: 'right'` and
   can keep the end of a long input instead of its start and prefix.

Rollback is one deploy with `embeddingTruncate: false` and `embeddingInputChars: 4000` together, before removing
`truncation` from the root config or moving a node back to 5.3.
