import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { expensePolicies, expensePolicyRules } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { ruleSpec } from "@/lib/expense-rule-forms";
import { daysStampedWith, readPolicySet } from "@/lib/services/expense-policy-set-service";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";

/* ---------------------------------------------------------------------------
 * AN EXPENSE POLICY DECIDES WHAT A SALESMAN IS PAID FOR A DAY ON THE ROAD,
 * and three places read it: the Admin Console where it is written, the Sales
 * Dashboard where his days are priced and verified, and his handset, which
 * carries his policy's limits so he can see them with no signal.
 *
 * Deleting a named policy moves its people back to standard — the cascade on
 * the assignment does that — and re-works their days from yesterday on. A
 * policy that has already priced a day is refused and kept as the record of
 * it; the report carries that refusal as a blocker so the modal never offers
 * a button the act would turn down.
 *
 * `expense.policy.write` for both, the capability the acts check.
 * ------------------------------------------------------------------------- */

const authorize = async () => {
  await requireCapability("expense.policy.write");
};

/** `expense-policy-set` — `deletePolicySet`. */
export const expensePolicySetImpact: ImpactSource = {
  authorize,

  async report(id) {
    const set = await readPolicySet(id);
    if (!set) return null;
    const from = addDays(await today(), -1);
    const [stamped, members, [revisions], copies] = await Promise.all([
      daysStampedWith(id),
      db.execute<{ id: string; name: string }>(sql`
        select u.id, u.name from expense_policy_assignments a
          join users u on u.id = a.user_id
         where a.set_id = ${id}
         order by u.name
      `),
      db.execute<{ n: number }>(sql`select count(*)::int as n from expense_policy_set_revisions where set_id = ${id}`),
      db.execute<{ name: string }>(sql`select s.name from expense_policy_sets s where s.cloned_from_id = ${id} and s.id <> ${id} order by s.name`),
    ]);
    const [days] = members.length
      ? await db.execute<{ n: number }>(sql`
          select count(*)::int as n from mbos_expense_days
           where user_id in (${sql.join(members.map((m) => sql`${m.id}`), sql`, `)})
             and day >= ${from}::date
        `)
      : [{ n: 0 }];

    const names = members.map((m) => m.name);
    const items: ImpactItem[] = [
      { app: "Admin Console", label: set.rules.length === 1 ? "rule on it" : "rules on it", effect: "deleted", count: set.rules.length },
      {
        app: "Admin Console",
        label: "saved versions in its history",
        effect: "deleted",
        count: Number(revisions?.n ?? 0),
      },
      {
        app: "Admin Console",
        label: copies.length === 1 ? "policy copied from it" : "policies copied from it",
        effect: "unlinked",
        count: copies.length,
        examples: copies.slice(0, 5).map((c) => c.name),
        note: "They keep their rules, and stop saying which policy they were copied from.",
      },
    ];
    if (set.active) {
      items.push(
        {
          app: "Admin Console",
          label: names.length === 1 ? "salesman moved to the standard policy" : "salesmen moved to the standard policy",
          effect: "changed",
          count: names.length,
          examples: names.slice(0, 5),
          note: "From the moment it is deleted, their days are paid on the standard policy's rates and limits.",
        },
        {
          app: "Sales Dashboard",
          label: Number(days?.n) === 1 ? "expense day worked out again" : "expense days worked out again",
          effect: "changed",
          count: Number(days?.n ?? 0),
          note: "Their days from yesterday on are re-worked on the standard policy. What they claimed stays; what is eligible may move.",
        },
        {
          app: "MBOS handsets",
          label: names.length === 1 ? "salesman's phone" : "salesmen's phones",
          effect: "phones",
          count: names.length,
          examples: names.slice(0, 5),
          note: "The phone shows the standard policy's limits from its next sync.",
        },
      );
    } else {
      items.push({
        app: "Admin Console",
        label: names.length === 1 ? "salesman still assigned to it" : "salesmen still assigned to it",
        effect: "unlinked",
        count: names.length,
        examples: names.slice(0, 5),
        note: "It is switched off, so they are already paid on the standard policy. Deleted, switching it back on can no longer return them to it.",
      });
    }
    if (!stamped) {
      items.push({
        app: "Sales Dashboard",
        label: "expense days already paid on it",
        effect: "kept",
        count: 0,
        note: "No day has been worked out on it, so no claim already made is restated.",
      });
    }

    const blockers: string[] = [];
    if (set.isStandard) blockers.push("The standard policy cannot be deleted.");
    if (stamped > 0) {
      blockers.push(
        `${stamped} expense ${stamped === 1 ? "day was" : "days were"} worked out on this policy, so it is kept as the record of them. Switch it off instead.`,
      );
    }
    return { title: set.name, verb: "Delete", confirmWord: set.name, items, blockers };
  },
};

/** `expense-rule` — `deleteRule`, one rule off a version of the dated expense policy. */
export const expenseRuleImpact: ImpactSource = {
  authorize,

  async report(id) {
    const [row] = await db
      .select({
        kind: expensePolicyRules.kind,
        grade: expensePolicyRules.grade,
        cityClass: expensePolicyRules.cityClass,
        scopeKey: expensePolicyRules.scopeKey,
        policyId: expensePolicyRules.policyId,
        title: expensePolicies.title,
        versionNo: expensePolicies.versionNo,
        status: expensePolicies.status,
      })
      .from(expensePolicyRules)
      .innerJoin(expensePolicies, eq(expensePolicies.id, expensePolicyRules.policyId))
      .where(eq(expensePolicyRules.id, id));
    if (!row) return null;
    const [days] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from mbos_expense_days where policy_id = ${row.policyId}`,
    );
    const name = ruleSpec(row.kind)?.label ?? row.kind;
    const who = [row.grade, row.cityClass ? `${row.cityClass} cities` : null, row.scopeKey || null].filter(Boolean).join(" · ");
    const draft = row.status === "draft";

    return {
      title: `${name} — ${row.title}, version ${row.versionNo}`,
      verb: "Remove",
      confirmWord: name,
      items: [
        {
          app: "Admin Console",
          label: `rule on version ${row.versionNo}`,
          effect: "deleted",
          count: 1,
          examples: [who ? `${name} (${who})` : name],
        },
        {
          app: "Sales Dashboard",
          label: "expense days paid on this version",
          effect: "kept",
          count: Number(days?.n ?? 0),
          note: draft
            ? `Version ${row.versionNo} is a draft: no day has been paid on it, and none will be until it is published.`
            : "Every day already paid on it keeps the answer it got.",
        },
      ],
      blockers: draft
        ? []
        : [
            `Version ${row.versionNo} is ${row.status} and cannot be edited. Every expense already claimed was worked out against it, so changing it would silently restate them — make a new version instead.`,
          ],
    };
  },
};
