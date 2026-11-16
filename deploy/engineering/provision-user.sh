#!/usr/bin/env bash
# Create (or rotate) a Harper user for the engineering agent-memory cluster and write that user's
# credentials straight into an agent-memory env file. The password is generated here, sent to the
# cluster only on stdin through the container's operations socket, and never printed.
#
# Usage:
#   AGENT_MEMORY_DEPLOY_HOST=<ssh host> AGENT_MEMORY_CONTAINER_MATCH=<container name substring> \
#   AGENT_MEMORY_URL=<cluster base URL> provision-user.sh <username> <role> <target> [--rotate] [--acts-for <user>]
#     role    eng | eng-agents | dispatch-worker
#     target  local            -> ~/.config/agent-memory/env on this machine
#             ssh:<user@host>  -> ~/.config/agent-memory/env on that machine
#             none             -> create the user without writing credentials anywhere
#     --acts-for  upsert actsFor onto the user's ScopeGrant row "user:<username>", so this agent user acts for
#                 that user (DESIGN.md Identity › Delegation). The upsert keeps any read/write the row has.
#   The cluster is never defaulted (this repo is public). AGENT_MEMORY_URL is the base URL written into the
#   credentials file, so it is only needed when target is not none.
set -euo pipefail
USERNAME="${1:?username}"; ROLE="${2:?role}"; TARGET="${3:?target}"; shift 3
MODE=""; ACTS_FOR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rotate) MODE=--rotate; shift;;
    --acts-for) ACTS_FOR="${2:?--acts-for needs a username}"; shift 2;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
case "$ROLE" in eng|eng-agents|dispatch-worker) ;; *) echo "unknown role $ROLE" >&2; exit 2;; esac
[[ "$USERNAME" =~ ^[A-Za-z0-9._@-]{1,122}$ ]] || { echo "invalid username" >&2; exit 2; }
case "$TARGET" in local|none|ssh:?*) ;; *) echo "unknown target $TARGET" >&2; exit 2;; esac
[ -z "$ACTS_FOR" ] || [[ "$ACTS_FOR" =~ ^[A-Za-z0-9._@-]{1,122}$ && "$ACTS_FOR" != "$USERNAME" ]] || { echo "invalid --acts-for" >&2; exit 2; }
HOST="${AGENT_MEMORY_DEPLOY_HOST:?set AGENT_MEMORY_DEPLOY_HOST to the SSH host of one cluster node}"
MATCH="${AGENT_MEMORY_CONTAINER_MATCH:?set AGENT_MEMORY_CONTAINER_MATCH to a substring of the container name}"
[ "$TARGET" = none ] || : "${AGENT_MEMORY_URL:?set AGENT_MEMORY_URL to the cluster base URL, or use target none}"
URL="${AGENT_MEMORY_URL:-}"

# Checked before the cluster changes: a rotation whose credentials cannot be delivered loses the password.
case "$TARGET" in ssh:*) ssh -o ProxyJump=none "${TARGET#ssh:}" true || { echo "cannot reach ${TARGET#ssh:}" >&2; exit 1; };; esac

PASS="$(openssl rand -base64 33 | tr -d '\n/+=' | cut -c1-40)"
OP=add_user; [ "$MODE" = "--rotate" ] && OP=alter_user
BODY="$(USERNAME="$USERNAME" ROLE="$ROLE" PASS="$PASS" OP="$OP" node -e '
const e=process.env;
process.stdout.write(JSON.stringify({operation:e.OP, username:e.USERNAME, password:e.PASS, role:e.ROLE, active:true}));')"

QMATCH="$(printf %q "$MATCH")"
# Sends one operation (JSON on stdin) through the operations socket of the one matching container.
operation() {
  local result
  result="$(ssh -o ProxyJump=none "root@$HOST" \
    "C=\$(docker ps --format '{{.Names}}' | grep -F -- $QMATCH); \
    [ \"\$(printf '%s\\n' \"\$C\" | grep -c .)\" = 1 ] || { echo need exactly one running container matching $QMATCH, got: \$C >&2; exit 1; }; \
    docker exec -i \"\$C\" curl -sS --unix-socket /home/harperdb/harper/operations-server http://localhost -H content-type:application/json -d @-")"
  # The SSH session banner can precede the response; the operation's JSON is the last line.
  RESULT="$result" node -e 'const r=JSON.parse(process.env.RESULT.trim().split("\n").pop()); if (r.error) { console.error("cluster refused:", JSON.stringify(r)); process.exit(1); }'
}
printf '%s' "$BODY" | operation
echo "user $USERNAME ($ROLE): ${OP} ok"

if [ "$TARGET" != none ]; then
  TOKEN="Basic $(printf '%s:%s' "$USERNAME" "$PASS" | base64 | tr -d '\n')"
  ENV_CONTENT="AGENT_MEMORY_URL=$URL
AGENT_MEMORY_TOKEN=$TOKEN
AGENT_MEMORY_USER=$USERNAME"
  WRITE='umask 077; mkdir -p ~/.config/agent-memory; cat > ~/.config/agent-memory/env; chmod 600 ~/.config/agent-memory/env'
  if [ "$TARGET" = local ]; then printf '%s\n' "$ENV_CONTENT" | bash -c "$WRITE"
  else printf '%s\n' "$ENV_CONTENT" | ssh -o ProxyJump=none "${TARGET#ssh:}" "$WRITE"; fi
  echo "credentials written to ~/.config/agent-memory/env on $TARGET"
fi

# After the credentials are delivered: a failure here leaves a working user, never a lost password.
if [ -n "$ACTS_FOR" ]; then
  USERNAME="$USERNAME" ACTS_FOR="$ACTS_FOR" node -e '
const e=process.env;
process.stdout.write(JSON.stringify({operation:"upsert", database:"memory", table:"ScopeGrant",
  records:[{id:"user:"+e.USERNAME, actsFor:e.ACTS_FOR}]}));' | operation
  echo "user $USERNAME acts for $ACTS_FOR"
fi
