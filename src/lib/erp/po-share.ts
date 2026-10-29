import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpGodowns, erpPoShares, erpPurchaseOrders, users } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { mailConfigured, sendMail } from "@/lib/mailer";
import { err, fieldErr, ok, type Result } from "@/lib/result";
import { calendarDate } from "@/lib/business-date";
import type { ErpContext } from "./access";
import { erpAudit, erpId } from "./server";
import { fd, fdLong, inr, type ShareOutcome, type ShareSpec } from "./ui";
import { poName, poTotals } from "./engines/purchase-flow";
import {
  CHANNEL_LABEL,
  SHAREABLE_PO,
  defaultPoMessage,
  itemsLine,
  mailtoLink,
  poRecipients,
  readShare,
  waMeLink,
  withLink,
  type ShareRecipient,
} from "./engines/po-share";
import { poPdfFilename, renderPoPdf, type PoPdfInput } from "./po-pdf";
import { purchaseOrderViews, type PoView } from "./screens/purchase-flow";
import { publicLinkOrigin } from "@/lib/public-links";

/* ---------------------------------------------------------------------------
 * SHARING A PURCHASE ORDER. "Share…" on a PO opens a window that picks how
 * (WhatsApp, email, a copied link) and who (the vendor, the godown, anybody
 * typed in); this is what Send does with it.
 *
 *   WhatsApp → through Wati where every condition holds (the founder's switch,
 *              a key, `erp.purchase.poWatiTemplate` naming an approved
 *              template whose variables this can fill); otherwise a wa.me
 *              link per person, opened on the sender's own WhatsApp.
 *   Email    → sent from MahekOne with the PDF attached where a mail provider
 *              is configured; otherwise a mailto link carrying the message.
 *   Link     → the PO's link and the message, to copy.
 *
 * Every message carries the PO's link (`/po/<token>`), a PDF that opens with
 * no sign-in. Every person reached is a row in `erp_po_shares`, so "did the
 * vendor get it" has an answer, and the first share moves an Approved PO to
 * Sent. The PDF carries rates, so sharing needs the purchase-money power,
 * like printing.
 * ------------------------------------------------------------------------- */

const COMPANY = "Mahek Marketing India";

/** The PO's link key, minted once and kept. */
export async function poShareToken(poId: string): Promise<string | null> {
  const [row] = await db.select({ t: erpPurchaseOrders.shareToken }).from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, poId));
  if (!row) return null;
  if (row.t) return row.t;
  /* Written only where still empty, so two shares at once keep one link. */
  await db
    .update(erpPurchaseOrders)
    .set({ shareToken: randomBytes(10).toString("hex") })
    .where(and(eq(erpPurchaseOrders.id, poId), isNull(erpPurchaseOrders.shareToken)));
  const [again] = await db.select({ t: erpPurchaseOrders.shareToken }).from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, poId));
  return again?.t ?? null;
}

async function origin(): Promise<string | null> {
  /* A link sent outside goes out on the public host where one is set — never the staff workspace's address. */
  const pub = publicLinkOrigin();
  if (pub) return pub;
  try {
    const { appOrigin } = await import("@/lib/password-reset");
    return await appOrigin();
  } catch {
    return null;
  }
}

export async function poShareLink(token: string): Promise<string | null> {
  const base = await origin();
  return base ? `${base}/po/${token}` : null;
}

/** The PO as the PDF draws it. */
export function poPdfInput(p: PoView): PoPdfInput {
  return {
    name: poName(p.po),
    date: fdLong(p.po.poDate),
    company: COMPANY,
    vendor: { name: p.supplier, phone: p.supplierPhone, email: p.supplierEmail },
    deliverTo: p.godown,
    deliveryBy: fdLong(p.po.deliveryDate),
    paymentTerms: p.po.paymentTerms,
    freightPaise: p.po.freightPaise,
    remarks: p.po.remarks,
    lines: p.lines.map((l) => ({ item: l.item, quantity: l.quantity, unit: l.unit, ratePaise: l.ratePaise, gstBp: l.gstBp })),
    approvedBy: p.approver,
    approvedOn: p.po.approvedAt ? fdLong(calendarDate(p.po.approvedAt)) : null,
  };
}

/** The PDF behind a shared link: the PO, if the key names one that is still a PO a vendor may act on. */
export async function publicPoPdf(token: string): Promise<{ filename: string; bytes: Uint8Array } | null> {
  if (!/^[0-9a-f]{20}$/.test(token)) return null;
  const [row] = await db.select({ id: erpPurchaseOrders.id }).from(erpPurchaseOrders).where(eq(erpPurchaseOrders.shareToken, token));
  if (!row) return null;
  const [p] = await purchaseOrderViews({ ids: [row.id] });
  if (!p || !(SHAREABLE_PO as readonly string[]).includes(p.po.status)) return null;
  return { filename: poPdfFilename(poName(p.po)), bytes: await renderPoPdf(poPdfInput(p)) };
}

type GodownContact = { phone: string | null; email: string | null };

async function godownContacts(ids: string[]): Promise<Map<string, GodownContact>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: erpGodowns.id, phone: erpGodowns.phone, email: erpGodowns.email }).from(erpGodowns).where(inArray(erpGodowns.id, ids));
  return new Map(rows.map((r) => [r.id, { phone: r.phone, email: r.email }]));
}

/** The newest share of each PO, as a sentence: "WhatsApp to Vendor B · 18 Oct by Deepa". */
export async function lastShares(poIds: string[]): Promise<Map<string, string>> {
  if (!poIds.length) return new Map();
  const rows = (await db.execute(sql`
    select distinct on (s.po_id) s.po_id, s.channel, s.recipient, s.created_at, u.name as by,
      (select count(*) from erp_po_shares s2 where s2.po_id = s.po_id and s2.created_at = s.created_at)::int as n
    from erp_po_shares s left join users u on u.id = s.created_by_id
    where s.po_id in ${poIds}
    order by s.po_id, s.created_at desc
  `)) as unknown as { po_id: string; channel: "whatsapp" | "email" | "link"; recipient: string; created_at: string | Date; by: string | null; n: number }[];
  return new Map(
    rows.map((r) => {
      const who = r.channel === "link" ? "link copied" : `to ${r.recipient}${r.n > 1 ? ` and ${r.n - 1} more` : ""}`;
      return [r.po_id, `${CHANNEL_LABEL[r.channel]} ${who} · ${fd(calendarDate(new Date(r.created_at)))}${r.by ? ` by ${r.by}` : ""}`];
    }),
  );
}

type WatiRoute = { ok: true; name: string; params: string[] } | { ok: false; why: string };

/** Whether WhatsApp can go through Wati, and if not, the sentence saying why. */
async function poWatiRoute(): Promise<WatiRoute> {
  const name = ((await getConfig())["erp.purchase.poWatiTemplate"] ?? "").trim();
  if (!name) return { ok: false, why: "No PO template is named in ERP settings, so WhatsApp opens on your phone." };
  const { whatsappServiceState } = await import("@/lib/services/whatsapp-switch-service");
  if (!(await whatsappServiceState()).active) return { ok: false, why: "WhatsApp through Wati is switched off on the Founder Dashboard." };
  const { listWatiTemplates, isApproved, watiConfig } = await import("@/lib/wati");
  if (!(await watiConfig())) return { ok: false, why: "No Wati key is configured." };
  const list = await listWatiTemplates();
  if (!list.ok) return { ok: false, why: `Wati could not be asked for its templates: ${list.error}` };
  const t = list.templates.find((x) => x.name === name);
  if (!t) return { ok: false, why: `There is no Wati template called ${name}.` };
  if (!isApproved(t)) return { ok: false, why: `The Wati template ${name} is not approved yet.` };
  const unfillable = t.params.filter((p) => !(PO_WATI_PARAMS as readonly string[]).includes(p));
  if (unfillable.length) return { ok: false, why: `The Wati template ${name} asks for ${unfillable.join(", ")}, which a PO cannot fill.` };
  return { ok: true, name, params: t.params };
}

/** The variables a PO's Wati template may use. */
export const PO_WATI_PARAMS = ["name", "vendor", "po", "items", "total", "deliver_to", "delivery", "link", "message"] as const;

function totalOf(p: PoView): number {
  return poTotals(p.lines, p.po.freightPaise).totalPaise;
}

/** The Share window for one PO. Cheap: it asks nothing of Wati — the send does that. */
export function poShareSpec(p: PoView, godown: GodownContact, last: string | undefined, opts: { watiNamed: boolean; money: boolean }): ShareSpec {
  const name = poName(p.po);
  const recipients: ShareRecipient[] = poRecipients({
    vendor: p.supplier,
    vendorPhone: p.supplierPhone,
    vendorEmail: p.supplierEmail,
    godown: p.godown,
    godownPhone: godown.phone,
    godownEmail: godown.email,
  });
  return {
    title: `Share ${name}`,
    sub: `${p.supplier}${opts.money ? ` · ${inr(totalOf(p))}` : ""} · delivery by ${fd(p.po.deliveryDate)}`,
    channels: [
      { k: "whatsapp", l: "WhatsApp", d: opts.watiNamed ? "Sent through Wati, with the PO's link" : "Opens on your WhatsApp, message written" },
      { k: "email", l: "Email", d: mailConfigured() ? "Sent from MahekOne, PDF attached" : "Opens in your mail app, message written" },
      { k: "link", l: "Copy link", d: "Paste it anywhere yourself" },
    ],
    recipients,
    message: defaultPoMessage({
      vendor: p.supplier,
      name,
      items: itemsLine(p.lines),
      total: opts.money ? inr(totalOf(p)) : null,
      deliverTo: p.godown,
      deliveryBy: fdLong(p.po.deliveryDate),
      company: COMPANY,
    }),
    attachment: poPdfFilename(name),
    last,
  };
}

/** Every PO's Share window at once, for the list. */
export async function poShareSpecs(views: PoView[], money: boolean): Promise<Map<string, ShareSpec>> {
  const [godowns, last, cfg] = await Promise.all([godownContacts([...new Set(views.map((v) => v.po.godownId))]), lastShares(views.map((v) => v.po.id)), getConfig()]);
  const watiNamed = !!(cfg["erp.purchase.poWatiTemplate"] ?? "").trim();
  return new Map(views.map((v) => [v.po.id, poShareSpec(v, godowns.get(v.po.godownId) ?? { phone: null, email: null }, last.get(v.po.id), { watiNamed, money })]));
}

/** Send: what the Share window sent, done. */
export async function sharePo(ctx: ErpContext, poId: string, values: Record<string, string | undefined>): Promise<Result<unknown>> {
  if (!ctx.powers.has("viewPurchaseMoney")) return err("Sharing sends the PO with its rates to the vendor, so it needs purchase money on your account — Print / PDF gives you a copy without rates.", "not_permitted");
  const [p] = await purchaseOrderViews({ ids: [poId] });
  if (!p) return err("That PO no longer exists.", "not_found");
  const name = poName(p.po);
  if (!(SHAREABLE_PO as readonly string[]).includes(p.po.status))
    return err(p.po.status === "Pending approval" ? "A PO is approved before it goes to anybody." : `${name} is ${p.po.status}.`, "rule_violation");
  const godown = (await godownContacts([p.po.godownId])).get(p.po.godownId) ?? { phone: null, email: null };
  const recipients = poShareSpec(p, godown, undefined, { watiNamed: false, money: true }).recipients;
  const read = readShare(values, recipients);
  if (!read.ok) return fieldErr(read.field, read.error);
  const { channel, message, targets } = read.value;

  const token = await poShareToken(poId);
  const link = token ? await poShareLink(token) : null;
  const text = withLink(message, link);
  const outcome: ShareOutcome = { link, text, results: [] };
  const rows: (typeof erpPoShares.$inferInsert)[] = [];
  const row = (recipient: string, address: string | null, status: "sent" | "by_hand" | "failed" | "copied", why: string | null, providerRef: string | null = null) =>
    rows.push({ id: erpId("eposh"), poId, channel, recipient, address, body: text, status, why, providerRef, createdById: ctx.user.id });

  if (channel === "link") {
    row("Link copied", null, "copied", null);
  } else if (channel === "whatsapp") {
    const route = await poWatiRoute();
    const { sendWatiTemplate } = await import("@/lib/wati");
    const params: Record<string, string> = {
      vendor: p.supplier,
      po: name,
      items: itemsLine(p.lines),
      total: inr(totalOf(p)),
      deliver_to: p.godown,
      delivery: fdLong(p.po.deliveryDate),
      link: link ?? "-",
      message: text.replace(/\s*\n+\s*/g, " ").trim(),
    };
    for (const t of targets) {
      if (!route.ok) {
        row(t.recipient, t.address, "by_hand", route.why);
        outcome.results.push({ recipient: t.recipient, address: t.address, status: "open", href: waMeLink(t.address, text), why: route.why });
        continue;
      }
      const id = erpId("eposh");
      const sent = await sendWatiTemplate({
        templateName: route.name,
        phone: t.address,
        params: route.params.map((k) => ({ name: k, value: (k === "name" ? t.recipient : params[k]) || "-" })),
        localMessageId: id,
        broadcastName: `po_share_${calendarDate(new Date())}`,
      });
      if (sent.ok) {
        rows.push({ id, poId, channel, recipient: t.recipient, address: t.address, body: text, status: "sent", why: null, providerRef: sent.broadcastId, createdById: ctx.user.id });
        outcome.results.push({ recipient: t.recipient, address: t.address, status: "sent" });
      } else {
        const why = sent.uncertain ? `Wati did not answer — check Wati before sending again. ${sent.error}` : sent.error;
        rows.push({ id, poId, channel, recipient: t.recipient, address: t.address, body: text, status: "failed", why, providerRef: null, createdById: ctx.user.id });
        outcome.results.push({ recipient: t.recipient, address: t.address, status: "failed", why, href: waMeLink(t.address, text) });
      }
    }
  } else {
    const subject = `Purchase order ${name} — ${COMPANY}`;
    if (!mailConfigured()) {
      const why = "No mail provider is set up, so the email opens in your mail app (attach the PDF from the link).";
      for (const t of targets) {
        row(t.recipient, t.address, "by_hand", why);
        outcome.results.push({ recipient: t.recipient, address: t.address, status: "open", href: mailtoLink(t.address, subject, text), why });
      }
    } else {
      const pdf = await renderPoPdf(poPdfInput(p));
      for (const t of targets) {
        const sent = await sendMail({ to: t.address, subject, text, attachments: [{ filename: poPdfFilename(name), content: pdf }] });
        if (sent.delivered) {
          row(t.recipient, t.address, "sent", null);
          outcome.results.push({ recipient: t.recipient, address: t.address, status: "sent" });
        } else {
          const why = sent.reason === "failed" ? `The mail provider refused it: ${sent.detail.slice(0, 160)}` : "No mail provider is set up.";
          row(t.recipient, t.address, "failed", why);
          outcome.results.push({ recipient: t.recipient, address: t.address, status: "failed", why, href: mailtoLink(t.address, subject, text) });
        }
      }
    }
  }

  await db.insert(erpPoShares).values(rows);
  /* Anything that left — or was handed over to go — counts as the PO sent. */
  if (outcome.results.some((r) => r.status !== "failed") || channel === "link")
    await db
      .update(erpPurchaseOrders)
      .set({ status: p.po.status === "Approved" ? "Sent" : p.po.status, sentAt: new Date(), sentById: ctx.user.id, sentVia: CHANNEL_LABEL[channel], updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(erpPurchaseOrders.id, poId));
  await erpAudit(ctx, "erp.purchaseOrder.share", "erp_purchase_order", poId, null, {
    channel,
    to: rows.map((r) => r.recipient),
    sent: outcome.results.filter((r) => r.status === "sent").length,
    byHand: outcome.results.filter((r) => r.status === "open").length,
    failed: outcome.results.filter((r) => r.status === "failed").length,
  });

  const sentN = outcome.results.filter((r) => r.status === "sent").length;
  const openN = outcome.results.filter((r) => r.status === "open").length;
  const failN = outcome.results.filter((r) => r.status === "failed").length;
  const msg =
    channel === "link"
      ? `${name}: link ready to copy`
      : [sentN ? `sent to ${sentN}` : "", openN ? `${openN} to send from your ${channel === "whatsapp" ? "WhatsApp" : "mail app"}` : "", failN ? `${failN} failed` : ""].filter(Boolean).join(" · ");
  return ok(outcome, channel === "link" ? msg : `${name}: ${msg}`);
}

/** The newest shares of one PO, for its record. */
export async function poShareHistory(poId: string, limit = 20) {
  return db
    .select({ s: erpPoShares, by: users.name })
    .from(erpPoShares)
    .leftJoin(users, eq(users.id, erpPoShares.createdById))
    .where(eq(erpPoShares.poId, poId))
    .orderBy(desc(erpPoShares.createdAt))
    .limit(limit);
}

/** Wati's delivery ticks for a PO share; `eposh_` ids are ours. Status only moves forward. */
export async function applyPoShareWatiEvent(localId: string, kind: string, reason: string | null): Promise<string | null> {
  const [m] = await db.select().from(erpPoShares).where(eq(erpPoShares.id, localId));
  if (!m) return null;
  const order = ["failed", "sent", "delivered", "read"];
  const next = kind === "failed" ? "failed" : kind === "delivered" ? "delivered" : kind === "read" ? "read" : null;
  if (!next) return `po share ${kind} ignored`;
  if (next !== "failed" && order.indexOf(next) <= order.indexOf(m.status)) return `po share ${kind} ignored at ${m.status}`;
  if (next === "failed" && m.status !== "sent") return `po share failed ignored at ${m.status}`;
  await db.update(erpPoShares).set({ status: next, ...(next === "failed" ? { why: reason ?? "WhatsApp did not deliver it." } : {}) }).where(eq(erpPoShares.id, localId));
  return `po share ${next}`;
}
