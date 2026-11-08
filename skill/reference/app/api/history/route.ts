import { isAuthed, notFound404 } from "../../../lib/auth";
import { readHistory } from "../../../lib/store";
// The History panel's archive: past activity lines and the requests sent from the page. Same cookie as /api/data.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function GET() {
  if (!(await isAuthed())) return notFound404();
  return Response.json({ entries: await readHistory() }, { headers: { "Cache-Control": "no-store, max-age=0", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" } });
}
