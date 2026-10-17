import type { BlueprintDefinition, GrowthStep } from "@/lib/hire/blueprint-types";

/* ---------------------------------------------------------------------------
 * The offer letter and growth plan, PURE — the builder's live preview in the
 * browser, the stored letter and the PDF are all this one function, so the
 * three cannot drift. Every figure comes from the offer and the blueprint's
 * offer model; nothing is restated by a model (spec §5.9).
 * ------------------------------------------------------------------------- */

export function rupees(paise: number): string {
  const r = Math.round(paise / 100);
  const t = String(Math.abs(r));
  const l3 = t.slice(-3);
  const rest = t.slice(0, -3);
  return `${r < 0 ? "−" : ""}₹${rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + l3 : l3}`;
}

export type LadderRow = { grade: string; when: string; pay: string; basicPaise: number };

/** The growth plan from ONE definition (fixes D12), starting from the offered basic. */
export function growthLadder(def: Pick<BlueprintDefinition, "offer">, gradeKey: string, basicPaise: number, growth: GrowthStep[] = def.offer.growth): LadderRow[] {
  const label = (k: string) => def.offer.grades.find((g) => g.key === k)?.label ?? k;
  const rows: LadderRow[] = [{ grade: label(gradeKey), when: "On joining", pay: `${rupees(basicPaise)} a month`, basicPaise }];
  let cur = gradeKey;
  let pay = basicPaise;
  for (let guard = 0; guard < 10; guard++) {
    const step = growth.find((g) => g.fromGrade === cur);
    if (!step) break;
    pay = step.incrementType === "percentage" ? Math.round(pay * (1 + step.value / 100)) : pay + step.value;
    rows.push({ grade: label(step.toGrade), when: step.criterion, pay: `${rupees(pay)} a month · ${step.incrementType === "percentage" ? `+${step.value}%` : `+${rupees(step.value)}`}`, basicPaise: pay });
    cur = step.toGrade;
  }
  return rows;
}

const longDate = (d: string | null | undefined) =>
  d ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${d}T12:00:00+05:30`)) : "a date to be agreed";

export type LetterInput = {
  def: Pick<BlueprintDefinition, "offer">;
  roleTitle: string;
  candidateName: string;
  location: string | null;
  grade: string;
  gradeLabel: string;
  basicPaise: number;
  ctcPaise: number | null;
  incentive: string | null;
  joiningDate: string | null;
  expiryDate: string | null;
  growth?: GrowthStep[] | null;
  /** ISO date the letter is dated; today's IST date when absent. */
  datedOn?: string | null;
};

export function renderLetter(i: LetterInput): string {
  const ladder = growthLadder(i.def, i.grade, i.basicPaise, i.growth?.length ? i.growth : i.def.offer.growth);
  const dated = longDate(i.datedOn ?? null);
  return [
    "Mahek Marketing India Pvt. Ltd.",
    i.datedOn ? dated : "",
    "",
    `Dear ${i.candidateName},`,
    "",
    `We are pleased to offer you the position of ${i.roleTitle} at Mahek Marketing India, at the grade of ${i.gradeLabel}${i.location ? `, based in ${i.location}` : ""}.`,
    "",
    `Your basic salary will be ${rupees(i.basicPaise)} a month (INR).${i.ctcPaise ? ` Your total cost to company will be ${rupees(i.ctcPaise)} a year (INR).` : ""}`,
    i.incentive ? `Incentive: ${i.incentive}` : "",
    "",
    "Growth plan",
    ...ladder.map((r) => `  · ${r.grade} — ${r.when}: ${r.pay}`),
    "",
    `We would like you to join on ${longDate(i.joiningDate)}. This offer is open until ${longDate(i.expiryDate)}.`,
    "",
    "Please bring the original documents listed by our onboarding team on your first day. If anything in this letter is not as you understood it, tell us before you accept — we would rather correct it now.",
    "",
    `We look forward to working with you, ${i.candidateName.split(" ")[0]}.`,
    "",
    "For Mahek Marketing India Pvt. Ltd.",
    "Human Resources",
  ]
    .filter((l, idx, a) => !(l === "" && a[idx - 1] === ""))
    .join("\n");
}
