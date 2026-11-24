# Engineering deployment

Harper engineering's shared agent memory runs as `agent-memory-app` on a two-node Fabric cluster. Both nodes sit
on GPU Fabric hosts, so host-manager injects the host's local vLLM as `models.embedding.default`
(nomic-embed-text-v1.5) and `models.generative.default`.

## Deploying

Hosts, container names and URLs are never committed (the repo is public); every script takes them from the
environment and refuses to run without them:

```bash
export AGENT_MEMORY_DEPLOY_HOST=<ssh host of one node>       # root, SSH key only
export AGENT_MEMORY_CONTAINER_MATCH=<substring matching exactly one container name on that host>
deploy/deploy.sh deploy/engineering
```

- Needs Harper 5.3.1 or later; embedding truncation needs 5.4 ([below](#embedding-truncation)).
- [`../deploy.sh`](../deploy.sh): packs the plugin from this checkout, vendors it into this app (with this
  directory's `config.yaml`, `package.json`, `*.js` and `*.graphql`), and runs a replicated `deploy_component` for
  the project named in this `package.json` through the operations socket inside one node's container.
- `provision-user.sh <username> <role> <local|ssh:user@host|file:path|none> [--rotate] [--acts-for <user>]`: the
  admin route. It creates a Harper user and writes its credentials to that machine's `~/.config/agent-memory/env`,
  or to `file:<path>` on this machine (mode 0600). `--acts-for` then sets the user's `actsFor`; it refuses a user
  that does not exist and a pair of different customer clearance. The password is never printed. It
  reads the same two variables, plus `AGENT_MEMORY_URL` (the cluster's base URL) unless the target is `none`.
  Engineers normally get credentials themselves ([Self-serve provisioning](#self-serve-provisioning)).

Root config set once per node (not part of the app): `mcp.application.mountPath: /mcp`, and
`authentication.authorizeLocal: false` (the node sits behind a local TLS proxy, so loopback requests
would otherwise be treated as `super_user`).

Roles and their `ScopeGrant` rows:

| Role              | Who                                                                | Read                   | Write                  |
| ----------------- | ------------------------------------------------------------------ | ---------------------- | ---------------------- |
| `eng`             | engineers                                                          | `global`, `customer:*` | `global`, `customer:*` |
| `eng-public`      | agents on individual AI plans; public-only, no `customer:*` access | `global`               | `global`               |
| `eng-agents`      | interactive agents                                                 | `global`, `customer:*` | `global`, `customer:*` |
| `dispatch-worker` | fleet workers (separate users)                                     | `global`               | `global`               |
| `provisioner`     | Dispatch, issuing engineers' credentials (one user)                | none                   | none                   |

Every user also reads and writes its own `user:<self>` (and a delegate its principal's). `eng-public` sees what
`dispatch-worker` sees: never a `customer:*` memory, and no `global` memory flagged as possible customer detail.
Customer detail that the content check did not flag, or that predates it, is visible in `global` to every reader,
`eng-public` included. The `provisioner` has no `ScopeGrant` row.

An engineer's agent users act for the engineer's own user through `actsFor` on the agent user's own `ScopeGrant`
row (`{ "id": "user:<agent user>", "actsFor": "<engineer user>" }`), so they can correct the engineer's memories and
share `user:<engineer>`. The `eng-agents` role grants their labels, so that row carries only `actsFor`.
`provision-user.sh <agent user> eng-agents <target> --acts-for <engineer user>` upserts it after creating the
user; to revoke, upsert `actsFor: null`. Never put `actsFor` on a `role:` row: it grants nothing there.

A delegation group shares one private scope, so it never mixes customer clearance (`eng` and `eng-agents` are
cleared; `eng-public`, `dispatch-worker` and `provisioner` are not): a cleared member could write customer detail
there for an uncleared member to read, since private memories are never content-checked. The self-serve resource
gives a machine of the other role no `actsFor`, and `provision-user.sh --acts-for` refuses such a pair (leave
`--acts-for` off for a standalone user). Three admin actions can still leave an `eng-public` user reading customer
content, so take care with them:

- Changing a person's role, most often `eng-public` to `eng` when they move to a company plan: their machine users
  keep `actsFor`. Clear it (`actsFor: null`) on each machine user whose role now differs, or change those roles
  too. `GET /Provision/<email>` shows each machine user's role and `actsFor`.
- Changing a user's role to `eng-public`: the user keeps reading what it owns, customer memories included, and
  withdrawing them does not stop an owner reading them. Create a fresh user instead.
- Dropping a user: its memories and any `actsFor` naming it stay, and a later user of the same name inherits both.
  Drop its machine users with it (self-serve refuses to recreate a name that something still acts for), and delete
  its `memory.ProvisionedUser` rows, or self-serve could rotate a later user of that name.

## Self-serve provisioning

Engineers get credentials from Dispatch's Connect agent-memory page (shipped separately in Dispatch; until it is
live, the admin route above stays the only one), which calls this app's `Provision` resource as
the `provisioner` user ([`provision.js`](provision.js), rules in [DESIGN.md](DESIGN.md)). The username is the person's
company email, with role `eng` or `eng-public`. Each machine can get its own user `<email>.<machine>`. With the
person's role it acts for the person (`actsFor`: it corrects the person's memories and shares their private ones).
With the other role, for example an `eng` person's machine on an individual AI plan, it is a standalone user: it
does not share or edit the person's private memories.

| Request                                                                           | Answer                                                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /Provision/<email>`                                                          | `200 { exists, managed, role, delegates: [{ username, role, actsFor }] }`                       |
| `POST /Provision/` `{ "action": "create", "principal": <email>, "role": <role> }` | `201 { username, password }`                                                                    |
| `POST /Provision/` `{ "action": "addDelegate", "principal", "machine", "role" }`  | `201 { username, password, actsFor }`; `actsFor` is false when `role` differs from the person's |
| `POST /Provision/` `{ "action": "rotate", "username": <managed user> }`           | `200 { username, password }`; every machine using the old password must take the new one        |

- **Who may call.** Only role `provisioner` (or a `super_user`): 401 without credentials, 403 for every other role.
  `HEAD` is answered as `GET`, Harper answers `OPTIONS` itself, and every other method or stream gets 405. The
  resource is hidden from MCP and OpenAPI.
- **What it changes.** It assigns only `eng` and `eng-public`, and creates only names that do not exist. It rotates
  and adds machine users only for users it created, still active and still holding one of those roles; `managed`
  in the GET answer says exactly that. A rotate writes by username, so one that lands with an admin's reset of the
  same user can overwrite it; nothing is returned for a user an admin changed mid-request. Two rotations of one user
  at once can each answer, with only the later password live, so send them one at a time.
- **Errors** are `{ error, code }`. Branch on `code`, since several share a status: `user_exists`, `in_progress`
  (another request is creating that name; retry after a minute), `grant_row_exists` and `inbound_delegation` (an
  admin must clean up first), `user_changed` (an admin changed the user mid-request; nothing was issued),
  `not_managed`, `user_inactive`, `role_not_assignable`, `too_many_delegates` (16 machines per person),
  `mixed_delegation` (an admin's role change left a machine user acting for a person of another role),
  `reserved_name`, plus 400s for malformed input. A 500 carries a `ref` that matches the server log line. A create
  or addDelegate that answered 500 after the user was made answers `user_exists` on retry; rotate recovers it. A
  same-role machine user whose `actsFor` write failed that way stays standalone until an admin sets `actsFor`.
- **Passwords** are 40 random characters, returned once, with `Cache-Control: no-store`, and never logged here.
  Nothing between Dispatch and this app may log response bodies. A rotate whose answer was lost is recovered by
  rotating again; the earlier password no longer works either way.

**Trust.** The provisioner can create a customer-cleared (`eng`) user for any new email. Dispatch decides who gets
one: it must act only for a signed-in person (not a worker token), take the email from the identity provider's
verified company address (lowercased; the resource refuses capitals), choose the role server-side, and send every
action only for that email or one of its `<email>.<machine>` names: the resource cannot tell whose request it is.

### Setup (admin, once, after the deploy)

1. Deploy this app (it ships `schema.graphql`, the `ProvisionedUser` table). Then, as `super_user` through the
   operations API, run each operation in [`roles.json`](roles.json): the `eng-public` and `provisioner` roles and
   `eng-public`'s `ScopeGrant` row. Roles replicate, so one node is enough.
2. Create the provisioner user, with the credential written to a local file instead of a machine's env file:
   `provision-user.sh dispatch-provisioner provisioner file:./provisioner.env`.
3. Give Dispatch the file's `AGENT_MEMORY_URL` and `AGENT_MEMORY_TOKEN` as secrets, then delete the file. Rotate the
   same way with `--rotate`.
4. Check on both nodes: a test create, a rotate (the old password gets 401 on both), and an `eng-public` user that
   cannot read a `customer:` memory.

To stop self-serve, deactivate the provisioner (`alter_user` with `active: false`): every call then answers 401, and
already-issued credentials keep working.

To let an engineer whose user an admin made self-serve (create answers 409 and `managed` is false), adopt it once
its role is `eng` or `eng-public` and its `user:` `ScopeGrant` row carries no grants. To adopt, upsert
`{ "username": <email>, "principal": <email>, "machine": null }` into `memory.ProvisionedUser`.

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
