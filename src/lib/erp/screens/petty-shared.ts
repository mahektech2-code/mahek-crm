import "server-only";
import { randomUUID } from "node:crypto";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { erpExpenseCategories } from "@/db/schema";
import type { ErpContext } from "../access";
import { erpLink } from "../registry";
import type { ActionSpec, FieldSpec } from "../ui";
import { PAYMENT_MODES_BY_FUND, type FundType } from "../engines/petty-cash";
import { fundAccounts, type FundRow } from "../petty/core";
import { godownOptions } from "./common";

/* ---------------------------------------------------------------------------
 * What the Petty cash tabs share: the options their forms offer, the way a
 * picked label is read back to an id, and a request key minted per form so a
 * retried submission is the same submission.
 * ------------------------------------------------------------------------- */

export const requestKey = () => randomUUID();

export const fundLabel = (f: Pick<FundRow, "name">) => f.name;

export type PettyLookups = {
  funds: FundRow[];
  fundByLabel: Map<string, FundRow>;
  godowns: { id: string; name: string }[];
  godownByName: Map<string, string>;
  categories: (typeof erpExpenseCategories.$inferSelect)[];
};

export async function lookups(ctx: ErpContext): Promise<PettyLookups> {
  const [funds, gds, cats] = await Promise.all([
    fundAccounts(),
    godownOptions(ctx, { lost: false }),
    db.select().from(erpExpenseCategories).orderBy(asc(erpExpenseCategories.sort), asc(erpExpenseCategories.name)),
  ]);
  return {
    funds,
    fundByLabel: new Map(funds.map((f) => [fundLabel(f), f])),
    godowns: gds.map((g) => ({ id: g.id, name: g.name })),
    godownByName: new Map(gds.map((g) => [g.name, g.id])),
    categories: cats,
  };
}

export const activeFunds = (l: PettyLookups, types?: FundType[]) => l.funds.filter((f) => f.status === "active" && (!types || types.includes(f.type)));

/** The payment-from fields every form that pays reuses: the fund, then the modes that fund pays by. */
export function paymentFields(l: PettyLookups, prefix = ""): FieldSpec[] {
  const funds = activeFunds(l);
  const modeMap: Record<string, string[]> = {};
  for (const f of funds) modeMap[fundLabel(f)] = PAYMENT_MODES_BY_FUND[f.type];
  return [
    { k: `${prefix}fund`, l: "Paid from", t: "select", opts: funds.map(fundLabel) },
    { k: `${prefix}mode`, l: "Mode", t: "select", optsBy: { by: `${prefix}fund`, map: modeMap } },
    { k: `${prefix}reference`, l: "UPI / UTR / cheque reference", t: "text" },
  ];
}

export const href = (key: string, open?: string | null) => erpLink(key, { open: open ?? null });

export const openExpense = (id: string): ActionSpec => ({ id: "open", l: "Open the expense", href: href("expenses", id) });

/** "Yes" boxes on a form come back as the option's text; anything else is no. */
export const yes = (v: string | undefined) => !!v && v !== "No" && v !== "";
