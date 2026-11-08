import { isAdmin } from "../../../../lib/admin";
import { notFound404 } from "../../../../lib/auth";
import { appendChats, cleanChat } from "../../../../lib/store";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// POST { chats: [{ id, name, kind, team?, bot?, participants?, messages: [{ id?, at, from, role, text }] }] }
// with Authorization: Bearer <ADMIN_KEY>. Used by push-messages.sh. Messages are merged (deduped by id), never replaced wholesale.
export async function POST(req: Request) {
  if (!isAdmin(req)) return notFound404();
  let body: any = null;
  try { body = await req.json(); } catch {}
  const chats = Array.isArray(body?.chats) ? body.chats.map(cleanChat).filter(Boolean) : [];
  if (!chats.length) return Response.json({ ok: false, error: "need chats[] with id, name and messages[{at, from, role, text}]" }, { status: 400 });
  const r = await appendChats(chats as any);
  return Response.json({ ok: true, ...r });
}
