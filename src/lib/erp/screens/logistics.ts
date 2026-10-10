import "server-only";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { complaints, customers, employees, erpCredits, erpExpenses, erpGodowns, erpOrderDetails, erpTransports, erpVideos, users } from "@/db/schema";
import { categoryLabel } from "@/lib/complaint-labels";
import { complaintRows, requestStatus } from "./complaints";
import { calendarDate } from "@/lib/business-date";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { bindErpFiles } from "../attachments";
import { erpAudit, erpId, multi, paise, rupeesField, stampLine, text, visibleCols, withoutHidden, type ScreenModule } from "../server";
import type { ActionSpec, BulkSpec, CellValue, ColSpec, FieldSpec, FormSpec, ListRow } from "../ui";
import { fd, inr } from "../ui";
import { cashBalances, cashKey } from "../engines/cash";
import { monthId } from "../engines/sales";
import { refValues } from "../refs";
import { godownIdByName, godownOptions, has, today, type Col } from "./common";
import { customerForm, loadCustomers, phoneContacts, saveCustomerDetails } from "./masters";
import { detailRows } from "./sales";
import { syncBookOrders } from "../book";

/* ---------------------------------------------------------------------------
 * Logistics, customer requests and credit notes, order follow-up, petty cash,
 * my customers and help videos (spec §12–§13).
 * ------------------------------------------------------------------------- */

/**
 * Where a consignment is. Mahek Plus's first two were "Dispatch from Bhiwandi"
 * and "Dispatch from Ambernath" — a godown written into the list, so a third
 * godown needed a code change (spec A-26). It is one "Dispatched" stage now,
 * and the screen names the godown from the order.
 */
export const MATERIAL_STAGES = ["Dispatched", "In Transit", "On the way to Destination area", "Reached Destination Area", "Close - Received to Party"];
const CLOSED = "Close - Received to Party";

/**
 * On the road: it has an LR and has not reached the party. Mahek Plus asked for
 * "Track / Don't Track" as well, which could only ever agree with these two
 * facts or contradict them.
 */
export const onTheRoad = (t: { lrNo: string | null; materialStage: string }) => !!t.lrNo && t.materialStage !== CLOSED;
const MODES = ["Bank Cash", "Cash", "Other"];

/* ============================================================ transport */

type TransportScope = "transport" | "pendingLr" | "trackLr";

function transportList(scope: TransportScope): ScreenModule {
  return {
    key: scope,
    async load(ctx) {
      const [rows, details] = await Promise.all([
        db
          .select({ t: erpTransports, party: customers.name, salesPerson: customers.salesPersonName, by: users.name })
          .from(erpTransports)
          .innerJoin(customers, eq(customers.id, erpTransports.billingCustomerId))
          .leftJoin(users, eq(users.id, erpTransports.updatedById))
          .orderBy(desc(erpTransports.billDate), desc(erpTransports.orderNo)),
        detailRows(),
      ]);
      const shown = rows.filter((r) => (scope === "pendingLr" ? !r.t.lrNo : scope === "trackLr" ? onTheRoad(r.t) : true));
      /* The godown a bill left from, for "Dispatched from …". */
      const from = new Map(
        ((await db.execute(sql`select o.order_no as n, min(g.name) as g from erp_orders o join erp_godowns g on g.id = o.godown_id group by o.order_no`)) as unknown as { n: number; g: string }[]).map((x) => [Number(x.n), x.g]),
      );
      const stageWord = (t: typeof rows[number]["t"]) => (t.materialStage === "Dispatched" && from.get(t.orderNo) ? `Dispatched from ${from.get(t.orderNo)}` : t.materialStage);
      const { featureState, pendingFor } = await import("../ai");
      const pendingLr = await pendingFor("photos");
      const photosOn = (await featureState("photos", true)).on;
      const all: Col[] = [
        { k: "orderNo", l: "Order no", t: "mono" },
        { k: "billDate", l: "Bill date", t: "d" },
        { k: "party", l: "Billing party", t: "b" },
        { k: "billNo", l: "Bill no", t: "mono" },
        { k: "lr", l: "LR no", t: "mono" },
        { k: "transporter", l: "Transporter", t: "t" },
        { k: "area", l: "Area", t: "t" },
        { k: "track", l: "On the road", t: "s" },
        { k: "payment", l: "Payment type", t: "s" },
        { k: "extra", l: "Extra expense", t: "m" },
        { k: "note", l: "Note", t: "t" },
        { k: "stage", l: "Material stage", t: "s" },
        { k: "reminder", l: "Reminder call", t: "d" },
        { k: "salesMan", l: "Tag sales man", t: "t" },
        { k: "monthly", l: "Monthly sales", t: "m", pw: "viewSalesAmounts" },
      ];
      const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
      const monthly = details.monthly;
      return {
        spec: {
          screen: scope,
          cols,
          hidden,
          groups: scope === "transport" ? ["billDate"] : ["transporter"],
          readOnly: false,
          noDataLine:
            scope === "pendingLr" ? "Every dispatched bill has its LR number." : scope === "trackLr" ? "No consignment is being tracked." : "Nothing dispatched yet. A bill appears here once its first line is dispatch-verified.",
        },
        rows: shown.map((r): ListRow => {
          const t = r.t;
          const mid = monthId(t.billDate);
          return {
            id: t.id,
            v: withoutHidden(
              {
                orderNo: String(t.orderNo),
                billDate: t.billDate,
                party: r.party,
                billNo: t.billNo,
                lr: t.lrNo,
                transporter: t.transporter,
                area: t.area,
                track: onTheRoad(t) ? "Yes" : "No",
                payment: t.paymentType,
                extra: t.paymentType === "Paid" ? t.extraExpensePaise : null,
                note: t.note,
                stage: stageWord(t),
                reminder: t.reminderDate,
                salesMan: r.salesPerson,
                monthly: mid ? (monthly.get(`${mid}|${t.billingCustomerId}`) ?? 0) : null,
              } as Record<string, CellValue>,
              hiddenKeys,
            ),
            flags: t.reminderDate && t.reminderDate <= today() && t.materialStage !== "Close - Received to Party" ? ["today"] : [],
            title: `${r.party} · bill ${t.billNo ?? t.orderNo}`,
            header: `${t.transporter ?? "No transporter"} · ${stageWord(t)}`,
            actions: [
              ...(pendingLr.has(t.id)
                ? [
                    { id: "aiLr", l: "Review LR reading", ai: true, primary: true, loadsForm: true } as ActionSpec,
                    { id: "aiLrReject", l: "Reject LR reading", confirm: "Reject the AI reading of this LR? Nothing changes." } as ActionSpec,
                  ]
                : photosOn && !t.lrNo
                  ? [{ id: "aiLrRead", l: "Read LR photo", ai: true, prompt: { title: "Photograph the lorry receipt", sub: "The LR number is read and checked against this bill; you confirm it before it is saved.", submit: "Read the LR", fields: [{ k: "photo", l: "LR photo", t: "photo" as const, req: true }] } } as ActionSpec]
                  : []),
              {
                id: "update",
                l: t.lrNo ? "Update consignment" : "Enter LR",
                primary: true,
                prompt: {
                  title: t.lrNo ? "Update the consignment" : "Enter the LR number",
                  sub: `${r.party} · bill ${t.billNo ?? "—"}`,
                  submit: "Save",
                  fields: [
                    { k: "lr", l: "Despatch LR no", t: "text" },
                    { k: "stage", l: "Material stage", t: "select", req: true, opts: MATERIAL_STAGES },
                    { k: "reminder", l: "Reminder call", t: "date" },
                    { k: "note", l: "Note", t: "area", mic: true },
                  ],
                  init: { lr: t.lrNo ?? "", stage: MATERIAL_STAGES.includes(t.materialStage) ? t.materialStage : "Dispatched", reminder: t.reminderDate ?? "", note: t.note ?? "" },
                },
              },
            ],
            by: stampLine(r.by, t.updatedAt).replace(/^Created/, "Updated"),
          };
        }),
      };
    },
    formLoaders: {
      aiLr: async (_ctx, id) => (await import("../ai-photos")).lrReviewForm(scope, id),
    },
    forms: {
      aiLr: async (ctx, h, _l, suggestionId) => (suggestionId ? (await import("../ai-photos")).applyLr(ctx, suggestionId, h) : err("No reading named.", "not_found")),
    },
    actions: {
      aiLrRead: async (ctx, id, v) => (await import("../ai-photos")).readLr(ctx, id, text(v.photo)),
      aiLrReject: async (ctx, id) => (await import("../ai-photos")).rejectPhotoReading(ctx, id),
      async update(ctx, id, values) {
        const stage = text(values.stage);
        if (!stage || !MATERIAL_STAGES.includes(stage)) return fieldErr("stage", "Material stage is required");
        const lr = text(values.lr);
        const track = onTheRoad({ lrNo: lr, materialStage: stage }) ? "Track" : "Don't Track";
        const [before] = await db.select().from(erpTransports).where(eq(erpTransports.id, id));
        if (!before) return err("That bill is not in transport follow-up.", "not_found");
        const after = { lrNo: lr, trackStatus: track, materialStage: stage, reminderDate: text(values.reminder), note: text(values.note), updatedAt: new Date(), updatedById: ctx.user.id };
        await db.update(erpTransports).set(after).where(eq(erpTransports.id, id));
        await erpAudit(ctx, "erp.transport.update", "erp_transport", id, before, after);
        /* Where the goods are is what everybody else reads the order for. */
        if (stage !== before.materialStage) await syncBookOrders([before.orderNo]);
        return okVoid(lr && !before.lrNo ? `LR ${lr} recorded` : "Consignment updated");
      },
    },
  };
}

/** Paid-freight detail lines still without their extra expense (spec §12.1 "Transportation Paid"). */
const paidFreight: ScreenModule = {
  key: "paidFreight",
  async load(ctx) {
    const { rows } = await detailRows();
    const shown = rows.filter((r) => r.l.billing.freightTerm === "Paid" && r.d.extraExpensesPaise == null);
    const cols: ColSpec[] = [
      { k: "party", l: "Billing party", t: "b" },
      { k: "extra", l: "Extra expenses", t: "m" },
      { k: "sku", l: "Description of goods", t: "t", w: 240 },
      { k: "litres", l: "Litres", t: "n" },
      { k: "payment", l: "Payment type", t: "s" },
      { k: "transporter", l: "Transporter", t: "t" },
    ];
    const bulk: BulkSpec[] = [{ id: "extra", l: "Extra Expenses", prompt: { title: "Enter Extra Expenses", submit: "Save", fields: [{ k: "amount", l: "Extra expenses (₹)", t: "num", req: true, min: 0 }] } }];
    void ctx;
    return {
      spec: { screen: "paidFreight", cols, hidden: [], groups: ["transporter"], agg: { k: "extra", l: "extra expenses" }, bulk, noDataLine: "Every paid-freight line has its extra expense." },
      rows: shown.map((r) => ({
        id: r.l.o.id,
        v: { party: r.l.billing.name, extra: r.d.extraExpensesPaise, sku: r.l.sku.name, litres: r.litres, payment: r.l.billing.freightTerm, transporter: r.l.o.transporter ?? r.l.delivery.p?.transporter ?? "—" },
        flags: [],
        title: `${r.l.billing.name} · order ${r.l.o.orderNo}`,
        actions: [{ id: "extra", l: "Extra Expenses", primary: true, prompt: { title: "Enter Extra Expenses", submit: "Save", fields: [{ k: "amount", l: "Extra expenses (₹)", t: "num", req: true, min: 0 }] } }],
      })),
    };
  },
  actions: { extra: (ctx, id, v) => setExtra(ctx, [id], v) },
  bulk: { extra: (ctx, ids, v) => setExtra(ctx, ids, v) },
};

async function setExtra(ctx: ErpContext, ids: string[], values: Record<string, string>): Promise<Result<unknown>> {
  const amount = paise(values.amount);
  if (amount == null || amount < 0) return fieldErr("amount", "Extra expenses are required");
  const res = await db
    .update(erpOrderDetails)
    .set({ extraExpensesPaise: amount, updatedAt: new Date(), updatedById: ctx.user.id })
    .where(and(inArray(erpOrderDetails.orderId, ids), sql`${erpOrderDetails.extraExpensesPaise} is null`))
    .returning({ id: erpOrderDetails.orderId });
  if (!res.length) return err("Extra expenses are already entered on these lines.", "rule_violation");
  /* The bill's transport record carries the same figure, copied when it opened. */
  await db.execute(sql`update erp_transports t set extra_expense_paise = ${amount} where t.id in ${ids} and t.extra_expense_paise is null`);
  await erpAudit(ctx, "erp.detail.extra", "erp_order_detail", res.map((r) => r.id).join(","), null, { amount });
  return okVoid(`Extra expenses on ${res.length} line${res.length === 1 ? "" : "s"}`);
}

/** Active employees from HRMS: who can be given petty cash or spend it. */
async function activeEmployees(): Promise<{ name: string; position: string | null }[]> {
  return db.select({ name: employees.name, position: employees.position }).from(employees).where(eq(employees.status, "active")).orderBy(asc(employees.name));
}

/* ============================================================ petty cash */

async function balances() {
  const [credits, expenses] = await Promise.all([db.select().from(erpCredits), db.select().from(erpExpenses)]);
  return cashBalances(
    credits.map((c) => ({ employee: c.employeeName, godownId: c.godownId, mode: c.mode, amountPaise: c.amountPaise })),
    expenses.map((e) => ({ employee: e.expenseBy, godownId: e.godownId, mode: e.mode, amountPaise: e.amountPaise })),
  );
}

async function staffNames(ctx: ErpContext): Promise<string[]> {
  const names = (await activeEmployees()).map((e) => e.name);
  return names.includes(ctx.user.name) ? names : [ctx.user.name, ...names];
}

async function cashForm(ctx: ErpContext, kind: "credit" | "expense"): Promise<FormSpec> {
  const [gds, names, notes, cats, parts] = await Promise.all([
    godownOptions(ctx, { lost: false }),
    staffNames(ctx),
    refValues("creditNote"),
    refValues("expenseCategory"),
    refValues("expenseParticular"),
  ]);
  const common: FieldSpec[] = [
    { k: "date", l: "Date", t: "date", req: true },
    { k: "godown", l: "Godown", t: "select", req: true, opts: gds.map((g) => g.name) },
    { k: "who", l: kind === "credit" ? "Employee" : "Expense by", t: "select", req: true, opts: names },
    { k: "mode", l: kind === "credit" ? "Credit mode" : "Expense mode", t: "select", req: true, opts: MODES },
  ];
  return kind === "credit"
    ? {
        screen: "credits",
        id: "new",
        title: "Give funds",
        submit: "Save credit",
        init: { date: today(), godown: ctx.workingGodown?.name ?? "", who: ctx.user.name },
        header: [...common, { k: "amount", l: "Credit amount (₹)", t: "num", req: true, min: 0.01 }, { k: "note", l: "Credit note", t: "select", opts: notes }],
      }
    : {
        screen: "expenses",
        id: "new",
        title: "New expense",
        submit: "Save expense",
        init: { date: today(), godown: ctx.workingGodown?.name ?? "", who: ctx.user.name },
        header: [
          ...common,
          { k: "category", l: "Category", t: "select", opts: cats },
          { k: "particular", l: "Particular", t: "select", opts: parts },
          { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
          { k: "note", l: "Expense note", t: "area", mic: true },
        ],
      };
}

const credits: ScreenModule = {
  key: "credits",
  async load(ctx) {
    const [rows, bal] = await Promise.all([
      db.select({ c: erpCredits, godown: erpGodowns.name, by: users.name }).from(erpCredits).innerJoin(erpGodowns, eq(erpGodowns.id, erpCredits.godownId)).leftJoin(users, eq(users.id, erpCredits.createdById)).orderBy(desc(erpCredits.creditDate), desc(erpCredits.createdAt)),
      balances(),
    ]);
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "amount", l: "Amount", t: "m" },
      { k: "note", l: "Credit note", t: "t" },
      { k: "available", l: "Available", t: "m" },
      { k: "who", l: "Employee", t: "b" },
      { k: "mode", l: "Mode", t: "s" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "id", l: "Credit id", t: "mono" },
    ];
    return {
      spec: { screen: "credits", cols, hidden: [], groups: ["godown", "mode"], godownKey: "godown", newForm: await cashForm(ctx, "credit"), newLabel: "Give funds", noDataLine: "No funds given yet." },
      rows: rows.map((r) => {
        const available = bal.get(cashKey(r.c.employeeName, r.c.godownId, r.c.mode)) ?? 0;
        return {
          id: r.c.id,
          v: { date: r.c.creditDate, amount: r.c.amountPaise, note: r.c.note, available, who: r.c.employeeName, mode: r.c.mode, godown: r.godown, id: r.c.id },
          flags: [],
          title: `${r.c.employeeName} · ${inr(r.c.amountPaise)}`,
          header: `${inr(available)} available · ${r.c.mode}`,
          actions: [{ id: "mode", l: "Change mode", prompt: { title: "Credit mode", submit: "Save", fields: [{ k: "mode", l: "Mode", t: "select", req: true, opts: MODES }], init: { mode: r.c.mode } } }],
          by: stampLine(r.by, r.c.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const godownId = await godownIdByName(text(h.godown));
      if (!godownId) return fieldErr("godown", "Godown is required");
      const who = text(h.who);
      if (!who) return fieldErr("who", "Employee is required");
      const mode = text(h.mode);
      if (!mode || !MODES.includes(mode)) return fieldErr("mode", "Credit mode is required");
      const amount = paise(h.amount);
      if (amount == null || amount <= 0) return fieldErr("amount", "Credit amount is required");
      const id = erpId("cr");
      await db.insert(erpCredits).values({ id, creditDate: text(h.date) ?? today(), godownId, employeeName: who, mode, amountPaise: amount, note: text(h.note), createdById: ctx.user.id });
      await erpAudit(ctx, "erp.credit.create", "erp_credit", id, null, { who, amount, mode });
      return okVoid(`${inr(amount)} given to ${who}`);
    },
  },
  actions: {
    async mode(ctx, id, v) {
      const mode = text(v.mode);
      if (!mode || !MODES.includes(mode)) return fieldErr("mode", "Mode is required");
      await db.update(erpCredits).set({ mode, updatedAt: new Date() }).where(eq(erpCredits.id, id));
      await erpAudit(ctx, "erp.credit.mode", "erp_credit", id, null, { mode });
      return okVoid("Mode changed");
    },
  },
};

const expenses: ScreenModule = {
  key: "expenses",
  async load(ctx) {
    const [rows, bal] = await Promise.all([
      db.select({ e: erpExpenses, godown: erpGodowns.name, by: users.name }).from(erpExpenses).innerJoin(erpGodowns, eq(erpGodowns.id, erpExpenses.godownId)).leftJoin(users, eq(users.id, erpExpenses.createdById)).orderBy(desc(erpExpenses.expenseDate), desc(erpExpenses.createdAt)),
      balances(),
    ]);
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "particular", l: "Particular", t: "b" },
      { k: "amount", l: "Amount", t: "m" },
      { k: "note", l: "Note", t: "t" },
      { k: "available", l: "Available", t: "m" },
      { k: "mode", l: "Mode", t: "s" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "status", l: "Status", t: "s" },
      { k: "who", l: "Expense by", t: "t" },
    ];
    const verifier = ctx.administrator || ctx.level === "manager";
    return {
      spec: {
        screen: "expenses",
        cols,
        hidden: [],
        groups: ["godown", "mode"],
        agg: { k: "available", l: "average available", t: "avg" },
        chips: "status",
        godownKey: "godown",
        bulk: verifier ? [{ id: "verify", l: "Verify" }] : undefined,
        newForm: await cashForm(ctx, "expense"),
        newLabel: "New expense",
        noDataLine: "No expenses yet.",
      },
      rows: rows.map((r) => {
        const available = bal.get(cashKey(r.e.expenseBy, r.e.godownId, r.e.mode)) ?? 0;
        return {
          id: r.e.id,
          v: { date: r.e.expenseDate, particular: r.e.particular ?? r.e.category ?? "Expense", amount: r.e.amountPaise, note: r.e.note, available, mode: r.e.mode, godown: r.godown, status: r.e.status, who: r.e.expenseBy },
          flags: available < 0 ? ["below"] : [],
          title: `${r.e.particular ?? "Expense"} · ${inr(r.e.amountPaise)}`,
          header: `${inr(available)} available · ${r.e.mode}`,
          fields: [{ l: "Category", v: r.e.category ?? "—" }],
          actions: [
            ...(r.e.status !== "Verify" ? [{ id: "verify", l: "Verify", primary: true, why: verifier ? "" : "A manager verifies expenses" } as ActionSpec] : [{ id: "pending", l: "Back to Pending", why: verifier ? "" : "A manager verifies expenses" } as ActionSpec]),
            { id: "amount", l: "Change amount", why: r.e.status === "Verify" ? "A verified expense is closed" : "", prompt: { title: "Amount", submit: "Save", fields: [{ k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 }], init: { amount: rupeesField(r.e.amountPaise) } } },
          ],
          by: stampLine(r.by, r.e.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const godownId = await godownIdByName(text(h.godown));
      if (!godownId) return fieldErr("godown", "Godown is required");
      const who = text(h.who);
      if (!who) return fieldErr("who", "Expense by is required");
      const mode = text(h.mode);
      if (!mode || !MODES.includes(mode)) return fieldErr("mode", "Expense mode is required");
      const amount = paise(h.amount);
      if (amount == null || amount <= 0) return fieldErr("amount", "Amount is required");
      const id = erpId("exp");
      await db.insert(erpExpenses).values({ id, expenseDate: text(h.date) ?? today(), godownId, expenseBy: who, category: text(h.category), mode, particular: text(h.particular), amountPaise: amount, note: text(h.note), createdById: ctx.user.id, updatedById: ctx.user.id });
      await erpAudit(ctx, "erp.expense.create", "erp_expense", id, null, { who, amount, mode });
      const bal = (await balances()).get(cashKey(who, godownId, mode)) ?? 0;
      return okVoid(`Expense saved · ${inr(bal)} left with ${who}${bal < 0 ? " — more spent than given" : ""}`);
    },
  },
  actions: {
    verify: (ctx, id) => setExpenseStatus(ctx, [id], "Verify"),
    pending: (ctx, id) => setExpenseStatus(ctx, [id], "Pending"),
    async amount(ctx, id, v) {
      const amount = paise(v.amount);
      if (amount == null || amount <= 0) return fieldErr("amount", "Amount is required");
      const [e] = await db.select().from(erpExpenses).where(eq(erpExpenses.id, id));
      if (!e) return err("That expense no longer exists.", "not_found");
      if (e.status === "Verify") return err("A verified expense is closed.", "rule_violation");
      await db.update(erpExpenses).set({ amountPaise: amount, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpExpenses.id, id));
      await erpAudit(ctx, "erp.expense.amount", "erp_expense", id, { amountPaise: e.amountPaise }, { amountPaise: amount });
      return okVoid("Amount changed");
    },
  },
  bulk: { verify: (ctx, ids) => setExpenseStatus(ctx, ids, "Verify") },
};

async function setExpenseStatus(ctx: ErpContext, ids: string[], status: "Verify" | "Pending"): Promise<Result<unknown>> {
  if (!(ctx.administrator || ctx.level === "manager")) return err("A manager verifies expenses.", "not_permitted");
  await db.update(erpExpenses).set({ status, updatedAt: new Date(), updatedById: ctx.user.id }).where(inArray(erpExpenses.id, ids));
  await erpAudit(ctx, `erp.expense.${status.toLowerCase()}`, "erp_expense", ids.join(","));
  return okVoid(`${ids.length} expense${ids.length === 1 ? "" : "s"} ${status === "Verify" ? "verified" : "back to Pending"}`);
}

/* ========================================================= my customers */

const myCustomers: ScreenModule = {
  key: "myCustomers",
  async load(ctx) {
    const mine = await loadCustomers(or(eq(customers.salesAmId, ctx.user.id), sql`lower(${customers.salesPersonName}) = lower(${ctx.user.name})`));
    const ids = mine.map((c) => c.id);
    /* Their complaints are the CRM's complaints: one record, whichever app raised it. */
    const reqs = ids.length ? await complaintRows(inArray(complaints.customerId, ids)) : [];
    const reqBy = new Map<string, number>();
    reqs.forEach((r) => reqBy.set(r.c.customerId, (reqBy.get(r.c.customerId) ?? 0) + (requestStatus(r.c) === "Requested" ? 1 : 0)));
    const cols: ColSpec[] = [
      { k: "name", l: "Sales party", t: "b" },
      { k: "grade", l: "Grade", t: "s" },
      { k: "area", l: "Area", t: "t" },
      { k: "city", l: "Location", t: "t" },
      { k: "transporter", l: "Transport", t: "t" },
      { k: "payment", l: "Payment type", t: "s" },
      { k: "mobile", l: "Mobile", t: "ph" },
      { k: "credit", l: "Credit days", t: "n" },
      { k: "target", l: "Monthly target", t: "m" },
      { k: "open", l: "Open requests", t: "n" },
    ];
    return {
      spec: { screen: "myCustomers", cols, hidden: [], readOnly: false, noDataLine: "No customers are tagged to you as their sales person." },
      rows: mine.map((c) => ({
        id: c.id,
        v: {
          name: c.name,
          grade: c.p?.grade ?? null,
          area: c.area,
          city: c.city,
          transporter: c.p?.transporter ?? null,
          payment: c.freightTerm,
          mobile: c.phone,
          credit: c.creditDays,
          target: c.monthlyTargetPaise,
          open: reqBy.get(c.id) ?? 0,
        },
        flags: [],
        title: c.name,
        header: `${c.city ?? ""}${c.area ? ` · ${c.area}` : ""}`,
        contacts: phoneContacts(c.phone, c.email),
        fields: reqs
          .filter((r) => r.c.customerId === c.id)
          .slice(0, 6)
          .map((r) => ({ l: `Complaint · ${fd(calendarDate(r.c.createdAt))}`, v: `${categoryLabel(r.c.category)} — ${requestStatus(r.c)}${r.c.cnAmount ? ` · CN ${inr(r.c.cnAmount)}` : ""}` })),
        actions: [{ id: "edit", l: "Edit", primary: true, loadsForm: true }],
      })),
    };
  },
  formLoaders: { edit: (_ctx, id) => customerForm(id, true) },
  forms: {
    async edit(ctx, h, _l, id) {
      if (!id) return err("No customer named.", "not_found");
      const [c] = await loadCustomers(and(eq(customers.id, id), or(eq(customers.salesAmId, ctx.user.id), sql`lower(${customers.salesPersonName}) = lower(${ctx.user.name})`)));
      if (!c) return err("That customer is not tagged to you.", "not_permitted");
      return saveCustomerDetails(ctx, id, h, true);
    },
  },
};

/* ================================================================ videos */

function youtubeId(url: string): string | null {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
  return m ? m[1] : null;
}

const videos: ScreenModule = {
  key: "videos",
  async load(ctx) {
    const [rows, tags] = await Promise.all([db.select({ v: erpVideos, by: users.name }).from(erpVideos).leftJoin(users, eq(users.id, erpVideos.createdById)).orderBy(desc(erpVideos.createdAt)), refValues("videoTag")]);
    const cols: ColSpec[] = [
      { k: "title", l: "Title", t: "b" },
      { k: "tags", l: "Tags", t: "t" },
      { k: "description", l: "Description", t: "t", w: 320 },
      { k: "source", l: "Source", t: "s" },
    ];
    const editor = ctx.administrator || ctx.level === "manager";
    return {
      spec: {
        screen: "videos",
        cols,
        hidden: [],
        newForm: editor
          ? {
              screen: "videos",
              id: "new",
              title: "Add a help video",
              submit: "Add video",
              init: { source: "From YouTube URL" },
              header: [
                { k: "title", l: "Title", t: "text", req: true },
                { k: "source", l: "Video from", t: "select", req: true, opts: ["From YouTube URL", "From File Upload"] },
                { k: "url", l: "YouTube URL", t: "text", req: true, when: { k: "source", eq: "From YouTube URL" } },
                { k: "file", l: "Video file", t: "video", req: true, when: { k: "source", eq: "From File Upload" } },
                { k: "tags", l: "Search tags", t: "multi", opts: tags },
                { k: "description", l: "Description", t: "area" },
              ],
            }
          : undefined,
        newLabel: "Add video",
        noDataLine: "No help videos yet.",
      },
      rows: rows.map((r) => {
        const yt = r.v.youtubeUrl ? youtubeId(r.v.youtubeUrl) : null;
        return {
          id: r.v.id,
          v: { title: r.v.title, tags: r.v.tags.join(", "), description: r.v.description, source: r.v.source === "youtube" ? "YouTube" : "File" },
          flags: [],
          title: r.v.title,
          header: r.v.tags.join(" · "),
          panel: { kind: "video", data: { youtube: yt, file: r.v.fileId, url: r.v.youtubeUrl } },
          actions: editor ? [{ id: "delete", l: "Delete", confirm: `Remove "${r.v.title}"?` }] : [],
          by: stampLine(r.by, r.v.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      if (!(ctx.administrator || ctx.level === "manager")) return err("A manager adds help videos.", "not_permitted");
      const title = text(h.title);
      if (!title) return fieldErr("title", "Title is required");
      const youtube = h.source !== "From File Upload";
      const url = youtube ? text(h.url) : null;
      if (youtube && (!url || !youtubeId(url))) return fieldErr("url", "Paste a YouTube link");
      const file = youtube ? null : text(h.file);
      if (!youtube && !file) return fieldErr("file", "Upload the video");
      const id = erpId("vid");
      await db.transaction(async (tx) => {
        await tx.insert(erpVideos).values({ id, title, source: youtube ? "youtube" : "file", youtubeUrl: url, fileId: file, tags: multi(h.tags), description: text(h.description), createdById: ctx.user.id });
        await bindErpFiles(tx as unknown as typeof db, [file], "erp_video", id, ctx.user.id);
      });
      await erpAudit(ctx, "erp.video.create", "erp_video", id, null, { title });
      return okVoid(`"${title}" added`);
    },
  },
  actions: {
    async delete(ctx, id) {
      if (!(ctx.administrator || ctx.level === "manager")) return err("A manager removes help videos.", "not_permitted");
      await db.delete(erpVideos).where(eq(erpVideos.id, id));
      await erpAudit(ctx, "erp.video.delete", "erp_video", id);
      return okVoid("Video removed");
    },
  },
};

export const LOGISTICS_SCREENS: ScreenModule[] = [
  transportList("transport"),
  transportList("pendingLr"),
  transportList("trackLr"),
  paidFreight,
  credits,
  expenses,
  myCustomers,
  videos,
];
