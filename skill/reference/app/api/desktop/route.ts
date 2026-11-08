import { isAuthed, notFound404 } from "../../../lib/auth";
import { readDesktop, writeDesktop } from "../../../lib/store";
// Links to the bots' computers (the small monitor button in Grok), for the page's 🖥 monitor.
// Saved by anyone who has the page; kept in the private Blob, never in data.json. Same cookie as /api/data.
export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store, max-age=0" };
export async function GET() {
  if (!(await isAuthed())) return notFound404();
  return Response.json({ links: await readDesktop() }, { headers: H });
}
export async function POST(req: Request) {
  if (!(await isAuthed())) return notFound404();
  let body: any = null;
  try { body = await req.json(); } catch {}
  if (!Array.isArray(body?.links)) return Response.json({ ok: false, error: "need links[]" }, { status: 400 });
  const links = body.links
    .filter((l: any) => l && typeof l.url === "string" && /^https:\/\/[^\s]+$/i.test(l.url.trim()) && l.url.length <= 2000)
    .slice(0, 10)
    .map((l: any) => ({ name: (typeof l.name === "string" && l.name.trim() ? l.name.trim() : "Grok Bot").slice(0, 60), url: l.url.trim() }));
  if (links.length !== body.links.length) return Response.json({ ok: false, error: "Each link must start with https://" }, { status: 400 });
  await writeDesktop(links);
  return Response.json({ ok: true, links }, { headers: H });
}
