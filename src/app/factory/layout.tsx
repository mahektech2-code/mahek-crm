import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Factory - MahekOne",
  description: "The factory floor's phone app: scan, see the picture, count, send.",
  appleWebApp: { capable: true, title: "Factory", statusBarStyle: "default" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#FFFFFF" };

/**
 * The factory app is drawn at phone size. On a phone it IS the screen; on a
 * desktop it sits in the design's phone frame, so a Production Head looking at
 * it on a laptop sees exactly what the floor sees.
 */
export default function FactoryLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Devanagari for Hindi and Marathi, and the mono the lot codes are set in. */}
      {/* App Router: React hoists this into the head of every factory page. */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        rel="stylesheet"
        precedence="default"
        href="https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap"
      />
      <style>{`
        .fx-root{font-family:'Google Sans Flex','Noto Sans Devanagari',system-ui,-apple-system,sans-serif;color:#1A1E28;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
        .fx-root *{box-sizing:border-box}
        .fx-root button,.fx-root input{font-family:inherit;color:inherit}
        .fx-root button:focus-visible{outline:3px solid #6835FB;outline-offset:2px}
        /* A scrolling column must not squeeze its cards to fit — it scrolls. */
        .fx-scroll>*{flex-shrink:0}
        .fx-stage{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:20px;background:#E6E8EE}
        .fx-phone{width:390px;height:844px;max-height:calc(100dvh - 40px);background:#F7F8FA;border-radius:32px;border:1px solid #DDE1E8;box-shadow:0 24px 64px rgba(26,30,40,0.18);overflow:hidden;position:relative;display:flex;flex-direction:column}
        @media (max-width:520px){
          /* A scrolling column must not squeeze its cards to fit — it scrolls. */
        .fx-scroll>*{flex-shrink:0}
        .fx-stage{padding:0;align-items:stretch;background:#F7F8FA}
          .fx-phone{width:100%;height:100dvh;max-height:none;border-radius:0;border:none;box-shadow:none}
        }
        @keyframes fx-scan{0%{top:6%}50%{top:90%}100%{top:6%}}
        @keyframes fx-spin{to{transform:rotate(360deg)}}
        @keyframes fx-up{from{transform:translateY(28px);opacity:0}to{transform:none;opacity:1}}
        @keyframes fx-pulse{0%,100%{opacity:1}50%{opacity:.35}}
        @media (prefers-reduced-motion:reduce){.fx-root *{animation:none!important}}
      `}</style>
      <div className="fx-root">{children}</div>
    </>
  );
}
