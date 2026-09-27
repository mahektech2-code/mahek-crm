/* ---------------------------------------------------------------------------
 * The Command Centre's words for numbers — pure, client-safe.
 *
 * The design's own rules: Indian grouping, the sign always kept ("a negative
 * figure never loses its minus", PRD P1), crore and lakh for headline money,
 * and a change printed in POINTS for a rate and PERCENT for a count (P6).
 * ------------------------------------------------------------------------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function groupIndian(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
}

/** Paise → "₹2,40,500", sign kept. */
export function inr(paise: number): string {
  const neg = paise < 0;
  return (neg ? "−₹" : "₹") + groupIndian(Math.round(Math.abs(paise) / 100));
}

/** Paise → "₹3.48 Cr" / "₹41.2 L" / "₹84,600", sign kept. */
export function crore(paise: number): string {
  const r = paise / 100;
  const neg = r < 0;
  const a = Math.abs(r);
  const t =
    a >= 1e7 ? (a / 1e7).toFixed(2) + " Cr" : a >= 1e5 ? (a / 1e5).toFixed(1) + " L" : groupIndian(a);
  return (neg ? "−₹" : "₹") + t;
}

export function num(n: number): string {
  return groupIndian(n) === "0" && n !== 0 ? String(n) : (n < 0 ? "−" : "") + groupIndian(n);
}

export function plural(n: number, one: string, many?: string): string {
  return `${num(n)} ${n === 1 ? one : many ?? one + "s"}`;
}

/** "2026-09-26" → "26 Sep 2026". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** "2026-09-26" → "26 Sep". */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${String(Number(d)).padStart(2, "0")} ${MONTHS[Number(m) - 1]}`;
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

export function monthShort(key: string): string {
  return MONTHS[Number(key.split("-")[1]) - 1];
}

export function monthLong(key: string): string {
  const L = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return L[Number(key.split("-")[1]) - 1];
}

/**
 * "1–26 Sep 2026" / "21 Aug – 3 Sep 2026" / "30 Dec 2025 – 2 Jan 2026" —
 * a span in the fewest words that still name every part that differs.
 */
export function span(from: string, to: string): string {
  if (from === to) return fmtDate(from);
  const [fy, fm, fd] = from.split("-");
  const [ty, tm, td] = to.split("-");
  if (fy === ty && fm === tm) return `${Number(fd)}–${Number(td)} ${MONTHS[Number(tm) - 1]} ${ty}`;
  if (fy === ty) return `${Number(fd)} ${MONTHS[Number(fm) - 1]}–${Number(td)} ${MONTHS[Number(tm) - 1]} ${ty}`;
  return `${fmtDate(from)} – ${fmtDate(to)}`;
}

/** A change, in the right unit: points for a rate, percent for the rest. */
export function change(current: number | null, previous: number | null, rate = false): {
  text: string;
  up: boolean | null;
} {
  if (current == null || previous == null) return { text: "No comparison", up: null };
  if (rate) {
    const d = current - previous;
    return { text: `${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)} pts`, up: d >= 0 };
  }
  if (previous === 0) return { text: current === 0 ? "No change" : "No comparison", up: current === 0 ? null : true };
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return { text: `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}%`, up: pct >= 0 };
}

/** "+21.2%" / "−3.0 pts" — the same-dates-last-year line. */
export function signedChange(current: number | null, previous: number | null, rate = false): string | null {
  if (current == null || previous == null) return null;
  if (rate) {
    const d = current - previous;
    return `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} pts`;
  }
  if (previous === 0) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** "52 h" / "4 days" / "18 hours" — how long something has waited. */
export function waited(hours: number): string {
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.floor(hours / 24)} days`;
}
