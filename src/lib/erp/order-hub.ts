import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpOrderIntakeLines, erpOrderIntakes, erpOrderReviews, erpOrders, orders, users } from "@/db/schema";
import { notifyUsers } from "@/lib/notify";
import { err, ok, okVoid, type Result } from "@/lib/result";
import { erpId, nextNumber } from "./server";
import { erpLink } from "./registry";
import { bothChecked, intakeEditable, nextCheck, CHECK_LABEL, type Checker, type CheckKind } from "./engines/order-hub";

/* ---------------------------------------------------------------------------
 * THE ORDER HUB: every order is a TEMPORARY ORDER (a TO number) until the
 * back office and the Production Head have both checked it. The second check
 * makes the order number from the ERP's `order` series and writes the order
 * lines; from then on the order is not edited (see AGENTS.md, "The Order
 * Hub"). Rules are pure in `engines/order-hub.ts`; this is the wiring.
 *
 * Callable without an ERP context, because three doors open a TO: the ERP's
 * New order form, a TeleCRM call and the Salesman App.
 * ------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type IntakeLineInput = {
  skuId: string;
  qtyCans: number;
  ratePaise: number | null;
  discountBp: number | null;
  listRatePaise?: number | null;
  rateSetById?: string | null;
  rateSetAt?: Date | null;
  discountAuthorisedById?: string | null;
  remark?: string | null;
};

export type IntakeInput = {
  origin: "erp" | "crm" | "mbos";
  originOrderId?: string | null;
  orderSource: string | null;
  orderDate: string;
  godownId: string | null;
  billingId: string;
  deliveryId?: string | null;
  transporter?: string | null;
  dispatchOn?: string | null;
  remark?: string | null;
  inboxId?: string | null;
  takenById: string | null;
  lines: IntakeLineInput[];
};

export type Intake = typeof erpOrderIntakes.$inferSelect;
export type IntakeLine = typeof erpOrderIntakeLines.$inferSelect;

async function holdersOf(power: string): Promise<string[]> {
  const rows = (await db.execute(sql`select p.user_id as id from erp_user_powers p join users u on u.id = p.user_id where p.power = ${power} and u.active`)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

async function tell(userIds: (string | null | undefined)[], title: string, body: string, href: string, kind: "info" | "warn" = "info") {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  await notifyUsers(ids.map((userId) => ({ userId, title, body, href, kind }))).catch(() => undefined);
}

async function writeLines(tx: Tx, intakeId: string, lines: IntakeLineInput[]) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await tx.insert(erpOrderIntakeLines).values({
      id: erpId("toln"),
      intakeId,
      position: i,
      skuId: l.skuId,
      qtyCans: l.qtyCans,
      ratePaise: l.ratePaise,
      discountBp: l.discountBp,
      listRatePaise: l.listRatePaise ?? null,
      rateSetById: l.rateSetById ?? null,
      rateSetAt: l.rateSetAt ?? null,
      discountAuthorisedById: l.discountAuthorisedById ?? null,
      remark: l.remark ?? null,
    });
  }
}

/**
 * OPENS A TO. The number is the ERP's `tempOrder` series. Whoever checks a TO
 * is told one is waiting; nothing else in MahekOne sees it yet.
 */
export async function createIntake(userId: string, input: IntakeInput, outer?: Tx): Promise<{ id: string; toNo: number }> {
  if (!input.lines.length) throw new Error("A TO needs at least one line.");
  const id = erpId("to");
  let toNo = 0;
  const write = async (tx: Tx) => {
    toNo = await nextNumber(tx, "tempOrder");
    await tx.insert(erpOrderIntakes).values({
      id,
      toNo,
      origin: input.origin,
      originOrderId: input.originOrderId ?? null,
      orderSource: input.orderSource,
      orderDate: input.orderDate,
      godownId: input.godownId,
      billingCustomerId: input.billingId,
      deliveryCustomerId: input.deliveryId ?? input.billingId,
      transporter: input.transporter ?? null,
      dispatchOn: input.dispatchOn ?? null,
      remark: input.remark ?? null,
      inboxId: input.inboxId ?? null,
      takenById: input.takenById,
      createdById: userId,
      updatedById: userId,
    });
    await writeLines(tx, id, input.lines);
  };
  if (outer) await write(outer);
  else await db.transaction(write);
  if (!outer) await tellNewIntake(toNo);
  return { id, toNo };
}

/** After a TO is opened inside somebody else's transaction: the checkers are told. */
export async function tellNewIntake(toNo: number): Promise<void> {
  const [i] = await db
    .select({ name: sql<string>`(select name from customers where id = ${erpOrderIntakes.billingCustomerId})`, source: erpOrderIntakes.orderSource })
    .from(erpOrderIntakes)
    .where(eq(erpOrderIntakes.toNo, toNo));
  if (!i) return;
  const to = [...(await holdersOf("verifyOrders")), ...(await holdersOf("productionCheck"))];
  await tell(to, `New order to check · TO-${toNo}`, `${i.name}${i.source ? ` · ${i.source}` : ""}. The back office and the Production Head check it; the second check makes the order number.`, erpLink("orderHub"));
}

export async function intakeById(id: string): Promise<{ intake: Intake; lines: IntakeLine[] } | null> {
  const [intake] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.id, id));
  if (!intake) return null;
  const lines = await db.select().from(erpOrderIntakeLines).where(eq(erpOrderIntakeLines.intakeId, id)).orderBy(asc(erpOrderIntakeLines.position));
  return { intake, lines };
}

export async function intakeByOriginOrder(orderId: string): Promise<Intake | null> {
  const [i] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.originOrderId, orderId));
  return i ?? null;
}

/**
 * REWRITES A TO — header and lines, whole — while it is still a TO. An edit
 * is a different order from the one anybody checked, so both checks are
 * cleared and a TO that was sent back is waiting for its checks again.
 */
export async function editIntake(userId: string, id: string, header: Partial<Omit<IntakeInput, "lines" | "origin" | "originOrderId" | "takenById">>, lines: IntakeLineInput[] | null, opts: { syncOrigin?: boolean } = {}): Promise<Result<{ toNo: number }>> {
  const got = await intakeById(id);
  if (!got) return err("That TO no longer exists.", "not_found");
  const { intake } = got;
  if (!intakeEditable(intake.status)) return err(intake.status === "verified" ? `TO-${intake.toNo} has its order number (${intake.orderNo}), so it can no longer be changed.` : intake.status === "hold" ? `TO-${intake.toNo} is on hold; release it first.` : `TO-${intake.toNo} is cancelled.`, "rule_violation");
  if (lines && !lines.length) return err("A TO needs at least one line.");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(erpOrderIntakes)
      .set({
        ...(header.orderSource !== undefined ? { orderSource: header.orderSource } : {}),
        ...(header.orderDate !== undefined ? { orderDate: header.orderDate } : {}),
        ...(header.godownId !== undefined ? { godownId: header.godownId } : {}),
        ...(header.billingId !== undefined ? { billingCustomerId: header.billingId } : {}),
        ...(header.deliveryId !== undefined ? { deliveryCustomerId: header.deliveryId } : {}),
        ...(header.transporter !== undefined ? { transporter: header.transporter } : {}),
        ...(header.dispatchOn !== undefined ? { dispatchOn: header.dispatchOn } : {}),
        ...(header.remark !== undefined ? { remark: header.remark } : {}),
        status: "open",
        backOfficeById: null,
        backOfficeAt: null,
        backOfficeNote: null,
        productionById: null,
        productionAt: null,
        productionNote: null,
        updatedAt: new Date(),
        updatedById: userId,
      })
      .where(and(eq(erpOrderIntakes.id, id), inArray(erpOrderIntakes.status, ["open", "correction"])))
      .returning({ id: erpOrderIntakes.id });
    if (!row) throw new Error("conflict");
    if (lines) {
      await tx.delete(erpOrderIntakeLines).where(eq(erpOrderIntakeLines.intakeId, id));
      await writeLines(tx, id, lines);
    }
  });
  /* A TeleCRM or handset TO: its `orders` row says what the TO now says. The
     handset's own edit has already rewritten that row in its transaction. */
  if (intake.originOrderId && opts.syncOrigin !== false) {
    const { syncOriginOrderFromIntake } = await import("./book");
    await syncOriginOrderFromIntake(id);
  }
  if (intake.status === "correction") await tellNewIntake(intake.toNo);
  return ok({ toNo: intake.toNo });
}

/**
 * ONE OF THE TWO CHECKS. Which one is the engine's to say (`nextCheck`); the
 * second makes the order number, in the same transaction, so a TO is never
 * left checked twice with no order behind it.
 */
export async function checkIntake(who: Checker, id: string, note: string | null): Promise<Result<{ check: CheckKind; orderNo: number | null; toNo: number }>> {
  const got = await intakeById(id);
  if (!got) return err("That TO no longer exists.", "not_found");
  const { intake, lines } = got;
  const next = nextCheck(intake, who);
  if (!next.ok) return err(`TO-${intake.toNo}: ${next.why}.`, "rule_violation");
  if (!intake.godownId) return err(`TO-${intake.toNo} has no godown. Edit it and pick the godown that sends it.`, "rule_violation");
  const noRate = lines.filter((l) => l.ratePaise == null).length;
  if (noRate) return err(`TO-${intake.toNo} has ${noRate} line${noRate === 1 ? "" : "s"} with no rate. Edit it and add the rate: once it has its order number it cannot be changed.`, "rule_violation");
  const stamp = next.check === "production" ? { productionById: who.userId, productionAt: new Date(), productionNote: note } : { backOfficeById: who.userId, backOfficeAt: new Date(), backOfficeNote: note };
  const after = { ...intake, ...stamp };
  let orderNo: number | null = null;
  const conflict = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(erpOrderIntakes)
      .set({ ...stamp, updatedAt: new Date(), updatedById: who.userId })
      .where(and(eq(erpOrderIntakes.id, id), eq(erpOrderIntakes.status, "open"), next.check === "production" ? sql`${erpOrderIntakes.productionById} is null` : sql`${erpOrderIntakes.backOfficeById} is null`))
      .returning({ id: erpOrderIntakes.id });
    if (!row) return true;
    if (bothChecked(after)) orderNo = await makeOrder(tx, after, lines, who.userId);
    return false;
  });
  if (conflict) return err(`TO-${intake.toNo} changed while you were looking at it. Open it again.`, "conflict");
  if (orderNo != null) await afterOrderMade(orderNo, after);
  return ok({ check: next.check, orderNo, toNo: intake.toNo });
}

/**
 * THE ORDER NUMBER. The TO's lines become `erp_orders` lines — verified, since
 * that is what the two checks were, and waiting for Accounts and for the
 * Production Head's MRP clearance. A TO taken on a call or on the Salesman
 * App already has its `orders` row in the book; that row is adopted under the
 * order number, so the order is counted once.
 */
async function makeOrder(tx: Tx, intake: Intake, lines: IntakeLine[], userId: string): Promise<number> {
  const no = await nextNumber(tx, "order");
  /* A Pending party (`partyStatus` in masters) is still marked, as the New order form always did. */
  const [party] = (await tx.execute(sql`select coalesce(p.pending_activation, false) as pending from customers c left join erp_customer_profiles p on p.customer_id = c.id where c.id = ${intake.billingCustomerId}`)) as unknown as { pending: boolean }[];
  const pending = !!party?.pending;
  const by = intake.takenById ?? intake.createdById ?? userId;
  for (const l of lines)
    await tx.insert(erpOrders).values({
      id: `ODID-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      orderNo: no,
      orderDate: intake.orderDate,
      godownId: intake.godownId!,
      billingCustomerId: intake.billingCustomerId,
      deliveryCustomerId: intake.deliveryCustomerId ?? intake.billingCustomerId,
      transporter: intake.transporter,
      skuId: l.skuId,
      qtyCans: l.qtyCans,
      ratePaise: l.ratePaise,
      discountBp: l.discountBp,
      listRatePaise: l.listRatePaise,
      rateSetById: l.rateSetById,
      rateSetAt: l.rateSetAt,
      discountAuthorisedById: l.discountAuthorisedById,
      remark: l.remark,
      partyStatus: pending ? "Pending" : null,
      dispatchOn: intake.dispatchOn,
      orderSource: intake.orderSource,
      orderCheck: "Verified",
      orderCheckedById: userId,
      orderCheckedAt: new Date(),
      intakeId: intake.id,
      accountsCheck: "Pending",
      productionCheck: "Pending",
      createdById: by,
      updatedById: userId,
    });
  await tx.insert(erpOrderReviews).values({ id: erpId("orv"), orderNo: no, kind: "order", result: "verified", note: `TO-${intake.toNo} checked by the back office and the Production Head`, snapshot: { toNo: intake.toNo }, byId: userId });
  await tx.update(erpOrderIntakes).set({ status: "verified", orderNo: no, updatedAt: new Date(), updatedById: userId }).where(eq(erpOrderIntakes.id, intake.id));
  if (intake.originOrderId) await tx.update(orders).set({ externalRef: `ERP-${no}`, updatedAt: new Date() }).where(eq(orders.id, intake.originOrderId));
  return no;
}

async function afterOrderMade(orderNo: number, intake: Intake) {
  const { syncBookOrders } = await import("./book");
  await syncBookOrders([orderNo]);
  if (intake.inboxId) {
    await db.execute(sql`update erp_order_inbox set status = 'Converted', order_no = ${orderNo}, decided_at = now() where id = ${intake.inboxId} and status = 'New'`).catch(() => undefined);
  }
  await tell([intake.takenById], `Order ${orderNo} made from TO-${intake.toNo}`, "Both checks are done. It is with Accounts for approval, and it can no longer be changed.", erpLink("orders", { f: "", fl: `Order ${orderNo}` }));
}

/** Sends a TO back to whoever took it, with the reason; both checks start again after their edit. */
export async function sendBackIntake(userId: string, id: string, note: string): Promise<Result<unknown>> {
  if (!note.trim()) return err("Say what needs correcting.", "validation");
  const got = await intakeById(id);
  if (!got) return err("That TO no longer exists.", "not_found");
  if (got.intake.status !== "open") return err(`TO-${got.intake.toNo} is not waiting for checks.`, "rule_violation");
  await db
    .update(erpOrderIntakes)
    .set({ status: "correction", correctionNote: note.trim(), correctionById: userId, correctionAt: new Date(), backOfficeById: null, backOfficeAt: null, productionById: null, productionAt: null, updatedAt: new Date(), updatedById: userId })
    .where(and(eq(erpOrderIntakes.id, id), eq(erpOrderIntakes.status, "open")));
  await tell([got.intake.takenById], `Correct TO-${got.intake.toNo}`, note.trim(), erpLink("hubCorrection"), "warn");
  return okVoid(`TO-${got.intake.toNo} sent back for correction`);
}

/** Holds a TO at the hub (order verification). Releasing it asks both checks again. */
export async function holdIntake(userId: string, id: string, reason: string, note: string | null): Promise<Result<unknown>> {
  if (!reason.trim()) return err("Pick the reason.", "validation");
  const got = await intakeById(id);
  if (!got) return err("That TO no longer exists.", "not_found");
  if (!intakeEditable(got.intake.status)) return err(`TO-${got.intake.toNo} cannot be held now.`, "rule_violation");
  await db
    .update(erpOrderIntakes)
    .set({ status: "hold", holdReason: reason.trim(), holdNote: note?.trim() || null, heldById: userId, heldAt: new Date(), updatedAt: new Date(), updatedById: userId })
    .where(eq(erpOrderIntakes.id, id));
  await tell([got.intake.takenById], `TO-${got.intake.toNo} is on hold`, `${reason}${note ? ` — ${note}` : ""}`, erpLink("toHold"), "warn");
  return okVoid(`TO-${got.intake.toNo} is on hold`);
}

export async function releaseIntake(userId: string, id: string, note: string | null): Promise<Result<unknown>> {
  const got = await intakeById(id);
  if (!got) return err("That TO no longer exists.", "not_found");
  if (got.intake.status !== "hold") return err(`TO-${got.intake.toNo} is not on hold.`, "rule_violation");
  await db
    .update(erpOrderIntakes)
    .set({
      status: "open",
      holdNote: [got.intake.holdNote, note?.trim() ? `Released: ${note.trim()}` : "Released"].filter(Boolean).join(" · "),
      backOfficeById: null,
      backOfficeAt: null,
      productionById: null,
      productionAt: null,
      updatedAt: new Date(),
      updatedById: userId,
    })
    .where(and(eq(erpOrderIntakes.id, id), eq(erpOrderIntakes.status, "hold")));
  await tellNewIntake(got.intake.toNo);
  return okVoid(`TO-${got.intake.toNo} released · back to the Order Hub for both checks`);
}

/** Cancels a TO. One taken on a call or the Salesman App takes its `orders` row with it. */
export async function cancelIntake(userId: string, id: string, reason: string): Promise<Result<unknown>> {
  if (!reason.trim()) return err("Say why it is cancelled.", "validation");
  const got = await intakeById(id);
  if (!got) return err("That TO no longer exists.", "not_found");
  if (got.intake.status === "verified") return err(`TO-${got.intake.toNo} has its order number ${got.intake.orderNo}; cancel the order instead.`, "rule_violation");
  if (got.intake.status === "cancelled") return err(`TO-${got.intake.toNo} is already cancelled.`, "rule_violation");
  await db.transaction(async (tx) => {
    await tx.update(erpOrderIntakes).set({ status: "cancelled", cancelReason: reason.trim(), cancelledById: userId, cancelledAt: new Date(), updatedAt: new Date(), updatedById: userId }).where(eq(erpOrderIntakes.id, id));
    if (got.intake.originOrderId) await tx.update(orders).set({ status: "cancelled", cancelledAt: new Date(), declineReason: reason.trim(), updatedAt: new Date() }).where(eq(orders.id, got.intake.originOrderId));
  });
  if (got.intake.originOrderId) {
    const { recomputeBuyingCycle } = await import("@/lib/recompute");
    await recomputeBuyingCycle(got.intake.billingCustomerId).catch(() => undefined);
  }
  if (got.intake.takenById && got.intake.takenById !== userId) await tell([got.intake.takenById], `TO-${got.intake.toNo} cancelled`, reason.trim(), erpLink("orderHub"), "warn");
  return okVoid(`TO-${got.intake.toNo} cancelled`);
}

/** The names of the people on a set of TOs, for the screens. */
export async function peopleNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, want));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export { CHECK_LABEL };
