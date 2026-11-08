import data from "emoji-picker-element-data/en/emojibase/data.json";
// The emoji list for the emoji picker (every Unicode emoji, with names and keywords for search), served from this app
// so the picker works behind Vercel Authentication and without calling a CDN. Nothing private.
export async function GET() {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=604800", "ETag": '"emoji-data-1.8.0"' } });
}
