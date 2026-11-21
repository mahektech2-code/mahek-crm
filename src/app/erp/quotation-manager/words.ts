import { rateNumber } from "@/lib/erp/engines/quotes";
import { fd, inrRateFixed } from "@/lib/erp/ui";

/* How the Quotation manager writes its dates, rates and headings — one place,
   so the table, its editing bar, its side panel and its dialogs agree. */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 14-Oct-2026: what an edited date starts as, and what Copy and Export write. */
export function longDate(d: string): string {
  const [y, m, day] = d.split("-");
  return y && m && day ? `${Number(day)}-${MON[Number(m) - 1]}-${y}` : d;
}

/** "19 Nov" this year, "19 Nov 2025" any other — the table's date column. */
export function shortDate(d: string, today: string): string {
  return d.slice(0, 4) === today.slice(0, 4) ? fd(d) : `${fd(d)} ${d.slice(0, 4)}`;
}

/** A rate as the table shows it: "₹118.00". Anything that is not a number is shown as typed. */
export function rateText(v: string): string {
  const n = rateNumber(v);
  return n == null ? v : inrRateFixed(Math.round(n * 100));
}

/** A rate number in rupees as the table shows it. */
export function rupees(n: number | null): string {
  return n == null ? "—" : inrRateFixed(Math.round(n * 100));
}

/** A column's name with its pack and brand, as a heading reads top to bottom. */
export function columnTitle(c: { pack: string; name: string; brand: string }): string {
  return [c.pack, c.name, c.brand].filter(Boolean).join(" · ");
}

/** A column's material: its middle line, or its pack where it has none. */
export function columnName(c: { pack: string; name: string }): string {
  return c.name || c.pack || "Untitled";
}
