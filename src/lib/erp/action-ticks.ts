import type { ActionSpec, ListRow, ListSpec } from "./ui";

/* ---------------------------------------------------------------------------
 * WHICH TICK EACH PURCHASE ACTION NEEDS — Access, Edit or Delete on its page
 * (Manage access › ERP › Purchase › a page). ONE TABLE, read by the server
 * before it runs anything (`lib/actions/erp.ts`, `lib/actions/erp-quotes.ts`)
 * and by the list and record dialog that draw the actions
 * (`screens/index.ts` marks them on load), so what a menu offers and what the
 * server allows cannot disagree.
 *
 *   Access — open the page and do its ordinary work: raise, receive, record a
 *            test, print, read.
 *   Edit   — change what is there: edit a record, link or create its PO,
 *            share, approve, close short, verify, enter a rate or a bill.
 *   Delete — take it back: cancel, void, undo a purchase, reopen a verified lot.
 *
 * Anything not named here needs Access only. A grant not yet converted to the
 * screen model (`app_access.position` null) and an ERP administrator hold
 * every tick, so nothing moves for anybody until their grant is saved in
 * Manage access. Pure and client-safe.
 * ------------------------------------------------------------------------- */

export type Tick = "edit" | "delete";

type Rules = {
  /** Row actions and `erpRunAction` handlers, by id. */
  actions?: Record<string, Tick>;
  /** Forms (`erpSubmitForm`) and `loadsForm` actions, by id. `new` is Access. */
  forms?: Record<string, Tick>;
  /** Bulk actions over ticked rows (`erpRunBulk`), by id. */
  bulk?: Record<string, Tick>;
};

export const PURCHASE_TICKS: Readonly<Record<string, Rules>> = {
  requisitions: {
    actions: { edit: "edit", linkPo: "edit", unlinkPo: "edit", createPo: "edit", decide: "edit", vendor: "edit", cancel: "delete" },
    forms: { edit: "edit" },
    /* Create one PO over ticked requirements of one supplier: Create PO, for several at once. */
    bulk: { createOnePo: "edit" },
  },
  purchaseOrders: {
    actions: { edit: "edit", share: "edit", approve: "edit", sendBack: "edit", close: "edit", correctionRate: "edit", cancel: "delete", cancelCorrection: "delete" },
    forms: { edit: "edit" },
  },
  inward: {
    actions: { edit: "edit", void: "delete" },
    forms: { edit: "edit" },
    bulk: { editMany: "edit" },
  },
  testing: {
    actions: { verify: "edit", unverify: "edit" },
  },
  register: {
    actions: { edit: "edit", rate: "edit", billReceived: "edit", billNotReceived: "edit", status: "edit", aiBill: "edit", void: "delete", reopen: "delete" },
    forms: { edit: "edit", aiBill: "edit" },
    bulk: { billReceived: "edit", billNotReceived: "edit", rate: "edit", status: "edit", verifyMany: "edit", reopen: "delete" },
  },
};

/** The page each Purchase screen's ticks are read from — its own key. */
export const PAGE_LABEL: Readonly<Record<string, string>> = {
  requisitions: "Requirements",
  purchaseOrders: "Purchase orders",
  inward: "Goods in",
  testing: "Lot testing",
  register: "Bills",
  quoteManager: "Quotation manager",
  barcode: "Drum labels",
};

/** Somebody's ticks as the ERP reads them: undefined holds every tick. */
export type TickHolder = { administrator: boolean; ticks?: ReadonlyMap<string, { edit: boolean; delete: boolean }> };

export function holdsTick(ctx: TickHolder, screen: string, tick: Tick | undefined): boolean {
  if (!tick || ctx.administrator || !ctx.ticks) return true;
  const t = ctx.ticks.get(screen);
  return tick === "edit" ? !!t?.edit : !!t?.delete;
}

export function tickFor(screen: string, kind: keyof Rules, id: string): Tick | undefined {
  return PURCHASE_TICKS[screen]?.[kind]?.[id];
}

/** The sentence a held-back action says — in the record dialog, and when the server refuses it. */
export function tickWhy(screen: string, tick: Tick): string {
  return `Needs ${tick === "edit" ? "Edit" : "Delete"} on ${PAGE_LABEL[screen] ?? "this page"} — given in Manage access.`;
}

/** The tick a row action needs: a form it loads is judged as that form. */
export function actionTick(screen: string, a: Pick<ActionSpec, "id" | "loadsForm">): Tick | undefined {
  return tickFor(screen, "actions", a.id) ?? (a.loadsForm ? tickFor(screen, "forms", a.id) : undefined);
}

/**
 * Which block of a Purchase row's ⋯ menu an action is listed in: 0 — open it
 * and its ordinary work; 1 — changes (it needs Edit); 2 — take-backs (it needs
 * Delete), drawn last and in red. Read off the same table the server refuses
 * by, so the menu's order cannot drift from who may do what.
 */
export function menuBlock(screen: string, a: Pick<ActionSpec, "id" | "loadsForm">): 0 | 1 | 2 {
  const t = actionTick(screen, a);
  return t === "delete" ? 2 : t === "edit" ? 1 : 0;
}

/**
 * A list as one person may act on it: every row action they lack the tick
 * for is held back with the reason (the record dialog draws it locked) and
 * hidden from the row's menu; a bulk action they lack is removed.
 */
export function applyTicks<T extends { spec: ListSpec; rows: ListRow[] }>(ctx: TickHolder, screen: string, read: T): T {
  if (!PURCHASE_TICKS[screen] || ctx.administrator || !ctx.ticks) return read;
  const rows = read.rows.map((r) => {
    if (!r.actions?.length) return r;
    const actions = r.actions.map((a) => {
      const tick = actionTick(screen, a);
      return holdsTick(ctx, screen, tick) ? a : { ...a, why: tickWhy(screen, tick!), tickHidden: true };
    });
    return { ...r, actions };
  });
  const bulk = read.spec.bulk?.filter((b) => holdsTick(ctx, screen, tickFor(screen, "bulk", b.id)));
  return { ...read, rows, spec: bulk === read.spec.bulk ? read.spec : { ...read.spec, bulk } };
}

/**
 * The tick an op needs on the Quotation manager. Every change to the table is
 * Edit; taking something back — deleting a row, removing a column, undoing a
 * bought rate (the op that carries the impact confirmation) — is Delete.
 */
export function quoteOpTick(o: { op: string; impact?: unknown }): Tick {
  if (o.op === "deleteRow" || o.op === "archiveColumn") return "delete";
  if (o.op === "cell" && o.impact) return "delete";
  return "edit";
}
