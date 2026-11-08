#!/usr/bin/env bash
# Build the private app from the demo repo. Usage: assemble.sh <demo-repo-dir> <target-dir> <IANA-timezone>
# Result: <target-dir> with the private backend in place, @vercel/blob installed, an empty data.json seed,
# and a passing type-check + production build. Prints nothing secret (there are no secrets yet).
set -euo pipefail
SRC="${1:?demo repo dir}"; DST="${2:?target dir}"; TZ_NAME="${3:?IANA time zone, e.g. Europe/Berlin}"
REF="$SRC/skill/reference"
[ -d "$REF/app" ] || { echo "no skill/reference in $SRC"; exit 1; }
[ -e "$DST" ] && { echo "$DST already exists; pick a new folder"; exit 1; }
mkdir -p "$DST"
( cd "$SRC" && tar --exclude=node_modules --exclude=.next --exclude=skill --exclude=screenshots --exclude=.git -cf - . ) | ( cd "$DST" && tar -xf - )
cd "$DST"
rm -f app/page.tsx app/api/data/route.ts app/api/send/route.ts lib/demo-data.ts lib/demo-sim.ts lib/demo-chats.ts components/DemoApp.tsx
cp -R "$REF/app/." app/
cp -R "$REF/lib/." lib/
cp "$REF/scripts/push-data.sh" "$REF/scripts/push-messages.sh" "$REF/scripts/make-bundle.sh" .
chmod +x push-data.sh push-messages.sh make-bundle.sh
printf '%s\n' '{"UPDATED":"","USAGE":{"weeklyPct":0,"reset":"","onDemandPct":0,"period":"","byTeam":[],"topBots":[]},"TEAMS":[]}' > data.json
# real-app wording in the UI
sed -i 's/title: "Control Center · Demo", description: "[^"]*"/title: "Control Center", description: "Private"/' app/layout.tsx
grep -q '/api/data' components/ControlCenter.tsx || { echo "unexpected UI file"; exit 1; }
printf 'NEXT_PUBLIC_TIMEZONE=%s\n' "$TZ_NAME" > .env.production
grep -q '^\.env\*' .gitignore || echo '.env*' >> .gitignore
npm ci --no-audit --no-fund >/dev/null
npm i @vercel/blob@^2 --no-audit --no-fund >/dev/null
npx tsc --noEmit
npx next build >/tmp/cc-build.log 2>&1 || { tail -40 /tmp/cc-build.log; exit 1; }
echo "assemble: OK -> $DST"
