# Engineering deployment

Harper engineering's shared agent memory runs as `agent-memory-app` on a two-node Fabric cluster. Both nodes sit
on GPU Fabric hosts, so host-manager injects the host's local vLLM as `models.embedding.default`
(nomic-embed-text-v1.5) and `models.generative.default`.

## Deploying

Hosts, container names and URLs are never committed (the repo is public); every script takes them from the
environment and refuses to run without them:

```bash
export AGENT_MEMORY_DEPLOY_HOST=<ssh host of one node>       # root, SSH key only
export AGENT_MEMORY_CONTAINER_MATCH=<substring of that node's container name>
deploy/deploy.sh deploy/engineering
```

- Needs Harper 5.3.1 or later; embedding truncation needs 5.4 ([below](#embedding-truncation)).
- [`../deploy.sh`](../deploy.sh): packs the plugin from this checkout, vendors it into this app, and runs a
  replicated `deploy_component` for the project named in this `package.json` through the operations socket inside
  one node's container.
- `provision-user.sh <username> <role> <local|ssh:user@host|none> [--rotate]`: creates a Harper user and writes
  its credentials to that machine's `~/.config/agent-memory/env` (mode 0600). The password is never printed. It
  reads the same two variables, plus `AGENT_MEMORY_URL` (the cluster's base URL) unless the target is `none`.

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
`default`. vLLM does the cut only when each node's `models.embedding.default` entry carries `truncation: 'vllm'`,
which host-manager writes into the root config. Without it, or on Harper 5.3, writes and searches still work: the
plugin embeds the first 4,000 characters (`limits.embeddingFallbackChars`, the plugin default and this deployment's
pre-truncation bound) and logs one warning per worker thread naming the model. After `truncation` appears, the
plugin picks it up within 5 minutes, without a restart. For vLLM to cut:

1. Both nodes run Harper 5.4 or later (5.3 ignores `truncate`).
2. Both nodes' root config shows `truncation: 'vllm'` on `models.embedding.default`, and the host's vLLM is 0.18
   or later (`hm.vllmVersion`; host-manager defaults to 0.21). Older vLLM ignores `truncation_side: 'right'` and
   can keep the end of a long input instead of its start and prefix.

Rollback is one deploy with `embeddingTruncate: false` and `embeddingInputChars: 4000` together: turning truncation
off alone sends 12,000 characters, which overflow nomic's window.
