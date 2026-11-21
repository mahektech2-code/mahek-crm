import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { stamp } from "@/lib/format";
import { nf } from "../ui";
import { poName, requirementBucket } from "../engines/purchase-flow";
import type { ReqView } from "./purchase-flow";

/* ---------------------------------------------------------------------------
 * A REQUIREMENT'S HISTORY, read from what happened to it — never typed and
 * never stored. Its own row says when it was raised and by whom; the audit
 * log says who linked, created, unlinked, edited or cancelled it; every PO
 * line it has ever been on (a cancelled PO included) says which PO and from
 * where, that PO's audit rows say approved, sent back, closed short or
 * cancelled, `erp_po_shares` says where it was shared, and the gate's inward
 * lines say what arrived. Read for every listed requirement in a handful of
 * queries, oldest first; the step still waiting is the last, open entry.
 * ------------------------------------------------------------------------- */

export type HistoryItem = {
  /** "18 Nov, 10:04 am", or "Waiting" on the open entry. */
  at: string;
  text: string;
  /** The step still waiting — drawn hollow. */
  open?: boolean;
};

type Event = { t: number; at: Date; text: string };

const REQ_ACTIONS = [
    "erp.requisition.linkPo",
  "erp.requisition.unlinkPo",
  "erp.requisition.cancel",
  "erp.requisition.edit",
  "erp.requisition.decideMethod",
  "erp.requisition.selectVendor",
];
const PO_ACTIONS = ["erp.purchaseOrder.approve", "erp.purchaseOrder.sendBack", "erp.purchaseOrder.closeShort", "erp.purchaseOrder.cancel"];

const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", email: "email", link: "a copied link" };

/** What is still awaited, in the open entry's words, by the requirement's stage. */
function waitingFor(stage: string): string | null {
  const bucket = requirementBucket(stage);
  if (bucket === "cancelled" || bucket === "received") return null;
  if (bucket === "toOrder") return stage === "Waiting for PO number" ? "The PO number from the Quotation manager" : "Its PO";
  if (stage === "PO awaiting approval") return "The approver";
  if (stage === "Partly received") return "The rest of the goods at the gate";
  return "Goods at the gate";
}

const list = (xs: string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

const reasonOf = (s: unknown): string | null => {
  const o = (s ?? {}) as Record<string, unknown>;
  const r = o.reason ?? o.note;
  return typeof r === "string" && r.trim() ? r.trim() : null;
};

export async function requirementHistory(views: ReqView[], stageOf: (v: ReqView) => string): Promise<Map<string, HistoryItem[]>> {
  const out = new Map<string, HistoryItem[]>();
  if (!views.length) return out;
  const ids = views.map((v) => v.r.id);
  const [audits, lines] = await Promise.all([
    db.execute(sql`
      select a.entity_id as "id", a.action, a.at as "at", a.after_state as "after", u.name as "who"
        from audit_log a left join users u on u.id = a.actor_id
       where a.entity_type = 'erp_requisition' and a.entity_id in (${list(ids)}) and a.action in (${list(REQ_ACTIONS)})
    `) as unknown as Promise<{ id: string; action: string; at: Date; after: unknown; who: string | null }[]>,
    db.execute(sql`
      select l.id as "lineId", l.requisition_id as "req", l.unit, p.id as "poId", p.po_number as "number", p.qm_po_no as "qm", p.source,
             p.created_at as "at", p.sent_via as "sentVia", p.sent_at as "sentAt", s.name as "supplier", u.name as "who"
        from erp_po_lines l
        join erp_purchase_orders p on p.id = l.po_id
        join erp_suppliers s on s.id = p.supplier_id
        left join users u on u.id = p.created_by_id
       where l.requisition_id in (${list(ids)})
    `) as unknown as Promise<
      { lineId: string; req: string; unit: string; poId: string; number: number; qm: string | null; source: string; at: Date; sentVia: string | null; sentAt: Date | null; supplier: string; who: string | null }[]
    >,
  ]);
  const poIds = [...new Set(lines.map((l) => l.poId))];
  const lineIds = lines.map((l) => l.lineId);
  const [poAudits, shares, receipts] = poIds.length
    ? await Promise.all([
        db.execute(sql`
          select a.entity_id as "id", a.action, a.at as "at", a.after_state as "after", u.name as "who"
            from audit_log a left join users u on u.id = a.actor_id
           where a.entity_type = 'erp_purchase_order' and a.entity_id in (${list(poIds)}) and a.action in (${list(PO_ACTIONS)})
        `) as unknown as Promise<{ id: string; action: string; at: Date; after: unknown; who: string | null }[]>,
        db.execute(sql`
          select po_id as "poId", channel, recipient, status, created_at as "at"
            from erp_po_shares where po_id in (${list(poIds)}) and status <> 'failed'
           order by created_at
        `) as unknown as Promise<{ poId: string; channel: string; recipient: string; status: string; at: Date }[]>,
        db.execute(sql`
          select po_line_id as "lineId", quantity::float8 as "q", unit, pr_number as "pr", created_at as "at"
            from erp_inward where po_line_id in (${list(lineIds)})
        `) as unknown as Promise<{ lineId: string; q: number; unit: string; pr: number; at: Date }[]>,
      ])
    : [[], [], []];

  const byReq = new Map<string, Event[]>();
  const push = (req: string, at: Date | string, text: string) => {
    const d = new Date(at);
    (byReq.get(req) ?? byReq.set(req, []).get(req)!).push({ t: +d, at: d, text });
  };
  const linkedBy = new Set<string>();
  for (const a of audits) {
    const after = (a.after ?? {}) as Record<string, unknown>;
    const who = a.who ?? "somebody";
    if (a.action === "erp.requisition.linkPo") {
      if (typeof after.poId === "string") linkedBy.add(`${a.id}|${after.poId}`);
      push(a.id, a.at, `${typeof after.poNo === "string" ? after.poNo : "A PO number"} linked by ${who}`);
    } else if (a.action === "erp.requisition.unlinkPo") push(a.id, a.at, `PO unlinked by ${who}`);
    else if (a.action === "erp.requisition.cancel") push(a.id, a.at, `Cancelled by ${who}${reasonOf(after) ? ` · ${reasonOf(after)}` : ""}`);
    else if (a.action === "erp.requisition.edit") push(a.id, a.at, `Edited by ${who}`);
    else if (a.action === "erp.requisition.decideMethod") push(a.id, a.at, `${who} chose ${after.method === "quotation" ? "quotation" : "direct purchase"}`);
    else if (a.action === "erp.requisition.selectVendor") push(a.id, a.at, `Supplier picked by ${who}`);
  }
  const poAuditsOf = new Map<string, typeof poAudits>();
  for (const a of poAudits) (poAuditsOf.get(a.id) ?? poAuditsOf.set(a.id, []).get(a.id)!).push(a);
  /* Shares sent together (one press of Send) are one entry. */
  const sharesOf = new Map<string, { at: Date; channel: string; to: string[] }[]>();
  for (const s of shares) {
    const xs = sharesOf.get(s.poId) ?? sharesOf.set(s.poId, []).get(s.poId)!;
    const last = xs[xs.length - 1];
    if (last && last.channel === s.channel && Math.abs(+new Date(s.at) - +last.at) < 60_000) last.to.push(s.recipient);
    else xs.push({ at: new Date(s.at), channel: s.channel, to: [s.recipient] });
  }
  const receiptsOf = new Map<string, typeof receipts>();
  for (const r of receipts) (receiptsOf.get(r.lineId) ?? receiptsOf.set(r.lineId, []).get(r.lineId)!).push(r);

  for (const l of lines) {
    const name = poName({ poNumber: l.number, qmPoNo: l.qm });
    /* A Quotation manager PO linked here is said by the link's audit entry; one bought for it there is said here, as is a PO created in the ERP. */
    if (l.source === "quotation_manager") {
      if (!linkedBy.has(`${l.req}|${l.poId}`)) push(l.req, l.at, `${name} made on the Quotation manager with ${l.supplier}${l.who ? ` · ${l.who}` : ""}`);
    } else push(l.req, l.at, `${name} created with ${l.supplier}${l.who ? ` by ${l.who}` : ""}`);
    const sent = sharesOf.get(l.poId) ?? [];
    for (const s of sent) push(l.req, s.at, `${name} shared on ${CHANNEL[s.channel] ?? s.channel} to ${s.to.join(", ")}`);
    if (!sent.length && l.sentAt) push(l.req, l.sentAt, `${name} sent to the supplier${l.sentVia ? ` · ${l.sentVia}` : ""}`);
    for (const a of poAuditsOf.get(l.poId) ?? []) {
      const why = reasonOf(a.after);
      const who = a.who ?? "somebody";
      const said =
        a.action === "erp.purchaseOrder.approve"
          ? `${name} approved by ${who}`
          : a.action === "erp.purchaseOrder.sendBack"
            ? `${name} sent back by ${who}`
            : a.action === "erp.purchaseOrder.closeShort"
              ? `${name} closed short by ${who}`
              : `${name} cancelled by ${who}`;
      push(l.req, a.at, `${said}${why && a.action !== "erp.purchaseOrder.approve" ? ` · ${why}` : ""}`);
    }
    for (const r of receiptsOf.get(l.lineId) ?? []) push(l.req, r.at, `${nf(r.q)} ${r.unit} received at the gate · PR-${r.pr}`);
  }

  for (const v of views) {
    const evs = (byReq.get(v.r.id) ?? []).sort((a, b) => a.t - b.t);
    const items: HistoryItem[] = [
      { at: stamp(v.r.createdAt), text: `Raised${v.by ? ` by ${v.by}` : ""}${v.r.department ? ` for ${v.r.department}` : ""}` },
      ...evs.map((e) => ({ at: stamp(e.at), text: e.text })),
    ];
    const waiting = waitingFor(stageOf(v));
    if (waiting) items.push({ at: "Waiting", text: waiting, open: true });
    out.set(v.r.id, items);
  }
  return out;
}
