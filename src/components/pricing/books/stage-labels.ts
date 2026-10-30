/* ---------------------------------------------------------------------------
 * The words and tones a change's stage is drawn in, said once for every
 * screen that shows one — the books list, a book, a change, Today.
 * ------------------------------------------------------------------------- */

import type { ChangeStage } from "@/lib/engines/price-change";

export const STAGE_WORDS: Record<ChangeStage, string> = {
  edit: "Being edited",
  check: "Checked",
  approve: "Waiting approval",
  scheduled: "Scheduled",
  live: "Live",
  sent_back: "Sent back",
  cancelled: "Cancelled",
};

export const STAGE_TONE: Record<ChangeStage, "neutral" | "brand" | "success" | "warn" | "danger" | "muted"> = {
  edit: "neutral",
  check: "brand",
  approve: "warn",
  scheduled: "brand",
  live: "success",
  sent_back: "danger",
  cancelled: "muted",
};

/** The four steps of the bar, and which one a stage sits on. */
export const STEPS = ["Edit", "Check", "Approve", "Live"] as const;

export function stepOf(stage: ChangeStage): number {
  switch (stage) {
    case "edit":
    case "sent_back":
      return 0;
    case "check":
      return 1;
    case "approve":
      return 2;
    case "scheduled":
    case "live":
      return 3;
    case "cancelled":
      return -1;
  }
}

/** Rupees with the sign, for moves and effects. */
export function signedMoney(paise: number, money: (p: number) => string): string {
  if (paise === 0) return money(0);
  return `${paise > 0 ? "+" : "−"}${money(Math.abs(paise))}`;
}

export function pctWords(bp: number | null): string {
  if (bp == null) return "—";
  const v = bp / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
}

export function packWords(ml: number | null): string {
  if (ml == null) return "—";
  return ml >= 1000 ? `${(ml / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L` : `${ml} ml`;
}
