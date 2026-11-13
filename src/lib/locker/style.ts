/* ---------------------------------------------------------------------------
 * The Locker's colours and formatters for SERVER components. The same values
 * as src/app/locker/_ui/kit.tsx, which is a client module — and a value
 * exported from a client module is a reference on the server, not the value,
 * so `C.ink` there would be undefined. Keep the two in step.
 * ------------------------------------------------------------------------- */
import type { CSSProperties } from "react";

/**
 * THE LOCKER'S COLOURS ARE THE V4 THEME'S TOKENS — the ERP's look, read
 * from `src/styles/v4-theme.css` through CSS variables, so a value here is
 * never a hex of its own and the Locker cannot drift from the ERP's palette.
 * The vault's own violet is gone: v4 has none, and the vault is marked by
 * its lock glyph and the Restricted badge instead. The `v*` keys survive so
 * the screens did not all have to change at once; they now mean ink and
 * canvas.
 */
const v = (name: string) => `var(--color-${name})`;
export const C = {
  ink: v("ink"), body: v("body"), muted: v("muted"), faint: v("faint"), line: v("line"), line2: v("divider"), line3: v("divider"),
  canvas: v("page"), soft: v("canvas"), brand: v("brand"), brandInk: v("brand-hover"), brandSoft: v("brand-soft"),
  red: v("danger"), redInk: v("danger"), redSoft: v("danger-soft"), amber: v("warn-ink"), amberSoft: v("warn-soft"),
  green: v("success"), greenSoft: v("success-soft"), blue: v("info"), blueSoft: v("info-soft"),
  v50: v("canvas"), v100: v("line"), v500: v("muted"), v700: v("ink"), v900: v("ink"),
  surface: v("surface"), lineStrong: v("line-strong"),
};
export const LBL: CSSProperties = { fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted };
export const nf = (n: number) => Number(n || 0).toLocaleString("en-IN");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS = MON;
export function fd(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d} ${MON[Number(m) - 1]} ${y}`;
}
export function fds(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${d} ${MON[Number(m) - 1]}`;
}
export function inr(paise: number | null | undefined): string {
  if (paise == null) return "—";
  const n = Math.round(paise / 100);
  return (n < 0 ? "−" : "") + "₹" + Math.abs(n).toLocaleString("en-IN");
}
/** An instant as "09 Oct 2026, 14:05" in IST. */
export function stampIst(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${fd(day)}, ${t}`;
}

export const MONO = "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)";

export type BtnKind = "p" | "s" | "d" | "v" | "g";
/** The design's button, as a style — server-safe, so a server page can draw a link as a button. */
export function btnStyle(k: BtnKind, small = false): CSSProperties {
  return {
    height: small ? 32 : 36,
    padding: small ? "0 10px" : "0 14px",
    borderRadius: "var(--radius-control, 7px)",
    fontSize: small ? 13 : 14,
    fontWeight: 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
    border: k === "s" ? `1px solid ${C.lineStrong}` : k === "g" ? "none" : `1px solid ${k === "d" ? C.red : C.brand}`,
    background: k === "p" || k === "v" ? C.brand : k === "d" ? C.red : k === "g" ? "transparent" : C.surface,
    color: k === "p" || k === "d" || k === "v" ? C.surface : k === "g" ? C.brandInk : C.body,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    textDecoration: "none",
  };
}

/** A date (or date and time) in Asia/Kolkata — server-safe. */
export function when(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) }).format(new Date(iso));
}
