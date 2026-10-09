/* ---------------------------------------------------------------------------
 * Icons, product pictures and the lot-label QR, drawn exactly as the design
 * draws them. A picture is how somebody who cannot read the product name
 * tells a 1 L can from a 5 L one, so these are not decoration.
 * ------------------------------------------------------------------------- */
import { createElement, type CSSProperties, type ReactElement } from "react";
import { encodeQr, qrSvgPath } from "@/lib/hrms/qr";

export const IC: Record<string, string> = {
  qr:'<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM16 16h2v2h-2z"/>',
  home:'<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01"/>',
  flask:'<path d="M9 3h6M10 3v6L4.5 18.5A1.6 1.6 0 0 0 6 21h12a1.6 1.6 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/>',
  fill:'<path d="M12 3c3 4 5 6.8 5 9.5a5 5 0 0 1-10 0C7 9.8 9 7 12 3z"/>', drop:'<path d="M12 3c3 4 5 6.8 5 9.5a5 5 0 0 1-10 0C7 9.8 9 7 12 3z"/>',
  box:'<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>',
  truck:'<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  check:'<path d="M5 12.5l4.5 4.5L19 7"/>', clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert:'<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17h.01"/>', x:'<path d="M6 6l12 12M18 6L6 18"/>',
  back:'<path d="M15 5l-7 7 7 7"/>', chev:'<path d="M9 5l7 7-7 7"/>',
  speaker:'<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  play:'<path d="M7 4.5v15l12-7.5z"/>', pause:'<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
  wifi:'<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 15.8a5 5 0 0 1 6.4 0"/><path d="M12 19h.01"/>',
  wifioff:'<path d="M3 3l18 18M8.8 15.8a5 5 0 0 1 6.4 0M5.5 12.5a9.5 9.5 0 0 1 4.6-2.4M14 10.2a9.5 9.5 0 0 1 4.5 2.3M2.5 9a14 14 0 0 1 4.2-2.7M11 5.1A14 14 0 0 1 21.5 9"/>',
  sync:'<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  print:'<path d="M7 9V3h10v6M7 18H4v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7h-3"/><path d="M7 14h10v7H7z"/>',
  people:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  chart:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', list:'<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  wrench:'<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', minus:'<path d="M5 12h14"/>', del:'<path d="M9 5h11v14H9l-6-7z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/>',
  camera:'<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', torch:'<path d="M8 3h8l-1 6H9zM9 9h6v4l-1 8h-4l-1-8z"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  out:'<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>', pin:'<path d="M12 21s7-6.4 7-11.5A7 7 0 0 0 5 9.5C5 14.6 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  badge:'<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M8.5 17a3.5 3.5 0 0 1 7 0"/>', bolt:'<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'
};

export type IconName = keyof typeof IC;

/** One line icon. `s` is the pixel size; `c` the stroke colour. */
export function ic(n: string, s?: number, c?: string): ReactElement {
  return createElement("svg", {
    width: s || 22, height: s || 22, viewBox: "0 0 24 24", fill: "none", stroke: c || "currentColor",
    strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round",
    style: { flex: "none", display: "block" }, "aria-hidden": true,
    dangerouslySetInnerHTML: { __html: IC[n] || "" },
  });
}

export type ArtKind = "can" | "drum" | "rm" | "tank" | "box" | "truck";

/** A product picture: a can, a drum, a raw-material drum, a mixing tank, a carton or a truck. */
export function art(kind: ArtKind, col?: string, label?: string, s?: number): ReactElement {
  s = s || 64;
  const t = String(label || "").replace(/[<&>]/g, "");
  col = col || "#6835FB";
  const tx = (x: number, y: number, fs: number) =>
    '<text x="' + x + '" y="' + y + '" font-size="' + fs + '" font-weight="700" fill="#FFFFFF" text-anchor="middle" font-family="Google Sans Flex,system-ui,sans-serif">' + t + "</text>";
  const P: Record<ArtKind, string> = {
      can:'<path d="M30 22h30l8 10v54a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4V32z" fill="#EEF0F4" stroke="#9BA3B2" stroke-width="2"/><rect x="33" y="13" width="15" height="9" rx="2" fill="#9BA3B2"/><path d="M60 26c12 0 14 8 14 18" fill="none" stroke="#9BA3B2" stroke-width="4" stroke-linecap="round"/><rect x="22" y="46" width="46" height="28" fill="' + col + '"/>' + tx(45, 65, 13),
      drum:'<ellipse cx="50" cy="20" rx="28" ry="7" fill="#EEF0F4" stroke="#9BA3B2" stroke-width="2"/><path d="M22 20v60c0 4 12.5 7 28 7s28-3 28-7V20" fill="' + col + '" stroke="#9BA3B2" stroke-width="2"/><path d="M22 40c0 4 12.5 7 28 7s28-3 28-7M22 62c0 4 12.5 7 28 7s28-3 28-7" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="2"/>' + tx(50, 60, 14),
      rm:'<ellipse cx="50" cy="20" rx="28" ry="7" fill="#DDE1E8" stroke="#6B7385" stroke-width="2"/><path d="M22 20v60c0 4 12.5 7 28 7s28-3 28-7V20" fill="#C2C8D2" stroke="#6B7385" stroke-width="2"/><rect x="22" y="44" width="56" height="22" fill="' + col + '"/>' + tx(50, 60, 12),
      tank:'<path d="M24 24h52v46a14 14 0 0 1-14 14H38a14 14 0 0 1-14-14z" fill="#EEF0F4" stroke="#9BA3B2" stroke-width="2"/><rect x="24" y="46" width="52" height="24" fill="' + col + '"/><path d="M40 12h20v12H40z" fill="#9BA3B2"/><path d="M50 4v8" stroke="#9BA3B2" stroke-width="3"/><path d="M32 82l-5 12M68 82l5 12" stroke="#9BA3B2" stroke-width="4" stroke-linecap="round"/>' + tx(50, 62, 12),
      box:'<path d="M14 36l36-14 36 14v42l-36 14-36-14z" fill="#E9D9B8" stroke="#A88A55" stroke-width="2"/><path d="M14 36l36 14 36-14M50 50v42" fill="none" stroke="#A88A55" stroke-width="2"/><path d="M18 54l28 11v16l-28-11z" fill="' + col + '"/><text x="32" y="72" font-size="9" font-weight="700" fill="#FFFFFF" text-anchor="middle" font-family="sans-serif" transform="rotate(21 32 70)">' + t + '</text>',
      truck:'<circle cx="50" cy="50" r="40" fill="#F1ECFF"/><path d="M24 36h32v26H24zM56 44h12l8 9v9H56" fill="none" stroke="#5223E0" stroke-width="4" stroke-linejoin="round"/><circle cx="34" cy="66" r="6" fill="#FFFFFF" stroke="#5223E0" stroke-width="4"/><circle cx="66" cy="66" r="6" fill="#FFFFFF" stroke="#5223E0" stroke-width="4"/>'
  };
  return createElement("svg", { width: s, height: s, viewBox: "0 0 100 100", style: { display: "block", flex: "none" }, "aria-hidden": true, dangerouslySetInnerHTML: { __html: P[kind] || P.box } });
}

/**
 * A REAL QR for the code — the design drew a pattern hashed from the text,
 * which looks right and scans as nothing. A label somebody sticks on a pallet
 * has to come back through the scanner as the same code.
 */
export function qr(code: string, s?: number): ReactElement {
  let path = "", viewBox = "0 0 21 21";
  try {
    const m = encodeQr(String(code));
    ({ d: path, viewBox } = qrSvgPath(m, 1));
  } catch {
    /* Longer than a version-4 code holds: draw nothing rather than a lie. */
  }
  return createElement("svg", {
    width: s || 96, height: s || 96, viewBox, shapeRendering: "crispEdges",
    style: { display: "block", background: "#FFFFFF" } as CSSProperties, role: "img", "aria-label": "QR " + code,
  }, createElement("path", { d: path, fill: "#1A1E28" }));
}
