import { groupIndian } from "@/lib/format";

/**
 * The words for one expense line, shared by the Expenses page (a server
 * component) and its Review dialog (a client one) — so it lives in neither.
 *
 * An allowance says WHICH allowance, because "Food · ₹350" beside a ₹120 food
 * bill reads as a second meal he claimed rather than the meal allowance his
 * punch times earned.
 */
const KIND: Record<string, string> = {
  travel: "Bus or train",
  food: "Food",
  lodging: "Hotel",
  local_transport: "Local transport",
  other: "Other",
};

export function expenseKindLabel(kind: string, allowance: boolean): string {
  if (allowance) {
    if (kind === "food") return "Meal allowance";
    if (kind === "travel") return "Kilometre allowance";
    return `${KIND[kind] ?? "Other"} allowance`;
  }
  return KIND[kind] ?? kind.replace(/_/g, " ");
}

/**
 * An expense amount to the paisa. `money()` rounds to the rupee, which is
 * right for a dashboard total and wrong for a ₹12.50 auto fare a manager is
 * deciding — the figure on the button has to be the figure that is paid.
 */
export function inrExact(paise: number): string {
  const whole = Math.floor(Math.abs(paise) / 100);
  const rest = Math.abs(paise) % 100;
  return `${paise < 0 ? "−" : ""}₹${groupIndian(whole)}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

/** The usual ways a reimbursement is paid. Offered as chips; anything typed stands. */
export const PAYOUT_MODES = ["Bank transfer", "UPI", "Cash", "With salary", "Cheque"] as const;
