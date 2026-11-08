#!/usr/bin/env bash
# Upload chat messages to the live app's chat history (no redeploy). Usage: ./push-messages.sh path/to/messages.json
# The file: { "chats": [{ id, name, kind: "group"|"direct", team?, bot?, participants?, messages: [{ id?, at, from, role, text }] }] }
# Sends in small batches (a request body is limited), and replaces any value of the app's own secrets in the text
# with [redacted] before anything leaves the machine. Reads ADMIN_KEY and CC_URL from the private env file; never prints them.
set -euo pipefail
ENV_FILE="${CC_ENV_FILE:-$HOME/.secrets/control-center.env}"
source "$ENV_FILE"
SRC="${1:?usage: push-messages.sh messages.json}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# the python step below reads these (and the files in ~/.secrets/cc) only to redact them from the text
export SESSION_SECRET="${SESSION_SECRET:-}" CONTROL_ACCESS_TOKEN="${CONTROL_ACCESS_TOKEN:-}" ADMIN_KEY="${ADMIN_KEY:-}" VERCEL_BYPASS="${VERCEL_BYPASS:-}"
# redact + split into batch files of at most ~400 messages / ~1.5 MB each
CC_SECRETS_DIR="${CC_SECRETS_DIR:-$HOME/.secrets/cc}" python3 - "$SRC" "$TMP" <<'PY'
import json, os, sys
src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src))
assert isinstance(d.get("chats"), list), "need chats[]"
secrets = []
sd = os.environ.get("CC_SECRETS_DIR", "")
for name in ("SESSION_SECRET", "CONTROL_ACCESS_TOKEN", "ADMIN_KEY"):
    for v in (os.environ.get(name, ""), open(os.path.join(sd, name)).read().strip() if sd and os.path.exists(os.path.join(sd, name)) else ""):
        if v and len(v) >= 8: secrets.append(v)
for k in ("VERCEL_BYPASS",):
    v = os.environ.get(k, "")
    if v and len(v) >= 8: secrets.append(v)
def red(t):
    for s in secrets: t = t.replace(s, "[redacted]")
    return t
batches, cur, size, n = [], [], 0, 0
for c in d["chats"]:
    msgs = c.get("messages") or []
    for m in msgs:
        if isinstance(m.get("text"), str): m["text"] = red(m["text"])
    for i in range(0, max(1, len(msgs)), 400):
        part = dict(c, messages=msgs[i:i + 400])
        b = len(json.dumps(part))
        if cur and (size + b > 1_500_000 or n + len(part["messages"]) > 400):
            batches.append(cur); cur, size, n = [], 0, 0
        cur.append(part); size += b; n += len(part["messages"])
if cur: batches.append(cur)
for i, b in enumerate(batches):
    json.dump({"chats": b}, open(os.path.join(out, "batch-%04d.json" % i), "w"))
print("push-messages: %d chats, %d batches" % (len(d["chats"]), len(batches)))
PY
# Optional VERCEL_BYPASS (SKILL section 10.1): only when the user turned on Vercel Authentication.
BYPASS=(); [ -n "${VERCEL_BYPASS:-}" ] && BYPASS=(-H "x-vercel-protection-bypass: $VERCEL_BYPASS")
ok=1
for f in "$TMP"/batch-*.json; do
  [ -e "$f" ] || continue
  code=$(curl -sS -o "$TMP/out" -w '%{http_code}' -X POST "$CC_URL/api/admin/messages" ${BYPASS[@]+"${BYPASS[@]}"} \
    -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' --data-binary "@$f")
  echo "push-messages: $(basename "$f") HTTP $code $(cat "$TMP/out")"
  [ "$code" = 200 ] || ok=0
done
[ "$ok" = 1 ]
