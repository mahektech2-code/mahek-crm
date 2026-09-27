import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, erpOrderInbox } from "@/db/schema";
import { calendarDate } from "@/lib/business-date";
import { err, fieldErr, okVoid } from "@/lib/result";
import { closeInbox, draftForm, draftFromText, screenWhatsApp, type Draft } from "../ai-orders";
import { featureState } from "../ai";
import { erpAudit, text, type ScreenModule } from "../server";
import type { ActionSpec, ColSpec, ListRow } from "../ui";
import { loadCustomers } from "./masters";
import { orderForm } from "./sales";

/* ---------------------------------------------------------------------------
 * AI-2's Order inbox: messages the ERP read as possible orders — pasted,
 * spoken, or screened from WhatsApp replies — each with a drafted order that
 * becomes real only when somebody accepts it through the normal order form.
 * ------------------------------------------------------------------------- */

export const inboxScreen: ScreenModule = {
  key: "orderInbox",
  async load() {
    const [rows, state, parties] = await Promise.all([
      db.select({ i: erpOrderInbox, party: customers.name }).from(erpOrderInbox).leftJoin(customers, eq(customers.id, erpOrderInbox.customerId)).orderBy(desc(erpOrderInbox.receivedAt)),
      featureState("orders"),
      loadCustomers(),
    ]);
    const cols: ColSpec[] = [
      { k: "received", l: "Received", t: "d" },
      { k: "status", l: "Status", t: "s" },
      { k: "source", l: "From", t: "s" },
      { k: "party", l: "Customer", t: "b" },
      { k: "text", l: "Message", t: "t", w: 360 },
      { k: "lines", l: "Draft lines", t: "n" },
      { k: "orderNo", l: "Order no", t: "mono" },
    ];
    return {
      spec: {
        screen: "orderInbox",
        cols,
        hidden: [],
        groups: ["status"],
        newForm: state.on
          ? {
              screen: "orderInbox",
              id: "new",
              title: "Draft an order from a message",
              sub: "Paste the customer's message, or speak it with the microphone. The draft is checked by you before it becomes an order.",
              submit: "Read it",
              init: { mode: "Paste a message" },
              header: [
                { k: "mode", l: "What to read", t: "select", req: true, opts: ["Paste a message", "Screen new WhatsApp replies"] },
                { k: "message", l: "Message", t: "area", req: true, mic: true, when: { k: "mode", eq: "Paste a message" } },
                { k: "customer", l: "Customer, if you know it", t: "select", opts: parties.map((p) => p.name), when: { k: "mode", eq: "Paste a message" } },
                { k: "sender", l: "Sender's number, if any", t: "text", when: { k: "mode", eq: "Paste a message" } },
              ],
            }
          : undefined,
        newLabel: "Read a message",
        noDataLine: state.on ? "No messages yet. Paste or speak one, or screen the WhatsApp replies." : `Drafting orders is unavailable: ${state.reason}`,
      },
      rows: rows.map((x): ListRow => {
        const d = (x.i.draft ?? {}) as unknown as Draft & { notAnOrder?: boolean };
        const actions: ActionSpec[] =
          x.i.status === "New"
            ? [
                { id: "review", l: "Accept the draft", primary: true, ai: true, loadsForm: true, why: d.lines?.length ? "" : "Nothing in this message could be drafted" },
                { id: "notOrder", l: "Not an order" },
                { id: "duplicate", l: "Duplicate", confirm: "Mark this message as a duplicate of an order already taken?" },
              ]
            : [];
        return {
          id: x.i.id,
          v: { received: calendarDate(x.i.receivedAt), status: x.i.status, source: x.i.source === "whatsapp" ? "WhatsApp" : x.i.source === "voice" ? "Voice" : "Pasted", party: x.party ?? d.customerName ?? "Not matched", text: x.i.text, lines: d.lines?.length ?? 0, orderNo: x.i.orderNo == null ? null : String(x.i.orderNo) },
          flags: x.i.status === "New" ? ["requested"] : [],
          title: x.party ?? d.customerName ?? "Unmatched sender",
          header: x.i.sender ? `From ${x.i.sender}` : undefined,
          fields: [
            { l: "Message", v: x.i.text },
            ...(d.lines ?? []).map((l, i) => ({ l: `Line ${i + 1}`, v: `${l.sku ?? l.mention}${l.qty != null ? ` · ${l.qty} cans` : ""} — ${l.note}`, der: true })),
          ],
          actions,
        };
      }),
    };
  },
  formLoaders: {
    async review(ctx, id) {
      const base = await orderForm(ctx);
      return draftForm(base, id);
    },
  },
  forms: {
    async new(ctx, h) {
      if (h.mode === "Screen new WhatsApp replies") {
        const r = await screenWhatsApp(ctx);
        if (r.skipped) return err(r.skipped, "rule_violation");
        await erpAudit(ctx, "erp.ai.inbox.screen", "erp_order_inbox", null, null, r);
        return okVoid(r.screened ? `${r.screened} repl${r.screened === 1 ? "y" : "ies"} screened · ${r.drafted} drafted as orders` : "No new WhatsApp replies to screen");
      }
      const message = text(h.message);
      if (!message) return fieldErr("message", "Paste or speak the message");
      const [c] = h.customer ? await loadCustomers(eq(customers.name, h.customer)) : [];
      const res = await draftFromText(ctx, message, { source: "paste", sender: text(h.sender), customerId: c?.id ?? null });
      if (!res.ok) return res;
      const d = res.data.draft;
      if (!d) return okVoid("That does not read as an order — filed as Not an order.");
      const unsure = d.lines.filter((l) => !l.sku || l.qty == null).length;
      return okVoid(`Drafted ${d.lines.length} line${d.lines.length === 1 ? "" : "s"}${d.customerName ? ` for ${d.customerName}` : ""}${unsure ? ` · ${unsure} to choose` : ""}. Open it to accept.`);
    },
  },
  actions: {
    notOrder: (ctx, id) => closeInbox(ctx, id, "Not an order"),
    duplicate: (ctx, id) => closeInbox(ctx, id, "Duplicate"),
  },
};
