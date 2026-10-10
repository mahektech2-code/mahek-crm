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
/* Runs before the first paint, so a phone never flashes the laptop frame. A
   touch screen or an installed app is a device; one laid out much wider than
   its own screen is a phone in "Desktop site" mode, scaled back up by its own
   factor. The rules go in as a <style> of their own rather than a class on
   <html>, which React owns and would report as a hydration mismatch. */
const DEVICE_CSS =
  ".fx-stage{min-height:calc(100dvh / var(--fx-z,1))!important;padding:0!important;align-items:stretch!important;background:#F7F8FA!important}" +
  ".fx-phone{width:100%!important;height:calc(100dvh / var(--fx-z,1))!important;max-height:none!important;border-radius:0!important;border:none!important;box-shadow:none!important;padding-top:env(safe-area-inset-top)}" +
  ".fx-sb{display:none!important}" +
  ".fx-root{zoom:var(--fx-z,1)}";
const FIT_SCRIPT = `(function(){try{var mm=function(q){return matchMedia(q).matches},t=mm("(pointer:coarse)")||mm("(display-mode:standalone)"),s=Math.min(screen.width,screen.height),w=innerWidth;if(!t&&w>520)return;var z=t&&s>0&&w>s*1.3?w/s:1,e=document.createElement("style");e.id="fx-fit";e.textContent=":root{--fx-z:"+z+"}"+${JSON.stringify(DEVICE_CSS)};document.head.appendChild(e)}catch(x){}})()`;

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
      <script dangerouslySetInnerHTML={{ __html: FIT_SCRIPT }} />
      <style>{`
        .fx-root{font-family:'Google Sans Flex','Noto Sans Devanagari',system-ui,-apple-system,sans-serif;color:#1A1E28;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
        .fx-root *{box-sizing:border-box}
        .fx-root button,.fx-root input{font-family:inherit;color:inherit}
        .fx-root button:focus-visible{outline:3px solid #6835FB;outline-offset:2px}
        /* A scrolling column must not squeeze its cards to fit — it scrolls. */
        .fx-scroll>*{flex-shrink:0}
        .fx-stage{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:20px;background:#E6E8EE}
        .fx-phone{width:390px;height:844px;max-height:calc(100dvh - 40px);background:#F7F8FA;border-radius:32px;border:1px solid #DDE1E8;box-shadow:0 24px 64px rgba(26,30,40,0.18);overflow:hidden;position:relative;display:flex;flex-direction:column}
        /* ON A PHONE THE APP IS THE SCREEN. The frame and its drawn status bar
           are for a laptop; a phone has a status bar of its own. Decided by the
           DEVICE (FIT_SCRIPT), not only the width: Chrome's "Desktop site" —
           which a TWA inherits — lays a phone out 980px wide, and a width rule
           then drew the laptop frame at 40% on somebody's phone. */
        @media (max-width:520px){
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
