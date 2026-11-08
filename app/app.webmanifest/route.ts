import { PALETTE } from "../../lib/theme";
// The installable app ("desktop version"): Chrome/Edge "Install app", Safari "Add to Dock" / "Add to Home Screen".
// Linked from app/layout.tsx with crossorigin="use-credentials" so it also loads behind Vercel Authentication.
export async function GET() {
  const manifest = {
    name: "Control Center",
    short_name: "Control Center",
    description: "Your bot teams: chats, approvals, tasks and schedules.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: PALETTE.page,
    theme_color: PALETTE.page,
    icons: [
      { src: "/app-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Chats", url: "/?open=chats", icons: [{ src: "/app-icon/192", sizes: "192x192" }] },
      { name: "Watch the computer", url: "/?open=monitor", icons: [{ src: "/app-icon/192", sizes: "192x192" }] },
    ],
  };
  return new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" } });
}
