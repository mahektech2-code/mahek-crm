"use client";

import * as React from "react";

/* ---------------------------------------------------------------------------
 * The design's small vocabulary — colours, icons, and the one behaviour
 * inline styles cannot express on their own: a hover and a focus style.
 * Every colour below is the design's own (Founder Command Centre.dc.html).
 * ------------------------------------------------------------------------- */

export const C = {
  ink: "#161616",
  body: "#3D4453",
  muted: "#6B7385",
  faint: "#C2C8D2",
  line: "#DDE1E8",
  soft: "#EDEFF3",
  canvas: "#F7F8FA",
  white: "#FFFFFF",
  brand: "#6835FB",
  brandDark: "#5223E0",
  brandDeep: "#3D14A8",
  brandTint: "#F1ECFF",
  brandTint2: "#DDD2FF",
  lime: "#C6FF34",
  bad: "#B3261E",
  badTint: "#FCECEC",
  warn: "#B77B08",
  warnInk: "#8A5C05",
  warnTint: "#FDF6E7",
  warnLine: "#F9E9C4",
  good: "#1D7A45",
  goodTint: "#E9F5EE",
  blue: "#2B5CBF",
  blueTint: "#EDF2FC",
} as const;

export const PILL: Record<string, [string, string]> = {
  bad: [C.badTint, C.bad],
  warn: [C.warnTint, C.warnInk],
  good: [C.goodTint, C.good],
  info: [C.brandTint, C.brandDark],
  muted: [C.soft, C.body],
};

export const EASE = "cubic-bezier(0.2,0,0.2,1)";

export const upper: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: C.muted,
};

const ICONS: Record<string, string> = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  people:
    "M16 20v-2a4 4 0 0 0-8 0v2M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 20v-2a3 3 0 0 0-3-3M2 20v-2a3 3 0 0 1 3-3",
  pin: "M12 21s7-6.4 7-11a7 7 0 0 0-14 0c0 4.6 7 11 7 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
  money: "M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 7v10M18 7v10",
  store: "M4 9l2-5h12l2 5M4 9v11h16V9M4 9h16M9 20v-6h6v6",
  funnel: "M3 4h18l-7 8v6l-4 2v-8z",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z",
  id: "M4 5h16v14H4zM9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4M6 16c.6-1.8 1.8-3 3-3s2.4 1.2 3 3M14 9h4M14 13h4",
  tag: "M20 12l-8 8-9-9V3h8zM7.5 7.5h.01",
  msg: "M4 4h16v12H8l-4 4z",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  call: "M5 4h3l2 5-2.5 1.5a11 11 0 0 0 5 5L14 13l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2",
  globe:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-4-4",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICONS[name] ?? ""} />
    </svg>
  );
}

type HovProps<T extends keyof React.JSX.IntrinsicElements> = {
  as?: T;
  style?: React.CSSProperties;
  hover?: React.CSSProperties;
  focus?: React.CSSProperties;
} & Omit<React.ComponentPropsWithoutRef<T>, "style">;

/**
 * `border: 1px solid X` beside a hover that changes only the colour: React
 * warns about mixing a shorthand with its longhand, so the shorthand is
 * expanded once, here, into the three properties it stands for.
 */
function expandBorder(style: React.CSSProperties | undefined): React.CSSProperties | undefined {
  if (!style || typeof style.border !== "string") return style;
  const m = /^(\S+)\s+(\S+)\s+(.+)$/.exec(style.border.trim());
  if (!m) return style;
  const { border: _b, ...rest } = style;
  void _b;
  return { ...rest, borderWidth: m[1], borderStyle: m[2] as React.CSSProperties["borderStyle"], borderColor: m[3] };
}

/** An element with the design's `style-hover` / `style-focus`. */
export function Hov<T extends keyof React.JSX.IntrinsicElements = "button">({
  as,
  style,
  hover,
  focus,
  ...rest
}: HovProps<T>) {
  const [h, setH] = React.useState(false);
  const [f, setF] = React.useState(false);
  const Tag = (as ?? "button") as React.ElementType;
  const r = rest as Record<string, unknown>;
  return (
    <Tag
      {...rest}
      onMouseEnter={(e: React.MouseEvent) => {
        setH(true);
        (r.onMouseEnter as ((e: React.MouseEvent) => void) | undefined)?.(e);
      }}
      onMouseLeave={(e: React.MouseEvent) => {
        setH(false);
        (r.onMouseLeave as ((e: React.MouseEvent) => void) | undefined)?.(e);
      }}
      onFocus={(e: React.FocusEvent) => {
        setF(true);
        (r.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
      }}
      onBlur={(e: React.FocusEvent) => {
        setF(false);
        (r.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
      }}
      style={{ ...(hover?.borderColor || focus?.borderColor ? expandBorder(style) : style), ...(h && hover ? hover : null), ...(f && focus ? focus : null) }}
    />
  );
}

/** The design's global stylesheet (its <helmet>). */
export function DesignStyles() {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,300..700&family=IBM+Plex+Mono:wght@400;500&display=swap"
        precedence="default"
      />
      <style>{`
.fcc-root, .fcc-root *{box-sizing:border-box}
.fcc-root{font-family:"Google Sans Flex",system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:20px;color:#3D4453;background:#F7F8FA;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums lining-nums}
.fcc-root button,.fcc-root input,.fcc-root select,.fcc-root textarea{font:inherit;color:inherit;font-variant-numeric:inherit}
.fcc-root a{color:#6835FB;text-decoration:none}
.fcc-root a:hover{color:#5223E0;text-decoration:underline}
.fcc-root :focus-visible{outline:2px solid #6835FB;outline-offset:2px}
.fcc-root ::-webkit-scrollbar{width:10px;height:10px}
.fcc-root ::-webkit-scrollbar-thumb{background:#DDE1E8;border-radius:5px}
@keyframes fd-fade{from{opacity:0}to{opacity:1}}
@keyframes fd-drawer{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes fd-pulse{0%{opacity:1}50%{opacity:0.35}100%{opacity:1}}
@media (prefers-reduced-motion: reduce){.fcc-root *{animation:none !important;transition:none !important}}
`}</style>
    </>
  );
}

/** A skeleton line while a read is in flight — PRD §22.1 "Loading". */
export function Pulse({ w = "100%", h = 14 }: { w?: string | number; h?: number }) {
  return (
    <span
      style={{
        display: "block",
        width: w,
        height: h,
        borderRadius: 4,
        background: C.soft,
        animation: "fd-pulse 1.4s ease-in-out infinite",
      }}
    />
  );
}
