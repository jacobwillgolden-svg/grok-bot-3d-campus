import { PALETTE } from "../lib/theme";
export const metadata = { title: "Control Center · Demo", description: "A 3D control center for a team of AI agents. Demo with invented data. Built with Grok Bot." };
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" as const, themeColor: PALETTE.page };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <head>
        {/* installable app: the manifest is fetched with cookies so it also works behind Vercel Authentication */}
        <link rel="manifest" href="/app.webmanifest" crossOrigin="use-credentials" />
        <link rel="icon" href="/app-icon/32" type="image/png" />
        <link rel="apple-touch-icon" href="/app-icon/180" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Control Center" />
      </head>
      <body style={{ margin: 0, background: PALETTE.page, color: PALETTE.text, colorScheme: "dark", WebkitTextSizeAdjust: "100%" }}>{children}</body>
    </html>
  );
}
