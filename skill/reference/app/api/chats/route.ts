import { isAuthed, notFound404 } from "../../../lib/auth";
import { readChat, readChatIndex, searchChats } from "../../../lib/store";
// The Chats panel: GET            -> { chats: [index of every chat] }
//                  GET ?id=<chat> -> { messages } (newest `limit`, optionally before an ISO time)
//                  GET ?q=<text>  -> { hits } across every chat
// Same cookie as /api/data.
export const dynamic = "force-dynamic";
export const revalidate = 0;
const H = { "Cache-Control": "no-store, max-age=0", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" };
export async function GET(req: Request) {
  if (!(await isAuthed())) return notFound404();
  const u = new URL(req.url);
  const id = u.searchParams.get("id"), q = u.searchParams.get("q");
  if (q) return Response.json({ hits: await searchChats(q) }, { headers: H });
  if (id) {
    const all = await readChat(id);
    const before = Date.parse(u.searchParams.get("before") || "");
    const limit = Math.min(1000, Math.max(20, Number(u.searchParams.get("limit")) || 300));
    const upto = isNaN(before) ? all : all.filter((m) => (Date.parse(m.at) || 0) < before);
    return Response.json({ messages: upto.slice(-limit), more: upto.length > limit, total: all.length }, { headers: H });
  }
  return Response.json({ chats: await readChatIndex() }, { headers: H });
}
