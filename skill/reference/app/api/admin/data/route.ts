import { isAdmin } from "../../../../lib/admin";
import { notFound404 } from "../../../../lib/auth";
import { activityEntries, appendHistory, readData, validData, writeData } from "../../../../lib/store";
export const dynamic = "force-dynamic";
// POST the full DATA JSON with Authorization: Bearer <ADMIN_KEY>. Used by push-data.sh. No redeploy needed.
export async function POST(req: Request) {
  if (!isAdmin(req)) return notFound404();
  let d: any = null;
  try { d = await req.json(); } catch {}
  if (!validData(d)) return Response.json({ ok: false, error: "bad schema (need UPDATED, USAGE.weeklyPct, TEAMS[])" }, { status: 400 });
  // AVATARS (each bot's Grok look) is set once: a push without it keeps the saved one; send {} to clear it
  if (d.AVATARS === undefined || d.AVATARS === null || typeof d.AVATARS !== "object" || Array.isArray(d.AVATARS)) {
    delete d.AVATARS;
    try { const prev = await readData(); if (prev && prev.AVATARS && typeof prev.AVATARS === "object") d.AVATARS = prev.AVATARS; } catch {}
  }
  await writeData(d);
  try { await appendHistory(activityEntries(d)); } catch {} // the archive never blocks a data push
  return Response.json({ ok: true, teams: d.TEAMS.length, updated: d.UPDATED, avatars: d.AVATARS ? Object.keys(d.AVATARS).length : 0 });
}
