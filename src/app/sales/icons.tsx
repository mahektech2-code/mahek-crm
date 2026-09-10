/* ---------------------------------------------------------------------------
 * The Manager Console's icon set, from `MBOS Manager Console.dc.html`.
 *
 * Copied path for path rather than redrawn. An icon set is a typeface: two
 * hands drawing the same twenty-five glyphs produce two sets that look almost
 * the same and never quite sit together, and the design already made every one
 * of these decisions.
 *
 * One stroke weight (1.6), one grid (24), one size (20 unless asked) — the
 * design's own numbers, and the reason it reads as one set.
 * ------------------------------------------------------------------------- */

export type SalesIconName =
  | "home"
  | "pin"
  | "chart"
  | "target"
  | "task"
  | "route"
  | "visit"
  | "spark"
  | "order"
  | "money"
  | "doc"
  | "sample"
  | "grid"
  | "clock"
  | "cal"
  | "receipt"
  | "book"
  | "people"
  | "sliders"
  | "shield"
  | "list"
  | "search"
  | "bell"
  | "close"
  | "dots"
  | "tick"
  | "signOut";

const PATHS: Record<SalesIconName, React.ReactNode> = {
  home: <path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />,
  pin: (
    <>
      <path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  chart: (
    <>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M8 16v-5M12 16V8M16 16v-7" />
    </>
  ),
  task: (
    <>
      <path d="M9 11l2.5 2.5L16 9" />
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.5 6H14a3 3 0 0 1 0 6H10a3 3 0 0 0 0 6h5.5" />
    </>
  ),
  visit: (
    <>
      <path d="M5 21V8l7-4 7 4v13" />
      <path d="M9 21v-6h6v6" />
    </>
  ),
  spark: <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z" />,
  order: (
    <>
      <path d="M6 7h13l-1.3 9.2A2 2 0 0 1 15.7 18H9.3a2 2 0 0 1-2-1.8L6 7z" />
      <path d="M9 7V5.5a3 3 0 0 1 6 0V7" />
    </>
  ),
  money: <path d="M6 5h12M6 9h12M15 5c0 4.5-3.6 5.5-9 5.5L14 19" />,
  doc: (
    <>
      <path d="M14 4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z" />
      <path d="M14 4v4h4M9 13h6M9 16h4" />
    </>
  ),
  sample: (
    <>
      <path d="M9 3h6" />
      <path d="M10 3v7l-3.4 6a2 2 0 0 0 1.7 3h7.4a2 2 0 0 0 1.7-3L14 10V3" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  cal: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
      <path d="M8 8h7" />
    </>
  ),
  people: (
    <>
      <path d="M15 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20" />
      <circle cx="9" cy="7" r="3.5" />
      <path d="M17 4a3.6 3.6 0 0 1 0 6.6M21 20v-1.5a4 4 0 0 0-3-3.8" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
      <circle cx="16" cy="8" r="2" />
      <circle cx="10" cy="16" r="2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" />
      <path d="M9.5 12l2 2 3.5-3.5" />
    </>
  ),
  list: <path d="M5 7h14M5 12h14M5 17h9" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8A6 6 0 1 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  dots: (
    <>
      <circle cx="6" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18" cy="12" r="1.4" />
    </>
  ),
  tick: <path d="m5 13 4 4L19 7" />,
  // Same glyph as the CRM header's own sign-out icon (shell/icons.tsx) — one
  // shape for the action everywhere it appears, not a stand-in borrowed from
  // "close" because this set never had a real one.
  signOut: (
    <>
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </>
  ),
};

export function SalesIcon({
  name,
  size = 20,
  className,
}: {
  name: SalesIconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ display: "block", flex: "none" }}
    >
      {PATHS[name]}
    </svg>
  );
}
