"use client";

import { useState } from "react";
import { RowMenu } from "@/components/ui/overlays";
import { Button, Card, cx, Td, Th, Tr } from "@/components/ui/primitives";
import { callDue, daysBetween, runningLate, shortDay, STAGE_SHORT, type Stage } from "@/lib/erp/engines/logistics";
import { transporterKey } from "@/lib/erp/engines/transporter-calls";
import type { Consignment } from "@/lib/erp/logistics";
import { stampDate } from "@/lib/format";
import { Badge } from "../../_ui/badge";
import { Icon } from "../../_ui/icons";
import { LinkButton, SubTitle } from "../../_ui/look";
import { BillRef, DuePill, lrLabel, plural, sumPackages } from "./common";

/* ---------------------------------------------------------------------------
 * ON THE ROAD, BY TRANSPORTER — one section per company, because one call to
 * Shree Ganesh covers all five of its LRs and the question every morning is
 * which company to ring next, not which LR.
 *
 * A section's header says what that company has of ours and what is wrong
 * with it, and carries ONE button: Call. It is filled when calls are due and
 * plain when none are, so the companies to ring stand out down the page. No
 * phone number is drawn here; the calling window has the people and their
 * numbers. Inside, each LR is a row with its own Update and a menu for the
 * rest of what the card view offers.
 * ------------------------------------------------------------------------- */

export type LrGroup = { key: string; bills: Consignment[] };
type Act = "update" | "issue" | "solved" | "editLr" | "delivered" | "deliveredBy";

export function ByTransporter({
  groups,
  today,
  lateAfterDays,
  canWrite,
  pending,
  onCall,
  onAct,
}: {
  groups: LrGroup[];
  today: string;
  lateAfterDays: number;
  canWrite: boolean;
  pending: boolean;
  onCall: (transporter: string, groups: LrGroup[]) => void;
  onAct: (kind: Act, bills: Consignment[]) => void;
}) {
  const isLate = (g: LrGroup) => g.bills.some((c) => runningLate({ expectedDeliveryOn: c.expectedDeliveryOn, billDate: c.billDate, materialStage: c.stage }, today, lateAfterDays));
  const isDue = (g: LrGroup) => g.bills.some((c) => callDue({ reminderDate: c.nextCallOn, materialStage: c.stage }, today));
  const hasIssue = (g: LrGroup) => g.bills.some((c) => c.issue);

  const byCompany = new Map<string, { key: string; name: string; own: boolean; lrs: LrGroup[] }>();
  for (const g of groups) {
    const c = g.bills[0];
    const key = transporterKey(c.transporter) || "—";
    const entry = byCompany.get(key) ?? { key, name: c.transporter?.trim() || "No transporter", own: c.ownVehicle, lrs: [] };
    entry.lrs.push(g);
    byCompany.set(key, entry);
  }
  const companies = [...byCompany.values()]
    .map((t) => ({ ...t, due: t.lrs.filter(isDue).length, late: t.lrs.filter(isLate).length, issues: t.lrs.filter(hasIssue).length }))
    .sort((a, b) => b.due - a.due || b.issues - a.issues || b.late - a.late || b.lrs.length - a.lrs.length || a.name.localeCompare(b.name));

  /* Open what needs somebody today; a short list opens whole. */
  const [open, setOpen] = useState<Set<string>>(() => new Set(companies.filter((t) => companies.length <= 3 || t.due || t.issues).map((t) => t.key)));
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const bills = groups.flatMap((g) => g.bills);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-meta text-muted">
        <span>
          <span className="font-semibold text-ink">{plural(companies.length, "transporter")}</span> · {plural(groups.length, "LR")} · {plural(bills.length, "bill")}
        </span>
        <span className="ml-auto flex gap-3">
          <LinkButton onClick={() => setOpen(new Set(companies.map((t) => t.key)))}>Open all</LinkButton>
          <LinkButton onClick={() => setOpen(new Set())}>Close all</LinkButton>
        </span>
      </div>

      {companies.map((t) => {
        const isOpen = open.has(t.key);
        const tBills = t.lrs.flatMap((g) => g.bills);
        const boxes = sumPackages(tBills);
        const latest = tBills.map((b) => b.lastEventAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
        return (
          <Card key={t.key} className={cx("overflow-hidden", t.issues ? "border-danger/50" : t.late ? "border-warn/60" : "")}>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <button
                type="button"
                onClick={() => toggle(t.key)}
                aria-expanded={isOpen}
                aria-label={`${isOpen ? "Close" : "Open"} ${t.name}`}
                className="flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-control border border-line bg-surface text-body hover:bg-canvas"
              >
                <span className={cx("transition-transform", isOpen && "rotate-90")}>
                  <Icon n="chev" s={16} />
                </span>
              </button>
              <span className={cx("flex h-10 w-10 flex-none items-center justify-center rounded-control", t.own ? "bg-warn-soft text-warn-ink" : "bg-brand-soft text-brand")}>
                <Icon n="truck" s={20} />
              </span>
              <button type="button" onClick={() => toggle(t.key)} className="min-w-[220px] flex-1 cursor-pointer text-left">
                <div className="flex flex-wrap items-center gap-2">
                  <SubTitle className="mb-0">{t.name}</SubTitle>
                  {t.own ? <Badge label="Our vehicle · signed copy closes it" tone="warn" /> : null}
                </div>
                <div className="text-meta text-muted">
                  {plural(t.lrs.length, t.own ? "trip" : "LR")} · {plural(tBills.length, "bill")}
                  {boxes != null ? ` · ${plural(boxes, "box", "boxes")}` : ""}
                  {latest ? ` · last update ${stampDate(latest)}` : ""}
                </div>
              </button>
              <div className="flex flex-wrap gap-1.5">
                {t.late ? <Badge label={`${t.late} running late`} tone="warn" /> : null}
                {t.issues ? <Badge label={`${t.issues} with a problem`} tone="danger" /> : null}
              </div>
              <Button size="sm" variant={t.due ? "primary" : "secondary"} className="ml-auto" onClick={() => onCall(t.name, t.lrs)}>
                <Icon n="phone" s={14} />
                {t.own ? "Call driver" : t.due ? "Call now" : "Call"}
                {t.due ? <span className="rounded-full bg-brand-lime px-1.5 text-2xs font-bold text-ink">{t.due} due</span> : null}
              </Button>
            </div>

            {isOpen ? (
              <div className="overflow-x-auto border-t border-divider">
                <table className="w-full min-w-[860px] border-collapse text-sm">
                  <thead>
                    <Tr>
                      <Th>{t.own ? "Vehicle" : "LR"}</Th>
                      <Th>Party · bills</Th>
                      <Th>Where it is</Th>
                      <Th>Stage</Th>
                      <Th>Expected</Th>
                      <Th>Next call</Th>
                      <Th align="right">
                        <span className="sr-only">Actions</span>
                      </Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {t.lrs.map((g) => {
                      const c = g.bills[0];
                      const issue = g.bills.find((b) => b.issue);
                      const late = isLate(g);
                      const since = c.lrDate ?? c.billDate;
                      const parties = [...new Set(g.bills.map((b) => b.party))];
                      const where = c.currentCity ?? c.dispatchedFrom;
                      return (
                        <Tr key={g.key}>
                          <Td className="align-top">
                            <div className="font-mono font-medium text-ink">{c.ownVehicle ? (c.vehicleNo ?? "Vehicle not recorded") : lrLabel(c.lrNo)}</div>
                            <div className="text-2xs text-muted">{since ? `${daysBetween(since, today)} d on the road` : ""}</div>
                          </Td>
                          <Td className="align-top">
                            <div className="max-w-[260px] truncate font-medium text-ink" title={parties.join(", ")}>
                              {parties.join(", ")}
                            </div>
                            <div className="text-meta text-muted">
                              {g.bills.map((b, i) => (
                                <span key={b.id}>
                                  {i ? ", " : ""}
                                  <BillRef c={b} />
                                </span>
                              ))}
                              {sumPackages(g.bills) != null ? ` · ${plural(sumPackages(g.bills) ?? 0, "box", "boxes")}` : ""}
                            </div>
                          </Td>
                          <Td className="align-top">
                            <div className="text-body">{[where, c.destination && c.destination !== where ? `→ ${c.destination}` : null].filter(Boolean).join(" ") || "—"}</div>
                            {issue ? <div className="text-meta font-medium text-danger">{issue.issue}</div> : late ? <div className="text-meta font-medium text-warn-ink">Running late</div> : null}
                            {c.ownVehicle && !c.signedCopyId ? <div className="text-meta text-warn-ink">No signed copy yet</div> : null}
                          </Td>
                          <Td className="align-top">
                            <Badge label={STAGE_SHORT[c.stage as Stage] ?? c.stage} tone={c.stage === "Out for Delivery" || c.stage === "Ready for Pickup" ? "success" : c.stage === "Reached Destination Area" ? "brand" : "neutral"} />
                          </Td>
                          <Td className={cx("align-top whitespace-nowrap", late ? "font-semibold text-danger" : "text-body")}>{c.expectedDeliveryOn ? shortDay(c.expectedDeliveryOn) : "—"}</Td>
                          <Td className="align-top">
                            <DuePill day={c.nextCallOn} today={today} />
                          </Td>
                          <Td align="right" className="align-top whitespace-nowrap">
                            {canWrite ? (
                              <span className="inline-flex items-center gap-1">
                                <Button size="sm" disabled={pending} onClick={() => onAct("update", g.bills)}>
                                  Update
                                </Button>
                                <RowMenu
                                  items={[
                                    issue ? { label: "Problem solved", onSelect: () => onAct("solved", g.bills) } : { label: "Report a problem", onSelect: () => onAct("issue", g.bills) },
                                    ...(c.lrId ? [{ label: "Edit LR", onSelect: () => onAct("editLr", g.bills) }] : [{ label: "Delivered by…", onSelect: () => onAct("deliveredBy", g.bills) }]),
                                    { label: c.ownVehicle ? "Signed copy & delivered" : "Delivered ✓", onSelect: () => onAct("delivered", g.bills) },
                                  ]}
                                />
                              </span>
                            ) : null}
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
