/* ---------------------------------------------------------------------------
 * The handful of glyphs the price list screens draw — 16px line icons in the
 * current colour, so a menu item, a row action and a toggle all read as one
 * family. Kept here rather than in the shell's icon set because nothing else
 * in MahekOne needs a PDF or a derivation arrow.
 * ------------------------------------------------------------------------- */

const PATHS: Record<string, string> = {
  upload: "M8 10V2.5m0 0L5 5.5m3-3l3 3M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2",
  grid: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  list: "M2.5 4h11M2.5 8h11M2.5 12h11",
  copy: "M5.5 5.5h7v8h-7zM3.5 10.5v-8h7",
  derive: "M3 12.5L7 8.5M7 8.5V11.5M7 8.5H4M8.5 3.5h4v4M12.5 3.5L8.5 7.5",
  table: "M2.5 3h11v10h-11zM2.5 6.5h11M2.5 10h11M6.5 3v10",
  doc: "M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3",
  pdf: "M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3M6 9.5h4M6 11.5h2.5",
  edit: "M10.5 2.5l3 3-7.5 7.5H3v-3zM9 4l3 3",
  lock: "M4.5 7V5a3.5 3.5 0 017 0v2M3.5 7h9v6.5h-9z",
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path d={PATHS[name] ?? PATHS.doc} stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
