"use client";

import * as React from "react";
import Link from "next/link";

import { Icon } from "@/components/shell/icons";
import { cx } from "@/components/ui/primitives";
import { STAGE_LABEL, COMMS_ACTIONS, personName } from "@/lib/sales-lead-pipeline/reference";
import type { Lead } from "@/lib/sales-lead-pipeline/types";
import { useLeadPipeline } from "../provider";
import { PBadge, PCard, PEmpty, PPriorityBadge, PSalesTypeBadge, PSectionLabel, PStageBadge, fmtDay, managerAction, pbtn } from "./ui";

/* ---------------------------------------------------------------------------
 * THE LEAD RECORD, in the prototype's own pieces.
 *
 * `lead-record-screen.tsx` decides WHAT the record says — the tabs, the gate,
 * the real values, who may press what — and asks these for HOW the CRM's
 * mounting draws it. Sales Dashboard's `/sales-lead-pipeline` never reaches
 * this file: it is chosen by `workspace === "crm"` and nothing else.
 * ------------------------------------------------------------------------- */

const money = (paise?: number) => (paise ? "₹" + Math.round(paise / 100).toLocaleString("en-IN") : undefined);

function MetaCell({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-[650] tracking-[0.04em] text-muted uppercase">{label}</div>
      <div className="mt-0.5 text-[13.5px] font-[550] text-ink">{value || "—"}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ header */

/** `.detail-head` — the name with its three badges, the id line, the actions, the six-item meta row. */
export function ProtoRecordHeader({
  lead,
  canWork,
  editHref,
  onReassign,
  onLost,
}: {
  lead: Lead;
  canWork: boolean;
  editHref: string;
  onReassign: () => void;
  onLost: () => void;
}) {
  return (
    <PCard className="mb-4 px-5 py-[18px]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-[9px] text-[21px] font-[650] text-ink">
            {lead.name}
            <PSalesTypeBadge salesType={lead.salesType} />
            {lead.lost ? <PBadge tone="danger">Lost</PBadge> : <PStageBadge stage={lead.stage} />}
            <PPriorityBadge priority={lead.priority} />
            {lead.isRecent ? <PBadge tone="success">Recently</PBadge> : null}
          </div>
          <div className="mt-0.5 font-mono text-[11.5px] text-[#8890a0]">
            {lead.id} · created {lead.createdAt || "—"} · source: {lead.source ?? "—"}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!lead.lost && canWork ? (
            <button type="button" className={pbtn("ghost", true)} onClick={onReassign}>
              <Icon name="people" size={14} /> Reassign
            </button>
          ) : null}
          <Link href={editHref} className={pbtn("ghost", true)}>
            <Icon name="doc" size={14} /> Edit
          </Link>
          {!lead.lost && canWork ? (
            <button type="button" className={cx(pbtn("secondary", true), "border-danger-soft text-danger")} onClick={onLost}>
              Mark Lost
            </button>
          ) : null}
        </div>
      </div>
      <div className="mt-3.5 flex flex-wrap gap-5">
        <MetaCell label="Owner" value={personName(lead.owner)} />
        <MetaCell label="Sales manager" value={personName(lead.manager)} />
        <MetaCell label="City" value={lead.city} />
        <MetaCell label="Contact" value={lead.contact} />
        <MetaCell label="Phone" value={lead.phone} />
        {lead.salesType !== "distributor" ? <MetaCell label="Product" value={lead.product} /> : null}
      </div>
    </PCard>
  );
}

/* -------------------------------------------------------------- next action */

/** `.next-action` — a tinted band with a 5px strip: purple on time, amber overdue, red where nothing is set. */
export function ProtoNextAction({ lead, today, canWork, onEdit }: { lead: Lead; today: Date; canWork: boolean; onEdit: () => void }) {
  if (!lead.nextAction) {
    return (
      <div className="mb-4 flex items-stretch overflow-hidden rounded-lg border border-danger-soft bg-danger-soft">
        <div className="w-[5px] flex-none bg-danger" />
        <div className="flex flex-1 flex-wrap items-center gap-[22px] px-[18px] py-3.5">
          <div>
            <div className="text-[10.5px] font-semibold tracking-[0.06em] text-danger uppercase">No next action set</div>
            <div className="mt-0.5 text-[14.5px] font-[650] text-ink">This active lead has nothing scheduled</div>
            <div className="mt-px text-[12px] text-muted">Every active lead needs a next action — this is a gap.</div>
          </div>
          {canWork ? (
            <button type="button" className={cx(pbtn("primary", true), "ml-auto")} onClick={onEdit}>
              Set next action
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const target = lead.nextActionDate ? new Date(`${lead.nextActionDate}T00:00:00`).getTime() : null;
  const days = target === null ? null : Math.round((target - new Date(today.toDateString()).getTime()) / 86_400_000);
  const overdue = days !== null && days < 0;
  const eyebrow = cx("text-[10.5px] font-semibold tracking-[0.06em] uppercase", overdue ? "text-warn-ink" : "text-[#5223e0]");
  return (
    <div className={cx("mb-4 flex items-stretch overflow-hidden rounded-lg border", overdue ? "border-warn-line bg-warn-soft" : "border-brand-softer bg-brand-soft")}>
      <div className={cx("w-[5px] flex-none", overdue ? "bg-warn" : "bg-brand")} />
      <div className="flex flex-1 flex-wrap items-center gap-[22px] px-[18px] py-3.5">
        <div>
          <div className={eyebrow}>Next action</div>
          <div className="mt-0.5 text-[14.5px] font-[650] text-ink">{lead.nextAction}</div>
        </div>
        <div>
          <div className={eyebrow}>{overdue ? "Overdue since" : "Due"}</div>
          <div className="mt-0.5 text-[14.5px] font-[650] text-ink">{fmtDay(lead.nextActionDate)}</div>
          {days !== null ? (
            <div className="mt-px text-[12px] text-muted">{overdue ? `${Math.abs(days)} day(s) overdue` : days === 0 ? "Today" : `in ${days} day(s)`}</div>
          ) : null}
        </div>
        <div>
          <div className={eyebrow}>Responsible</div>
          <div className="mt-0.5 text-[14.5px] font-[650] text-ink">{personName(lead.nextActionResp)}</div>
        </div>
        <div className="max-w-[260px]">
          <div className={eyebrow}>Expected outcome</div>
          <div className="mt-0.5 text-[14.5px] font-medium text-ink">{lead.expectedOutcome || "—"}</div>
        </div>
        {canWork ? (
          <button type="button" className={cx(pbtn("secondary", true), "ml-auto")} onClick={onEdit}>
            Update
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ relationship */

function Chevron() {
  return (
    <span className="flex flex-none items-center px-1.5 text-line-strong">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </span>
  );
}

function RelNode({ role, name, sub, mahek }: { role: string; name: string; sub?: string; mahek?: boolean }) {
  return (
    <div
      className={cx(
        "min-w-[150px] rounded-lg border px-[15px] py-[11px] shadow-[0_1px_2px_rgba(22,22,22,0.06)]",
        mahek ? "border-brand-softer bg-brand-soft" : "border-line bg-surface",
      )}
    >
      <div className="text-[10px] font-[650] tracking-[0.05em] text-muted uppercase">{role}</div>
      <div className="mt-0.5 text-[14px] font-[650] text-ink">{name}</div>
      {sub ? <div className="mt-px text-[11.5px] text-muted">{sub}</div> : null}
    </div>
  );
}

export function ProtoRelationship({ lead }: { lead: Lead }) {
  return (
    <PCard className="mb-4 px-5 py-[18px]">
      <PSectionLabel>Relationship chain</PSectionLabel>
      <div className="flex flex-wrap items-center">
        <RelNode role="End customer" name={lead.name} sub={lead.city} />
        <Chevron />
        <RelNode role="Distributor salesman" name={lead.distributorSalesman ?? "—"} />
        <Chevron />
        <RelNode role="Distributor" name={lead.distributor ?? "Not named yet"} sub="Bills this account" />
        <Chevron />
        <RelNode role="Mahek sales manager" name={personName(lead.manager)} mahek />
      </div>
      <div className="mt-3 text-[12px] text-muted">
        Commercial authority stays with the distributor — Mahek&rsquo;s role here is coverage and support, not the invoice.
      </div>
    </PCard>
  );
}

/* ---------------------------------------------------- where this lead stands */

/** The section label with the badge on its right, and the ladder: green done, purple current, green connectors. */
export function ProtoStanding({ lead, ladder, currentIdx }: { lead: Lead; ladder: string[]; currentIdx: number }) {
  const ra = managerAction(lead.stage, Boolean(lead.commitment));
  return (
    <div className="mt-[18px]">
      <div className="flex items-center justify-between">
        <PSectionLabel className="!mb-0.5">Where this lead stands</PSectionLabel>
        <PBadge tone={ra.tone}>Sales Manager sees: {ra.label}</PBadge>
      </div>
      <PCard className="mt-2 mb-[18px] px-5 pt-[18px] pb-3">
        <div className="flex items-center overflow-x-auto pb-1.5">
          {ladder.map((s, i) => {
            const done = i < currentIdx;
            const current = i === currentIdx;
            return (
              <div key={s} className="relative flex min-w-[96px] flex-none flex-col items-center">
                {i > 0 ? (
                  <span
                    className={cx(
                      "absolute top-[13px] left-[calc(-50%+13px)] z-0 h-0.5 w-[calc(100%-26px)]",
                      done || current ? "bg-success" : "bg-line-strong",
                    )}
                  />
                ) : null}
                <span
                  className={cx(
                    "z-[1] flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 text-[12px]",
                    done
                      ? "border-success bg-success text-white"
                      : current
                        ? "border-brand bg-brand text-white shadow-[0_0_0_4px_#f1ecff]"
                        : "border-line-strong bg-surface text-[#8890a0]",
                  )}
                >
                  {done ? <Icon name="check" size={13} /> : i + 1}
                </span>
                <span
                  className={cx(
                    "mt-[7px] max-w-[92px] text-center text-[10.5px] leading-[13px] font-semibold",
                    current ? "text-[#5223e0]" : done ? "text-body" : "text-muted",
                  )}
                >
                  {STAGE_LABEL[s as keyof typeof STAGE_LABEL]}
                </span>
              </div>
            );
          })}
        </div>
        {currentIdx === -1 && !lead.lost ? (
          <p className="mt-2 text-[12px] text-muted">
            {STAGE_LABEL[lead.stage]} is not a rung on this lead&rsquo;s ladder — it is parked, and returns to the rung it was paused at.
          </p>
        ) : null}
      </PCard>
    </div>
  );
}

/* --------------------------------------------------------------------- tabs */

export function ProtoTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: T; label: string }[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="mb-[18px] flex items-center gap-0.5 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={cx(
            "-mb-px border-b-2 px-3.5 py-[9px] text-[13px] whitespace-nowrap",
            active === t.key ? "border-brand font-[650] text-ink" : "border-transparent text-muted hover:text-body",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- overview */

const NYC = "Not Yet Confirmed";

/** `.ov-grid` — thirteen bordered cells in three columns, the wording of an unanswered one being the prototype's. */
export function ProtoOpportunityGrid({ lead }: { lead: Lead }) {
  const cells: { label: string; value: React.ReactNode }[] = [
    { label: "Customer type", value: lead.customerType || "—" },
    { label: "Decision maker", value: lead.decisionMaker || NYC },
    { label: "Buyer", value: lead.buyer || NYC },
    {
      label: "GST",
      value: lead.gstin ? (
        <>
          {lead.gstin}{" "}
          {lead.gstVerified ? (
            <PBadge tone="success" className="ml-1.5">
              Verified by Back Office
            </PBadge>
          ) : (
            <PBadge tone="warn" className="ml-1.5">
              Awaiting Back Office check
            </PBadge>
          )}
        </>
      ) : (
        NYC
      ),
    },
    { label: "Monthly requirement", value: lead.monthlyLitres ? `${lead.monthlyLitres.toLocaleString("en-IN")} Litres` : NYC },
    { label: "Expected monthly sales", value: money(lead.potentialPaise) ?? NYC },
    { label: "Credit days", value: lead.creditDaysWanted ? `${lead.creditDaysWanted} days` : NYC },
    { label: "Product", value: lead.product || NYC },
    { label: "Competitor", value: lead.competitor || NYC },
    { label: "Application", value: lead.application || NYC },
    { label: "Address", value: lead.address || "—" },
    { label: "Email", value: lead.email || "—" },
    { label: "Visits so far", value: String(lead.visits || 0) },
  ];
  return (
    <div className="mb-2 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-divider sm:grid-cols-2 lg:grid-cols-3">
      {cells.map((c) => (
        <div key={c.label} className="bg-surface px-4 py-3">
          <div className="text-[10.5px] font-[650] tracking-[0.04em] text-muted uppercase">{c.label}</div>
          <div className="mt-[3px] text-[13.5px] font-[550] text-ink">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- order tab */

const ORDER_STEPS = ["Order received", "Confirmed", "Dispatched", "In transit", "Delivered"];
const ORDER_AT: Record<string, number> = { captured: 0, pending_approval: 0, confirmed: 1, dispatched: 2, in_transit: 3, delivered: 4 };

/**
 * `tabOrder` — the order's steps and its dates, from the real `orders` rows.
 * The status is Accounts' (`orders.status`); nothing here writes one. Payment
 * has no row on the lead to draw from, so it is said in words rather than
 * drawn as two steps this screen could not fill in.
 */
export function ProtoOrderTab({ lead }: { lead: Lead }) {
  if (!lead.orders.length) {
    return (
      <PCard>
        <PEmpty title="No order yet" body="The first order appears here once it is recorded, with its steps through Accounts and dispatch." />
      </PCard>
    );
  }
  const oldest = lead.orders.length - 1;
  return (
    <div className="space-y-4">
      {lead.orders.slice(0, 5).map((o, i) => {
        const declined = o.status === "declined" || o.status === "cancelled";
        const at = ORDER_AT[o.status] ?? 0;
        return (
          <div key={o.id}>
            <PCard className="mb-4">
              <div className="flex items-center justify-between gap-3 border-b border-divider px-[18px] py-3.5">
                <h3 className="m-0 text-[15px] font-[650] text-ink">{i === oldest ? "First order" : "Order"}{o.orderNo ? ` · ${o.orderNo}` : ""}</h3>
                <PBadge tone={declined ? "danger" : "brand"} className="font-mono">
                  {money(o.amountPaise) ?? "—"}
                </PBadge>
              </div>
              <div className="px-[18px] py-4">
                {declined ? (
                  <div className="text-[13px] text-danger">This order was {o.status}. It does not count as a sale.</div>
                ) : (
                  <div className="flex items-center">
                    {ORDER_STEPS.map((label, s) => (
                      <div key={label} className="relative flex flex-1 flex-col items-center">
                        {s > 0 ? <span className={cx("absolute top-[11px] left-[-50%] z-0 h-0.5 w-full", s <= at ? "bg-success" : "bg-divider")} /> : null}
                        <span
                          className={cx(
                            "z-[1] flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold",
                            s < at ? "bg-success text-white" : s === at ? "bg-brand text-white shadow-[0_0_0_4px_#f1ecff]" : "bg-divider text-muted",
                          )}
                        >
                          {s < at ? <Icon name="check" size={11} /> : s + 1}
                        </span>
                        <span className={cx("mt-1.5 text-center text-[10.5px] font-semibold", s === at ? "text-[#5223e0]" : "text-muted")}>{label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </PCard>
            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-divider sm:grid-cols-3">
              {[
                { l: "Ordered", v: o.orderedAt },
                { l: "Status", v: o.status.replace(/_/g, " ") },
                { l: "Order no.", v: o.orderNo },
                { l: "Bill", v: o.billNo },
                { l: "Value", v: money(o.amountPaise) },
                { l: "Payment", v: "Followed in Accounts" },
              ].map((c) => (
                <div key={c.l} className="bg-surface px-4 py-3">
                  <div className="text-[10.5px] font-[650] tracking-[0.04em] text-muted uppercase">{c.l}</div>
                  <div className="mt-[3px] text-[13.5px] font-[550] text-ink">{c.v || "—"}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <p className="text-[12px] text-muted">Status is Accounts&rsquo; — an order counts as a sale once they accept it.</p>
    </div>
  );
}

/* --------------------------------------------------------------- timeline */

// role-name-ok — "Telecaller" is the prototype's chip wording for a logged call's author, not a role value.
const KIND_LABEL: Record<string, string> = { system: "System", salesman: "Salesman", caller: "Telecaller", sales_manager: "Office" };
const KIND_DOT: Record<string, string> = {
  system: "border-[#8890a0]",
  salesman: "border-brand bg-brand-soft",
  caller: "border-[#0d8fa8] bg-[#e6f6f9]",
  sales_manager: "border-warn bg-warn-soft",
};
const KIND_CHIP: Record<string, string> = {
  system: "bg-divider text-muted",
  salesman: "bg-brand-soft text-[#5223e0]",
  caller: "bg-[#e6f6f9] text-[#0d6d80]",
  sales_manager: "bg-warn-soft text-warn-ink",
};

export function ProtoTimeline({ lead, paging }: { lead: Lead; paging: { total: number; nextHref: string | null; newestHref: string | null } }) {
  const entries = lead.timeline;
  if (entries.length === 0) {
    return (
      <PCard>
        <PEmpty title="Nothing on the timeline yet" body="Nothing has been recorded on this lead yet." />
      </PCard>
    );
  }
  return (
    <PCard className="px-[18px] py-4">
      <div className="relative pl-[26px]">
        <div className="absolute top-1 bottom-1 left-2 w-[1.5px] bg-line" />
        {entries.map((t, i) => (
          <div key={i} className="relative pb-5 last:pb-0">
            <span className={cx("absolute top-0.5 -left-[26px] h-[17px] w-[17px] rounded-full border-2 bg-surface", KIND_DOT[t.kind] ?? "border-line-strong")} />
            <div className="mb-0.5 font-mono text-[11px] text-muted">{t.d}</div>
            <div className="text-[13.5px] font-semibold text-ink">{t.title}</div>
            {t.meta ? <div className="mt-0.5 text-[12.5px] text-muted">{t.meta}</div> : null}
            <span className={cx("mt-[5px] inline-flex items-center gap-[5px] rounded-[9px] py-px pr-[7px] pl-[5px] text-[11px] font-[650]", KIND_CHIP[t.kind] ?? "bg-divider text-muted")}>
              {KIND_LABEL[t.kind] ?? t.kind}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-divider pt-3 text-[12.5px] text-muted">
        <span>
          Showing {entries.length} of {paging.total.toLocaleString("en-IN")} entries
        </span>
        <span className="flex gap-4">
          {paging.newestHref ? (
            <Link href={paging.newestHref} scroll={false} className="font-medium text-brand hover:text-brand-hover">
              ← Newest
            </Link>
          ) : null}
          {paging.nextHref ? (
            <Link href={paging.nextHref} scroll={false} className="font-medium text-brand hover:text-brand-hover">
              Load older →
            </Link>
          ) : null}
        </span>
      </div>
    </PCard>
  );
}

/* ---------------------------------------------------------- communication */

/** `.action-grid` — three tiles across, an icon chip, the label, a "Sent" badge once it has gone. */
export function ProtoComms({ lead }: { lead: Lead }) {
  const { doCommunication, busy } = useLeadPipeline();
  const canWork = lead.caps.canWork && !lead.lost;
  return (
    <div>
      <PSectionLabel>Company communication — one tap, no hunting for the asset</PSectionLabel>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {COMMS_ACTIONS.map((a) => {
          const count = lead.comms[a.code] ?? 0;
          const done = count > 0;
          const doc = lead.commDocs[a.code];
          const noDoc = a.kind === "send" && !doc;
          return (
            <button
              key={a.code}
              type="button"
              disabled={!canWork || busy || noDoc}
              title={noDoc ? "Nothing is published in the library for this yet." : doc ? `Records: ${doc.title}` : undefined}
              onClick={() => void doCommunication(a.code, doc?.id)}
              className={cx(
                "flex flex-col items-start gap-[7px] rounded-[7px] border border-line bg-surface px-[13px] py-3 text-left hover:border-brand-softer hover:bg-brand-soft disabled:cursor-not-allowed",
                done && "opacity-[0.55]",
                !canWork && "opacity-60",
              )}
            >
              <span
                className={cx(
                  "flex h-7 w-7 items-center justify-center rounded-[6px]",
                  done ? "bg-success-soft text-success" : "bg-brand-soft text-[#5223e0]",
                )}
              >
                <Icon name={a.icon} size={15} />
              </span>
              <span className="text-[12.5px] font-semibold text-ink">{a.label}</span>
              {noDoc ? (
                <span className="text-[11px] font-normal text-muted">Nothing published yet</span>
              ) : doc ? (
                <span className="max-w-full truncate text-[11px] font-normal text-muted">{doc.title}</span>
              ) : null}
              {done ? <PBadge tone="success">Sent{count > 1 ? ` ×${count}` : ""}</PBadge> : null}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[12px] text-muted">
        Pressing one records it on the timeline — who, and when. It does not move the lead: sending a brochure is not evidence that anything was qualified.
      </p>
    </div>
  );
}
