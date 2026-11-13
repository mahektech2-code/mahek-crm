/* ---------------------------------------------------------------------------
 * The Locker's colours and formatters for SERVER components. The same values
 * as src/app/locker/_ui/kit.tsx, which is a client module — and a value
 * exported from a client module is a reference on the server, not the value,
 * so `C.ink` there would be undefined. Keep the two in step.
 * ------------------------------------------------------------------------- */
import type { CSSProperties } from "react";

export const C = {
  ink: "#1A1E28", body: "#3D4453", muted: "#6B7385", faint: "#9BA3B2", line: "#DDE1E8", line2: "#EDEFF3", line3: "#F3F4F7",
  canvas: "#FCFCFD", soft: "#F7F8FA", brand: "#6835FB", brandInk: "#5223E0", brandSoft: "#F1ECFF",
  red: "#B3261E", redInk: "#8E1F1F", redSoft: "#FCECEC", amber: "#8A5C05", amberSoft: "#FDF6E7",
  green: "#1D7A45", greenSoft: "#E9F5EE", blue: "#2B5CBF", blueSoft: "#EDF2FC",
  v50: "#F0EFF6", v100: "#DFDCEC", v500: "#5B5080", v700: "#3E3660", v900: "#262041",
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

export const MONO = "'JetBrains Mono',ui-monospace,monospace";

export type BtnKind = "p" | "s" | "d" | "v" | "g";
/** The design's button, as a style — server-safe, so a server page can draw a link as a button. */
export function btnStyle(k: BtnKind, small = false): CSSProperties {
  return {
    height: small ? 30 : 36,
    padding: small ? "0 10px" : "0 14px",
    borderRadius: 4,
    fontSize: small ? 13 : 14,
    fontWeight: 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
    border: k === "s" ? "1px solid #C2C8D2" : "none",
    background: k === "p" ? C.brand : k === "d" ? C.red : k === "v" ? C.v700 : k === "g" ? "transparent" : "#FFFFFF",
    color: k === "p" || k === "d" || k === "v" ? "#FFFFFF" : k === "g" ? C.brandInk : C.body,
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
