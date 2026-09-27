import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { erpAiSuggestions, erpOrderInbox } from "@/db/schema";
import { err, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { decideSuggestion, featureState, logSuggestion, readText } from "./ai";
import { bestMatches, toCans } from "./engines/match";
import { erpId } from "./server";
import type { FormSpec, Tone } from "./ui";

/* ---------------------------------------------------------------------------
 * AI-2: an order from a pasted or spoken message, or a WhatsApp reply. The
 * model reads the words; the customer (by number, then name), the SKU (by the
 * product names plus what this party has bought before) and the quantity in
 * cans are decided by rules, and where several SKUs fit the line is left for
 * the person to choose — never picked silently. Nothing becomes an order until
 * the draft is accepted through the normal order form.
 * ------------------------------------------------------------------------- */

const OrderSchema = z.object({
  looksLikeOrder: z.boolean().describe("true only if the customer is asking for goods to be sent"),
  customerName: z.string().nullable(),
  deliveryName: z.string().nullable(),
  transporter: z.string().nullable(),
  remark: z.string().nullable().describe("anything else the customer asked for, in English"),
  lines: z.array(
    z.object({
      mention: z.string().describe("the product as the customer wrote it, e.g. 'NC 1L', 'stoving'"),
      quantity: z.number().nullable(),
      unit: z.string().nullable().describe("as said: peti, box, can, dabba, drum, ltr"),
    }),
  ),
});
export type OrderReading = z.infer<typeof OrderSchema>;

export type DraftLine = { mention: string; sku: string | null; qty: number | null; note: string; choices: string[]; tone: Tone };
export type Draft = { customerId: string | null; customerName: string | null; delivery: string | null; transporter: string | null; remark: string | null; lines: DraftLine[]; how: string };

type Sku = { id: string; name: string; cpb: number; litres: number };

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-10);

/** The rules' half: who is ordering, which SKU each mention is, and how many cans. */
export async function resolveDraft(reading: OrderReading, sender: { customerId?: string | null; phone?: string | null }): Promise<Draft> {
  const [parties, skus] = await Promise.all([
    db.execute(sql`select id, name, phone, whatsapp_phone as whatsapp from customers where status <> 'deactivated'`) as unknown as Promise<{ id: string; name: string; phone: string | null; whatsapp: string | null }[]>,
    db.execute(sql`
      select p.id, p.name, p.cans_per_box as cpb, coalesce(p.millilitres_per_can, fg.millilitres, 0)::float8 / 1000 as litres
        from products p left join finished_goods fg on fg.id = p.finished_good_id where p.active`) as unknown as Promise<Sku[]>,
  ]);
  let customer = sender.customerId ? parties.find((p) => p.id === sender.customerId) ?? null : null;
  let how = customer ? "matched by the WhatsApp contact" : "";
  if (!customer && sender.phone) {
    const d = digits(sender.phone);
    customer = parties.find((p) => digits(p.phone) === d || digits(p.whatsapp) === d) ?? null;
    if (customer) how = "matched by the sender's number";
  }
  if (!customer && reading.customerName) {
    const m = bestMatches(reading.customerName, parties, (p) => p.name, { minScore: 0.7 });
    customer = m.sure;
    if (customer) how = `matched by name ("${reading.customerName}")`;
  }
  if (!customer) how = "no customer matched — pick one";

  /* What this party has bought before breaks a tie between near-identical SKUs. */
  const bought = new Set<string>(
    customer ? ((await db.execute(sql`select distinct sku_id as id from erp_orders where billing_customer_id = ${customer.id}`)) as unknown as { id: string }[]).map((r) => r.id) : [],
  );
  const lines: DraftLine[] = reading.lines.map((l) => {
    const m = bestMatches(l.mention, skus, (s) => s.name, { minScore: 0.55, boost: (s) => (bought.has(s.id) ? 0.25 : 0) });
    const sku = m.sure;
    if (!sku) return { mention: l.mention, sku: null, qty: null, note: m.choices.length ? `Several SKUs fit "${l.mention}" — choose one` : `No SKU matches "${l.mention}"`, choices: m.choices.slice(0, 4).map((c) => c.item.name), tone: "warn" };
    if (l.quantity == null) return { mention: l.mention, sku: sku.name, qty: null, note: "No quantity was said", choices: [], tone: "warn" };
    const conv = toCans(l.quantity, l.unit ?? "can", Number(sku.cpb), Number(sku.litres));
    return {
      mention: l.mention,
      sku: sku.name,
      qty: conv.cans,
      note: conv.cans == null ? (conv.note ?? "Quantity could not be converted to cans") : `"${l.mention}"${conv.note ? ` · ${conv.note}` : ""}${bought.has(sku.id) ? " · bought before" : ""}`,
      choices: [],
      tone: conv.cans == null ? "warn" : "success",
    };
  });
  return { customerId: customer?.id ?? null, customerName: customer?.name ?? null, delivery: reading.deliveryName, transporter: reading.transporter, remark: reading.remark, lines, how };
}

/** Reads a message into a draft, stored in the inbox. The model is asked once; the rest is rules. */
export async function draftFromText(ctx: ErpContext | null, message: string, opts: { source: "paste" | "voice" | "whatsapp"; sender?: string | null; customerId?: string | null; id?: string } = { source: "paste" }): Promise<Result<{ id: string; draft: Draft | null }>> {
  const state = await featureState("orders");
  if (!state.on) return err(state.reason, "rule_violation");
  const read = await readText({
    label: "ERP order",
    system:
      "You read messages from paint shops and distributors in India, in English, Hindi, Marathi or Gujarati, often mixed and in shorthand ('20 peti NC 1L', 'kal 5 drum stoving bhejo'). Extract exactly what is asked for. Never invent a product, quantity or customer; use null where nothing was said. 'peti' and 'carton' mean box. Write the remark in English.",
    prompt: message,
    schema: OrderSchema,
    shapeHint: '{"looksLikeOrder": boolean, "customerName": string|null, "deliveryName": string|null, "transporter": string|null, "remark": string|null, "lines": [{"mention": string, "quantity": number|null, "unit": string|null}]}',
  });
  if (!read.output) return err("The message could not be read. Take the order by hand.", "rule_violation");
  return recordDraft(ctx, message, read.output, opts, read.model);
}

export async function recordDraft(ctx: ErpContext | null, message: string, reading: OrderReading, opts: { source: "paste" | "voice" | "whatsapp"; sender?: string | null; customerId?: string | null; id?: string }, servedBy: string | null): Promise<Result<{ id: string; draft: Draft | null }>> {
  const draft = reading.looksLikeOrder || reading.lines.length ? await resolveDraft(reading, { customerId: opts.customerId, phone: opts.sender }) : null;
  const id = opts.id ?? erpId("inb");
  await db
    .insert(erpOrderInbox)
    .values({ id, source: opts.source, sender: opts.sender ?? null, customerId: draft?.customerId ?? opts.customerId ?? null, text: message, draft: (draft ?? { notAnOrder: true }) as unknown as Record<string, unknown>, status: draft ? "New" : "Not an order" })
    .onConflictDoNothing();
  await logSuggestion({ feature: "orders", recordType: "erp_order_inbox", recordId: id, inputRef: opts.source, proposed: (draft ?? {}) as unknown as Record<string, unknown>, servedBy, userId: ctx?.user.id ?? null });
  return { ok: true, data: { id, draft } };
}

/** The draft as the normal order form, the message beside it. */
export async function draftForm(base: FormSpec, inboxId: string): Promise<FormSpec | null> {
  const [row] = await db.select().from(erpOrderInbox).where(eq(erpOrderInbox.id, inboxId));
  if (!row || row.status !== "New") return null;
  const d = row.draft as unknown as Draft;
  const flags: { tone: Tone; text: string }[] = [
    { tone: d.customerId ? "success" : "warn", text: d.customerName ? `${d.customerName} · ${d.how}` : d.how },
    ...d.lines.map((l) => ({ tone: l.tone, text: `${l.sku ?? l.mention}${l.qty != null ? ` · ${l.qty} cans` : ""} — ${l.note}${l.choices.length ? `: ${l.choices.join(" / ")}` : ""}` })),
  ];
  return {
    ...base,
    title: "Accept the drafted order",
    sub: "Drafted from the message. Check each line against it; nothing is an order until you save.",
    submit: "Create the order",
    init: { ...base.init, billing: d.customerName ?? "", ...(d.transporter ? { transporter: d.transporter } : {}), inboxId },
    initLines: d.lines.map((l) => ({ sku: l.sku ?? "", qty: l.qty == null ? "" : String(l.qty), remark: [d.remark, l.sku ? "" : `Said: ${l.mention}`].filter(Boolean).join(" · ") })),
    evidence: { text: row.text, flags },
  };
}

/** Called by the order save: the inbox message becomes Converted, linked to the order. */
export async function markConverted(ctx: ErpContext, inboxId: string, orderNo: number) {
  await db.update(erpOrderInbox).set({ status: "Converted", orderNo, decidedAt: new Date(), decidedById: ctx.user.id }).where(and(eq(erpOrderInbox.id, inboxId), eq(erpOrderInbox.status, "New")));
  const [s] = await db
    .select({ id: erpAiSuggestions.id })
    .from(erpAiSuggestions)
    .where(and(eq(erpAiSuggestions.feature, "orders"), eq(erpAiSuggestions.recordId, inboxId), eq(erpAiSuggestions.outcome, "pending")))
    .orderBy(desc(erpAiSuggestions.createdAt))
    .limit(1);
  if (s) await decideSuggestion(s.id, "accepted", { orderNo });
}

export async function closeInbox(ctx: ErpContext, id: string, status: "Not an order" | "Duplicate"): Promise<Result<unknown>> {
  const res = await db.update(erpOrderInbox).set({ status, decidedAt: new Date(), decidedById: ctx.user.id }).where(and(eq(erpOrderInbox.id, id), eq(erpOrderInbox.status, "New"))).returning({ id: erpOrderInbox.id });
  if (!res.length) return err("That message has already been dealt with.", "conflict");
  const [s] = await db.select({ id: erpAiSuggestions.id }).from(erpAiSuggestions).where(and(eq(erpAiSuggestions.feature, "orders"), eq(erpAiSuggestions.recordId, id), eq(erpAiSuggestions.outcome, "pending")));
  if (s) await decideSuggestion(s.id, "rejected");
  return okVoid(`Marked ${status}`);
}

const ORDERISH = /\d/;

/**
 * Screens WhatsApp replies that arrived since the last screening: anything
 * with a number in it is read, the rest is not worth a call. Each reply is
 * screened once — its inbox id is derived from the reply.
 */
export async function screenWhatsApp(ctx: ErpContext | null, days = 3): Promise<{ screened: number; drafted: number; skipped?: string }> {
  const state = await featureState("orders");
  if (!state.on) return { screened: 0, drafted: 0, skipped: state.reason };
  const replies = (await db.execute(sql`
    select r.id, r.message, r.wa_id as sender, r.customer_id as customer
      from wa_replies r
     where r.received_at > now() - (${days}::int * interval '1 day')
       and not exists (select 1 from erp_order_inbox i where i.id = 'wa_' || r.id)
     order by r.received_at
     limit 50
  `)) as unknown as { id: string; message: string; sender: string | null; customer: string | null }[];
  let drafted = 0;
  for (const r of replies) {
    if (!ORDERISH.test(r.message)) {
      await db.insert(erpOrderInbox).values({ id: `wa_${r.id}`, source: "whatsapp", sender: r.sender, customerId: r.customer, text: r.message, draft: { notAnOrder: true }, status: "Not an order" }).onConflictDoNothing();
      continue;
    }
    const res = await draftFromText(ctx, r.message, { source: "whatsapp", sender: r.sender, customerId: r.customer, id: `wa_${r.id}` });
    if (res.ok && res.data.draft) drafted++;
  }
  return { screened: replies.length, drafted };
}
