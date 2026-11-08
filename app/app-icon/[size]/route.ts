import { APP_ICONS } from "../../../lib/app-icons";
// App icons for the installable app (/app-icon/32, 180, 192, 512, maskable). Nothing private.
export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  const { size } = await ctx.params;
  const b64 = APP_ICONS[size];
  if (!b64) return new Response("not found", { status: 404 });
  return new Response(Buffer.from(b64, "base64"), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
}
