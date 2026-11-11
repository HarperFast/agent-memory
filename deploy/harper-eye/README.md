# harper-eye deployment

agent-memory as its own app (project `agent-memory-harper-eye`, the `name` in this `package.json`) on the cluster
that hosts the harper-eye app ("Eye"), so the plugin upgrades separately from Eye. Modeled on
[`../engineering`](../engineering/README.md): the same `nomic-prefixed` backend in `resources.js`, with the
differences below.

The only option that differs is `lockScope: node`: this cluster has no `replication.recordLocks`, and `cluster`
would answer every lifecycle write with 503. Across nodes, two revisions at one revision can both succeed
([DESIGN.md](../../DESIGN.md#lifecycle)). Truncation is on with the plugin's 4,000-character fallback
(`limits.embeddingFallbackChars`), MCP is on, and supersession is `suggest`.

## Deploying

Hosts and container names are never committed (the repo is public); the script takes them from the environment
and refuses to run without them:

```bash
export AGENT_MEMORY_DEPLOY_HOST=<ssh host of one node>       # root, SSH key only
export AGENT_MEMORY_CONTAINER_MATCH=<substring matching exactly one container name on that host>
deploy/deploy.sh deploy/harper-eye
```

[`../deploy.sh`](../deploy.sh) packs the plugin from this checkout, vendors it into this app and runs a replicated
`deploy_component` through the operations socket inside one node's container.

## Prerequisites

- Harper 5.4 or later for embedding truncation. On 5.3 `truncate` is ignored: writes and searches still work, and
  the plugin embeds the first 4,000 characters (`limits.embeddingFallbackChars`) and logs one warning per worker
  thread naming the model.
- For the model to cut, each node's `models.embedding.default` entry must be able to truncate (vLLM: `truncation:
'vllm'` on the entry, vLLM 0.18 or later). Without it the same fallback applies, and the plugin picks the entry up
  within 5 minutes of `truncation` appearing, without a restart.
- `models.embedding.default` is nomic-embed-text-v1.5. `resources.js` adds its task prefixes; a different model
  or different prefixes make new vectors incomparable with stored ones.
- Rollback of truncation is one deploy with `embeddingTruncate: false` and `embeddingInputChars: 4000` together.

## Switching over from Eye's in-app plugin

Run exactly one copy of the plugin. A second app listing it fails to load, and which one loads first can differ
from worker to worker. Deploy this app together with the Eye PR that removes Eye's in-app plugin entry:

1. Before: Eye's own dependency on `@harperfast/agent-memory` is 0.1.4 or later and deployed, so its package
   functions keep reaching the plugin once it runs as a separate app ([From another app](../../README.md#from-another-app)).
2. Before: compare this `config.yaml`'s plugin options with those Eye's `config.yaml` sets for the plugin now,
   and differ only on purpose. Also check that Eye's registered backend for that `embeddingModel` adds the same
   prefixes as `resources.js`; a mismatch ranks searches worse and logs nothing.
3. Deploy Eye with the plugin entry removed.
4. Immediately run `deploy/deploy.sh deploy/harper-eye`. Memory calls fail between 3 and 4.
5. Search and write one memory through each node.

To roll back, drop the `agent-memory-harper-eye` project (`drop_component`, replicated) first, then redeploy the
previous Eye build.
