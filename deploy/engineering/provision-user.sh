#!/usr/bin/env bash
# Create (or rotate) a Harper user for the engineering agent-memory cluster and write that user's
# credentials straight into an agent-memory env file. The password is generated here, sent to the
# cluster only on stdin through the container's operations socket, and never printed.
#
# Usage:
#   provision-user.sh <username> <role> <target> [--rotate]
#     role    eng | eng-agents | dispatch-worker
#     target  local            -> ~/.config/agent-memory/env on this machine
#             ssh:<user@host>  -> ~/.config/agent-memory/env on that machine
#             none             -> create the user without writing credentials anywhere
set -euo pipefail
USERNAME="${1:?username}"; ROLE="${2:?role}"; TARGET="${3:?target}"; MODE="${4:-}"
case "$ROLE" in eng|eng-agents|dispatch-worker) ;; *) echo "unknown role $ROLE" >&2; exit 2;; esac
[[ "$USERNAME" =~ ^[A-Za-z0-9._@-]{1,122}$ ]] || { echo "invalid username" >&2; exit 2; }
case "$TARGET" in local|none|ssh:?*) ;; *) echo "unknown target $TARGET" >&2; exit 2;; esac
case "$MODE" in ''|--rotate) ;; *) echo "unknown option $MODE" >&2; exit 2;; esac
HOST="${AGENT_MEMORY_DEPLOY_HOST:-hm-t4-gpu-us-west4-b}"
MATCH="${AGENT_MEMORY_CONTAINER_MATCH:-agent-memory.engineering}"
URL="${AGENT_MEMORY_URL:-https://agent-memory.engineering.harperfabric.com}"

# Checked before the cluster changes: a rotation whose credentials cannot be delivered loses the password.
case "$TARGET" in ssh:*) ssh -o ProxyJump=none "${TARGET#ssh:}" true || { echo "cannot reach ${TARGET#ssh:}" >&2; exit 1; };; esac

PASS="$(openssl rand -base64 33 | tr -d '\n/+=' | cut -c1-40)"
OP=add_user; [ "$MODE" = "--rotate" ] && OP=alter_user
BODY="$(USERNAME="$USERNAME" ROLE="$ROLE" PASS="$PASS" OP="$OP" node -e '
const e=process.env;
process.stdout.write(JSON.stringify({operation:e.OP, username:e.USERNAME, password:e.PASS, role:e.ROLE, active:true}));')"

RESULT="$(printf '%s' "$BODY" | ssh -o ProxyJump=none "root@$HOST" \
  "C=\$(docker ps --format '{{.Names}}' | grep -F $(printf %q "$MATCH") | head -1); \
  [ -n \"\$C\" ] || { echo 'no running agent-memory container' >&2; exit 1; }; \
  docker exec -i \"\$C\" curl -sS --unix-socket /home/harperdb/harper/operations-server http://localhost -H content-type:application/json -d @-")"
# The SSH session banner can precede the response; the operation's JSON is the last line.
RESULT="$RESULT" node -e 'const r=JSON.parse(process.env.RESULT.trim().split("\n").pop()); if (r.error) { console.error("cluster refused:", JSON.stringify(r)); process.exit(1); }'
echo "user $USERNAME ($ROLE): ${OP} ok"

[ "$TARGET" = none ] && exit 0
TOKEN="Basic $(printf '%s:%s' "$USERNAME" "$PASS" | base64 | tr -d '\n')"
ENV_CONTENT="AGENT_MEMORY_URL=$URL
AGENT_MEMORY_TOKEN=$TOKEN
AGENT_MEMORY_USER=$USERNAME"
WRITE='umask 077; mkdir -p ~/.config/agent-memory; cat > ~/.config/agent-memory/env; chmod 600 ~/.config/agent-memory/env'
if [ "$TARGET" = local ]; then printf '%s\n' "$ENV_CONTENT" | bash -c "$WRITE"
else printf '%s\n' "$ENV_CONTENT" | ssh -o ProxyJump=none "${TARGET#ssh:}" "$WRITE"; fi
echo "credentials written to ~/.config/agent-memory/env on $TARGET"
