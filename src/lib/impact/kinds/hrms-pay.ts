import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { hrmsAdvances, hrmsExpenses, hrmsSalaries } from "@/db/schema";
import { inr } from "@/lib/erp/ui";
import { has } from "@/lib/hrms/access";
import { first } from "@/lib/hrms/server";
import { fdShort, monLabel, monthOf } from "@/lib/hrms/time";
import { EXPENSE_CLAIM } from "@/lib/hrms/values";
import { advanceTotals, recoveredByAdvance } from "@/lib/hrms/screens/pay";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { present } from "./erp-common";
import { employeeName, hrmsMayAct } from "./hrms-common";

/* ---------------------------------------------------------------------------
 * HRMS's money: a salary, an advance and an expense voucher.
 *
 * None of these is joined to another row by a key — the outstanding advance is
 * advances given less what salaries deducted, and an expense balance is
 * verified claims less verified payments, both worked out on every read. So a
 * delete moves a figure on a screen nobody was looking at, and that figure is
 * what this says. A paid salary also takes MahekOne's only record of the
 * payment with it; the money itself is not reversed by anything here.
 * ------------------------------------------------------------------------- */

/* ================================================================== salary */

export const salaryImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["payroll"], (ctx) => (has(ctx, "admin") ? null : "Deleting a salary needs the “Administer HRMS” power"));
  },

  async report(id) {
    const [s] = await db.select().from(hrmsSalaries).where(eq(hrmsSalaries.id, id));
    if (!s) return null;
    const name = await employeeName(s.employeeId);
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: "outstanding advance",
        effect: "changed",
        count: s.advanceDeductionPaise > 0 ? 1 : 0,
        note: `The ${inr(s.advanceDeductionPaise)} this salary deducted goes back to ${first(name)}’s outstanding advance, and the next salary deducts it unless payroll changes that.`,
      },
      {
        app: "HRMS",
        label: "payment record",
        effect: "deleted",
        count: s.status === "Paid" ? 1 : 0,
        note: `Paid${s.paidOn ? ` on ${fdShort(s.paidOn)}` : ""}${s.utr ? ` under UTR ${s.utr}` : ""}. The money is not reversed — only MahekOne’s record of it goes, and the payslip stops opening.`,
      },
    ];
    return {
      title: `${name}’s ${monLabel(s.month)} salary (${s.salaryNo}, ${s.status.toLowerCase()})`,
      verb: "Delete",
      confirmWord: s.salaryNo,
      items: present(items),
      blockers: [],
    };
  },
};

/* ================================================================= advance */

export const advanceImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["advances"], (ctx) => (has(ctx, "admin") ? null : "Deleting an advance needs the “Administer HRMS” power"));
  },

  async report(id) {
    const [a] = await db.select().from(hrmsAdvances).where(eq(hrmsAdvances.id, id));
    if (!a) return null;
    const name = await employeeName(a.employeeId);
    /* The act's own reading: salaries recover the oldest advance first. */
    const [all, totals] = await Promise.all([db.select().from(hrmsAdvances).where(eq(hrmsAdvances.employeeId, a.employeeId)), advanceTotals([a.employeeId])]);
    const recovered = recoveredByAdvance(all, totals.deducted).get(a.id) ?? 0;
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: "outstanding advance",
        effect: "changed",
        count: 1,
        note: `${first(name)}’s outstanding advance drops by ${inr(a.amountPaise)}, so the next salary deducts that much less.`,
      },
    ];
    return {
      title: `the ${inr(a.amountPaise)} advance to ${name}, ${fdShort(a.date)}`,
      verb: "Delete",
      confirmWord: "DELETE",
      items: recovered > 0 ? [] : items,
      blockers: recovered > 0 ? ["Part of this advance has already been recovered from salary, so it can’t be deleted"] : [],
    };
  },
};

/* ================================================================= expense */

export const expenseImpact: ImpactSource = {
  authorize: async (id) => {
    await hrmsMayAct(["expenses"], async (ctx) => {
      const [x] = await db.select({ employeeId: hrmsExpenses.employeeId, verify: hrmsExpenses.verify }).from(hrmsExpenses).where(eq(hrmsExpenses.id, id));
      if (!x) return null;
      const own = x.employeeId === ctx.employee?.id && x.verify !== "Verified";
      return has(ctx, "admin") || has(ctx, "hr") || own ? null : "Only HR or an HRMS administrator can delete a verified expense or another person’s expense.";
    });
  },

  async report(id) {
    const [x] = await db.select().from(hrmsExpenses).where(eq(hrmsExpenses.id, id));
    if (!x) return null;
    const name = await employeeName(x.employeeId);
    const amount = x.payType === EXPENSE_CLAIM ? x.claimPaise : x.paidPaise;
    /* Only verified vouchers count towards a balance — an unverified one is
       nobody's figure yet, and deleting it moves nothing. */
    const delta = (x.claimPaise ?? 0) - (x.paidPaise ?? 0);
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: "expense balance",
        effect: "changed",
        count: x.verify === "Verified" && delta !== 0 ? 1 : 0,
        note: `${first(name)}’s ${monLabel(monthOf(x.date))} balance and running balance both move by ${inr(Math.abs(delta))}, ${delta > 0 ? "less owed to them" : "less owed by them"}.`,
      },
    ];
    return {
      title: `${x.serial}, ${inr(amount ?? 0)} — ${name}, ${fdShort(x.date)}`,
      verb: "Delete",
      confirmWord: x.serial,
      items: present(items),
      blockers: [],
    };
  },
};
