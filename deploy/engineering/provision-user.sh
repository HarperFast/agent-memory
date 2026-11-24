#!/usr/bin/env bash
# Create (or rotate) a Harper user for the engineering agent-memory cluster and write that user's
# credentials straight into an agent-memory env file. The password is generated here, sent to the
# cluster only on stdin through the container's operations socket, and never printed.
#
# Usage:
#   AGENT_MEMORY_DEPLOY_HOST=<ssh host> AGENT_MEMORY_CONTAINER_MATCH=<container name substring> \
#   AGENT_MEMORY_URL=<cluster base URL> provision-user.sh <username> <role> <target> [--rotate] [--acts-for <user>]
#     role    eng | eng-public | eng-agents | dispatch-worker | provisioner
#     target  local            -> ~/.config/agent-memory/env on this machine
#             ssh:<user@host>  -> ~/.config/agent-memory/env on that machine
#             file:<path>      -> that file on this machine, replaced whole with mode 0600 (for a credential that
#                                 goes on to another system, such as the provisioner's)
#             none             -> create the user without writing credentials anywhere
#     --acts-for  upsert actsFor onto the user's ScopeGrant row "user:<username>", so this agent user acts for
#                 that user (DESIGN.md Identity › Delegation). The upsert keeps any read/write the row has. That user
#                 must exist, and eng-public never shares a delegation group with another role.
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
case "$ROLE" in eng|eng-public|eng-agents|dispatch-worker|provisioner) ;; *) echo "unknown role $ROLE" >&2; exit 2;; esac
[[ "$USERNAME" =~ ^[A-Za-z0-9._@-]{1,122}$ ]] || { echo "invalid username" >&2; exit 2; }
case "$TARGET" in local|none|ssh:?*|file:?*) ;; *) echo "unknown target $TARGET" >&2; exit 2;; esac
[ -z "$ACTS_FOR" ] || [[ "$ACTS_FOR" =~ ^[A-Za-z0-9._@-]{1,122}$ && "$ACTS_FOR" != "$USERNAME" ]] || { echo "invalid --acts-for" >&2; exit 2; }
HOST="${AGENT_MEMORY_DEPLOY_HOST:?set AGENT_MEMORY_DEPLOY_HOST to the SSH host of one cluster node}"
MATCH="${AGENT_MEMORY_CONTAINER_MATCH:?set AGENT_MEMORY_CONTAINER_MATCH to a substring of the container name}"
[ "$TARGET" = none ] || : "${AGENT_MEMORY_URL:?set AGENT_MEMORY_URL to the cluster base URL, or use target none}"
URL="${AGENT_MEMORY_URL:-}"

# Checked before the cluster changes: a rotation whose credentials cannot be delivered loses the password.
case "$TARGET" in
  ssh:*) ssh -o ProxyJump=none "${TARGET#ssh:}" true || { echo "cannot reach ${TARGET#ssh:}" >&2; exit 1; };;
  file:*) DEST="${TARGET#file:}"; DEST_DIR="$(dirname -- "$DEST")"
    [ -d "$DEST_DIR" ] && [ -w "$DEST_DIR" ] || { echo "cannot write to $DEST_DIR" >&2; exit 1; };;
esac

PASS="$(openssl rand -base64 33 | tr -d '\n/+=' | cut -c1-40)"
OP=add_user; [ "$MODE" = "--rotate" ] && OP=alter_user
BODY="$(USERNAME="$USERNAME" ROLE="$ROLE" PASS="$PASS" OP="$OP" node -e '
const e=process.env;
process.stdout.write(JSON.stringify({operation:e.OP, username:e.USERNAME, password:e.PASS, role:e.ROLE, active:true}));')"

QMATCH="$(printf %q "$MATCH")"
operation() {
  local result
  result="$(ssh -o ProxyJump=none "root@$HOST" \
    "C=\$(docker ps --format '{{.Names}}' | grep -F -- $QMATCH); \
    [ \"\$(printf '%s\\n' \"\$C\" | grep -c .)\" = 1 ] || { echo need exactly one running container matching $QMATCH, got: \$C >&2; exit 1; }; \
    docker exec -i \"\$C\" curl -sS --unix-socket /home/harperdb/harper/operations-server http://localhost -H content-type:application/json -d @-")"
  # The SSH session banner can precede the response; the operation's JSON is the last line.
  RESULT="$result" node -e 'const r=JSON.parse(process.env.RESULT.trim().split("\n").pop()); if (r.error) { console.error("cluster refused:", JSON.stringify(r)); process.exit(1); } process.stdout.write(JSON.stringify(r));'
}

# A delegation group shares one private scope, so a customer-cleared member would put customer detail where an
# eng-public member reads it (deploy/engineering/DESIGN.md). Checked before the cluster changes.
if [ -n "$ACTS_FOR" ]; then
  USERS="$(printf '%s' '{"operation":"list_users"}' | operation)"
  PRINCIPAL_ROLE="$(USERS="$USERS" NAME="$ACTS_FOR" node -e '
const u=JSON.parse(process.env.USERS).find((x)=>x.username===process.env.NAME); process.stdout.write(u ? String(u.role?.role ?? "") : "-");')"
  [ "$PRINCIPAL_ROLE" != - ] || { echo "--acts-for user $ACTS_FOR does not exist" >&2; exit 1; }
  if { [ "$ROLE" = eng-public ] || [ "$PRINCIPAL_ROLE" = eng-public ]; } && [ "$ROLE" != "$PRINCIPAL_ROLE" ]; then
    echo "a $ROLE user cannot act for a ${PRINCIPAL_ROLE:-roleless} user: eng-public never shares a delegation group with another role (leave --acts-for off for a standalone user)" >&2
    exit 1
  fi
fi

printf '%s' "$BODY" | operation >/dev/null
echo "user $USERNAME ($ROLE): ${OP} ok"

if [ "$TARGET" != none ]; then
  TOKEN="Basic $(printf '%s:%s' "$USERNAME" "$PASS" | base64 | tr -d '\n')"
  ENV_CONTENT="AGENT_MEMORY_URL=$URL
AGENT_MEMORY_TOKEN=$TOKEN
AGENT_MEMORY_USER=$USERNAME"
  WRITE='umask 077; mkdir -p ~/.config/agent-memory; cat > ~/.config/agent-memory/env; chmod 600 ~/.config/agent-memory/env'
  case "$TARGET" in
    local) printf '%s\n' "$ENV_CONTENT" | bash -c "$WRITE";;
    ssh:*) printf '%s\n' "$ENV_CONTENT" | ssh -o ProxyJump=none "${TARGET#ssh:}" "$WRITE";;
    # mktemp creates the file 0600, and the rename never leaves a readable partial file at the destination.
    file:*) TMP="$(mktemp "$DEST_DIR/.agent-memory-env.XXXXXX")"; printf '%s\n' "$ENV_CONTENT" >"$TMP"; mv -f -- "$TMP" "$DEST";;
  esac
  case "$TARGET" in
    file:*) echo "credentials written to $DEST";;
    *) echo "credentials written to ~/.config/agent-memory/env on $TARGET";;
  esac
fi

# After the credentials are delivered: a failure here leaves a working user, never a lost password.
if [ -n "$ACTS_FOR" ]; then
  USERNAME="$USERNAME" ACTS_FOR="$ACTS_FOR" node -e '
const e=process.env;
process.stdout.write(JSON.stringify({operation:"upsert", database:"memory", table:"ScopeGrant",
  records:[{id:"user:"+e.USERNAME, actsFor:e.ACTS_FOR}]}));' | operation >/dev/null
  echo "user $USERNAME acts for $ACTS_FOR"
fi
