# @harperfast/memory

Shared, permissioned, live memory for agents and people, as a Harper plugin.

- Scoped visibility (`global`, `user:<id>`, `customer:<id>`, `team:<id>`) with grants on Harper users and roles
- Hybrid search (vector + full-text) at commit, no indexing queue
- First-class supersession, with write-time candidate detection
- Live updates: subscriptions and watches on memories a session relied on

Status: pre-release. Design and contracts: [DESIGN.md](DESIGN.md).

```yaml
# host app config.yaml
'@harperfast/memory':
  package: '@harperfast/memory'
```
