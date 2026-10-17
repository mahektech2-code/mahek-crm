/**
 * WHAT A CALL RECORDED, as lines a person can read.
 *
 * `call_reason`, `caller_role`, `reason_detail`, `outcome_detail`,
 * `next_actions`, the opportunity and the snapshot were all written from the
 * day "why the customer rang" shipped, and no screen drew any of them — the
 * timeline and the call history showed a note and an outcome and nothing else,
 * so the one question the section exists to answer ("how many rang about
 * price") was answerable only in SQL. This is the reader.
 *
 * PURE and client-safe, like `call-reasons` and `call-outcomes` beside it: the
 * history screens are client components and the reads are `server-only`, so
 * the only way the words on two screens cannot drift is for both to be built
 * here.
 *
 * It is built from the vocabulary files rather than retyped, and it tolerates
 * what history actually contains: a call with every field null (all of them
 * before the columns existed), a code that has since been re-cut, and a
 * reason-detail key the current list no longer asks. An unknown code prints as
 * itself — a code somebody can read is better than a row that vanishes.
 */

import { OUTCOME_LABEL as CATALOGUE_OUTCOME_LABEL } from "@/db/catalogue";
import {
  CALLER_ROLE_LABEL,
  CALL_REASON_LABEL,
  NEXT_ACTION_LABEL,
  reasonFieldsFor,
} from "./call-reasons";
import { outcomeFieldsFor } from "./call-outcomes";
import { money, shortDate } from "./format";

/* ---------------------------------------------------------------- snapshot */

/**
 * The figures behind the conversation, as the server read them at save.
 * Every part is optional: a reason snapshots only what it has, and a read that
 * failed leaves its part out rather than a guess in.
 */
export type CallContextSnapshot = {
  takenAt?: string;
  payment?: {
    outstandingPaise: number;
    billCount: number;
    /** The oldest few, as the panel's card listed them. */
    bills: Array<{ billNo: string; balancePaise: number; dueDate: string | null }>;
  };
  delivery?: {
    orderNo: number;
    billNo: string | null;
    transporter: string | null;
    lrNo: string | null;
    /** The day the line was planned to leave the godown. */
    plannedDispatch: string | null;
    /** The day it actually left — only once dispatch was recorded. */
    dispatchedOn: string | null;
    stage: string | null;
    status: string | null;
  };
  stock?:
    | {
        sku: string;
        unit: "cans" | "boxes";
        total: number;
        byGodown: Array<{ godown: string; stock: number }>;
      }
    | { unavailable: true };
  /** Who the next actions were routed to, and why — see `next-action-routing`. */
  routing?: Array<{ action: string; to: string; note: string }>;
};

/* ------------------------------------------------------------------- input */

export type CallDetailInput = {
  interactionType?: string | null;
  outcome?: string | null;
  callReason?: string | null;
  callerRole?: string | null;
  callerName?: string | null;
  reasonDetail?: Record<string, string> | null;
  outcomeDetail?: Record<string, string> | null;
  nextActions?: string[] | null;
  nextActionDate?: string | null;
  opportunityAnswer?: string | null;
  opportunity?: {
    product: string;
    estimatedQuantity: string | null;
    estimatedValuePaise: number | null;
    expectedOrderDate: string | null;
    status?: string | null;
  } | null;
  contextSnapshot?: CallContextSnapshot | Record<string, unknown> | null;
};

export type CallDetailLine = { label: string; value: string };

export type CallDetailView = {
  /** One line for the row itself — "Price / Quotation · Purchase Person (Ramesh)". */
  summary: string | null;
  /** Everything else, for the expandable part. Never empty when summary is. */
  lines: CallDetailLine[];
};

const OPPORTUNITY_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "Being worked",
  won: "Won",
  lost: "Lost",
};

function labelFor(
  fields: ReturnType<typeof reasonFieldsFor>,
  key: string,
  value: string,
): CallDetailLine {
  const f = fields.find((x) => x.key === key);
  const label = f?.label ?? key;
  if (f?.kind === "choice") {
    return { label, value: f.options?.find((o) => o.code === value)?.label ?? value };
  }
  if (f?.kind === "yesno") return { label, value: value === "yes" ? "Yes" : "No" };
  if (f?.kind === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { label, value: shortDate(value) };
  }
  if (f?.kind === "number" && /^\d+$/.test(value)) {
    return { label, value: money(Number(value) * 100) };
  }
  return { label, value };
}

/**
 * The view of one call, or null where there is nothing beyond the note and the
 * outcome the screen already shows — which is every call that predates the
 * columns, so the old rows render exactly as they did.
 */
export function describeCall(c: CallDetailInput): CallDetailView | null {
  const lines: CallDetailLine[] = [];

  const reasonLabel = c.callReason ? (CALL_REASON_LABEL[c.callReason] ?? c.callReason) : null;
  const roleLabel = c.callerRole ? (CALLER_ROLE_LABEL[c.callerRole] ?? c.callerRole) : null;
  const callerName = c.callerName?.trim() || null;

  if (reasonLabel) lines.push({ label: "Why they called", value: reasonLabel });
  if (roleLabel || callerName) {
    lines.push({
      label: "Who called",
      value: [roleLabel, callerName && roleLabel ? `(${callerName})` : callerName]
        .filter(Boolean)
        .join(" "),
    });
  }

  /* The reason's own answers, in the order the form asked them. System keys
     (the ERP order, the SKU) are not answers a person gave; they are
     represented by the snapshot below. */
  if (c.callReason && c.reasonDetail) {
    const fields = reasonFieldsFor(c.callReason);
    const seen = new Set<string>();
    for (const f of fields) {
      if (f.system) continue;
      const v = c.reasonDetail[f.key];
      if (v) {
        lines.push(labelFor(fields, f.key, v));
        seen.add(f.key);
      }
    }
    /* A key the list no longer asks is still something somebody said. */
    for (const [k, v] of Object.entries(c.reasonDetail)) {
      if (!seen.has(k) && v && !fields.some((f) => f.key === k && f.system)) {
        lines.push({ label: k, value: v });
      }
    }
  }

  const snap = (c.contextSnapshot ?? null) as CallContextSnapshot | null;
  if (snap?.delivery) {
    const d = snap.delivery;
    lines.push({
      label: "ERP order at the time",
      value: [
        `Order ${d.orderNo}`,
        d.billNo ? `bill ${d.billNo}` : null,
        d.transporter ? `via ${d.transporter}` : null,
        d.lrNo ? `LR ${d.lrNo}` : null,
        d.dispatchedOn
          ? `dispatched ${shortDate(d.dispatchedOn)}`
          : d.plannedDispatch
            ? `planned for ${shortDate(d.plannedDispatch)}`
            : "not dispatched",
        d.stage ? d.stage : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (snap?.payment) {
    const p = snap.payment;
    lines.push({
      label: "Owed at the time",
      value:
        p.billCount > 0
          ? `${money(p.outstandingPaise)} across ${p.billCount} open bill${p.billCount === 1 ? "" : "s"}`
          : "Nothing outstanding",
    });
  }
  if (snap?.stock) {
    lines.push({
      label: "Stock shown at the time",
      value:
        "unavailable" in snap.stock
          ? "The stock check could not be read"
          : `${snap.stock.sku}: ${snap.stock.total} ${snap.stock.unit}${
              snap.stock.byGodown.length
                ? ` (${snap.stock.byGodown.map((g) => `${g.godown} ${g.stock}`).join(", ")})`
                : ""
            }`,
    });
  }

  if (c.outcome && c.outcomeDetail && Object.keys(c.outcomeDetail).length) {
    const fields = outcomeFieldsFor(c.outcome);
    for (const f of fields) {
      const v = c.outcomeDetail[f.key];
      if (v) lines.push(labelFor(fields, f.key, v));
    }
  }

  if (c.nextActions?.length) {
    lines.push({
      label: "Next action",
      value:
        c.nextActions.map((a) => NEXT_ACTION_LABEL[a] ?? a).join(", ") +
        (c.nextActionDate ? ` — by ${shortDate(c.nextActionDate)}` : ""),
    });
  }
  for (const r of snap?.routing ?? []) {
    lines.push({ label: "Handed to", value: `${r.to} — ${r.note}` });
  }

  if (c.opportunity) {
    const o = c.opportunity;
    lines.push({
      label: "Opportunity",
      value: [
        o.product,
        o.estimatedQuantity,
        o.estimatedValuePaise != null ? money(o.estimatedValuePaise) : null,
        o.expectedOrderDate ? `expected ${shortDate(o.expectedOrderDate)}` : null,
        o.status ? (OPPORTUNITY_STATUS_LABEL[o.status] ?? o.status) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  } else if (c.opportunityAnswer === "no") {
    /* Said out loud: "asked, and the answer was no" is a different fact from
       a call nobody asked on, and only the second draws nothing. */
    lines.push({ label: "Opportunity", value: "None — they were asked and there was none" });
  }

  if (!lines.length) return null;

  const summary =
    [
      reasonLabel,
      roleLabel ? (callerName ? `${roleLabel} (${callerName})` : roleLabel) : callerName,
    ]
      .filter(Boolean)
      .join(" · ") ||
    (c.outcome ? (CATALOGUE_OUTCOME_LABEL[c.outcome as keyof typeof CATALOGUE_OUTCOME_LABEL] ?? null) : null);

  return { summary, lines };
}
