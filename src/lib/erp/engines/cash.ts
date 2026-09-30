/* ---------------------------------------------------------------------------
 * Petty-cash arithmetic (spec §13.2.1), PURE.
 *
 * It shared a file with the order follow-up engine, which is gone: Mahek
 * Plus predicted each party's next order from its own order dates, and the
 * CRM already does that from the customer's measured buying cycle and puts
 * the call on a telecaller's list. Two predictions for one order was one too
 * many (ERP Simplification Plan, Phase 3).
 * ------------------------------------------------------------------------- */

export type CashLine = { employee: string; godownId: string; mode: string; amountPaise: number };

/**
 * What an employee still holds, per godown and mode: credits given less
 * expenses spent — by the person who SPENT it (spec §14 A-24), on both screens.
 */
export function cashBalances(credits: CashLine[], expenses: CashLine[]): Map<string, number> {
  const k = (l: CashLine) => `${l.employee.trim().toLowerCase()}|${l.godownId}|${l.mode}`;
  const out = new Map<string, number>();
  for (const c of credits) out.set(k(c), (out.get(k(c)) ?? 0) + c.amountPaise);
  for (const e of expenses) out.set(k(e), (out.get(k(e)) ?? 0) - e.amountPaise);
  return out;
}

export const cashKey = (employee: string, godownId: string, mode: string) => `${employee.trim().toLowerCase()}|${godownId}|${mode}`;
