"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Select,
  Th,
  Td,
  Tr,
  Input,
  cx,
} from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { Icon } from "@/components/shell/icons";
import {
  ENQUIRY_STAGES,
  ENQUIRY_PRIORITIES,
  ENQUIRY_SOURCES,
  STAGE_LABEL,
  PRIORITY_LABEL,
  SOURCE_LABEL,
  STAGE_TONE,
  PRIORITY_TONE,
  sourceLabel,
  sourceFormLabel,
  categoryLabel,
  encodeEnquiryCursors,
  type EnquiryCursor,
  type EnquiryStage,
  type EnquiryPriority,
} from "@/lib/enquiry-labels";
import type {
  EnquiryListItem,
  AssignableUser,
  EnquiryDashboardCounts,
} from "@/lib/services/enquiry-service";
import { initialsOf, phoneDisplay, stamp } from "@/lib/format";

type Filters = {
  q: string;
  stage?: EnquiryStage;
  priority?: EnquiryPriority;
  source?: string;
  assigned: string;
  linked?: "linked" | "unlinked";
  sort: "received_desc" | "received_asc";
};

export function EnquiryListScreen({
  items,
  total,
  page,
  pageSize,
  cursors,
  nextCursor,
  more,
  team,
  counts,
  canOpenEnquiry,
  filters,
}: {
  items: EnquiryListItem[];
  total: number;
  page: number;
  pageSize: number;
  /** The keyset cursor stack that got us to this page — see `decodeEnquiryCursors`. */
  cursors: EnquiryCursor[];
  /** The boundary at the end of THIS page, to move one page forward. Null once nothing is left. */
  nextCursor: EnquiryCursor | null;
  /** Whether asking for another page would return anything. */
  more: boolean;
  team: AssignableUser[];
  /** The whole workspace, never the filtered list — these are the pipeline at a glance. */
  counts: EnquiryDashboardCounts;
  /** Whether a row may open its enquiry: that page belongs to the worklist module. */
  canOpenEnquiry: boolean;
  filters: Filters;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(filters.q);

  function push(next: Partial<Filters & { cursors: EnquiryCursor[] }>) {
    // Any filter change starts back at page one — the same "cursors: []"
    // `page: 1` already meant before this, and for the same reason: a
    // cursor is only valid against the ordering/filters that produced it.
    const merged = { ...filters, cursors: [] as EnquiryCursor[], ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.stage) params.set("stage", merged.stage);
    if (merged.priority) params.set("priority", merged.priority);
    if (merged.source) params.set("source", merged.source);
    if (merged.assigned) params.set("assigned", merged.assigned);
    if (merged.linked) params.set("linked", merged.linked);
    if (merged.sort && merged.sort !== "received_desc") params.set("sort", merged.sort);
    if (merged.cursors.length) params.set("cursors", encodeEnquiryCursors(merged.cursors));
    router.push(`/enquiries${params.toString() ? "?" + params.toString() : ""}`);
  }

  // Debounced: the search box pushes a new URL as somebody stops typing,
  // not on every keystroke.
  React.useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => push({ q }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const hasFilters = !!(filters.stage || filters.priority || filters.source || filters.assigned || filters.linked || filters.q);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const stat = (label: string, value: number, note?: string, tone?: "success" | "danger") => (
    <Card className="px-4 py-3.5">
      <div className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">{label}</div>
      <div
        className={cx(
          "mt-1.5 text-[28px] leading-8 font-semibold",
          tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {value}
      </div>
      <div className="mt-1 h-4 text-xs text-muted">{note}</div>
    </Card>
  );

  const tabs: Array<{ stage?: EnquiryStage; label: string; n: number }> = [
    { label: "All", n: counts.total },
    ...ENQUIRY_STAGES.map((s) => ({ stage: s, label: STAGE_LABEL[s], n: counts.byStage[s] })),
  ];

  return (
    <div className="max-w-[1320px] px-6 pt-6 pb-10">
      <PageHeader
        title="Website Enquiries"
        subtitle="Every enquiry from the website and beyond, from first contact through to delivery."
      />

      <CardGrid min={128} gap="gap-3" className="mb-4">
        <Card className="border-brand bg-linear-to-br from-brand to-brand-deep px-4 py-3.5 text-white">
          <div className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap uppercase opacity-80">Total enquiries</div>
          <div className="mt-1.5 text-[28px] leading-8 font-semibold">{counts.total}</div>
          <div className="mt-1 h-4 text-xs opacity-80">{counts.newThisMonth} new this month</div>
        </Card>
        {stat("New", counts.byStage.new)}
        {stat("Contacted", counts.byStage.contacted)}
        {stat("Follow-up", counts.byStage.follow_up)}
        {stat("Qualified", counts.byStage.qualified)}
        {stat("Converted", counts.byStage.converted, undefined, "success")}
        {stat(
          "Unassigned",
          counts.unassigned,
          counts.unassignedHighOrUrgent > 0 ? `${counts.unassignedHighOrUrgent} high priority` : undefined,
          counts.unassigned > 0 ? "danger" : undefined,
        )}
      </CardGrid>

      {counts.unassigned > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-[6px] border border-warn-line bg-warn-soft px-4 py-2.5 text-sm text-warn-ink">
          <span>
            <span className="font-semibold">{counts.unassigned}</span> enquir
            {counts.unassigned === 1 ? "y is" : "ies are"} waiting to be assigned.
          </span>
          <button
            onClick={() => push({ assigned: "unassigned" })}
            className="cursor-pointer text-[13px] font-medium text-brand hover:text-brand-hover"
          >
            Assign now →
          </button>
        </div>
      ) : null}

      {counts.total === 0 ? (
        <Card className="px-6 py-14 text-center">
          <div className="text-lg font-semibold text-ink">No enquiries yet</div>
          <p className="mx-auto mt-1.5 max-w-[440px] text-[15px] text-muted">
            Once a website enquiry arrives it will appear here, unassigned, ready to be worked.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2.5 p-3.5">
            <div className="relative min-w-[200px] flex-1">
              <Icon
                name="search"
                size={14}
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
              />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, phone, company…"
                className="pl-8"
              />
            </div>
            <Select value={filters.priority ?? ""} onChange={(e) => push({ priority: (e.target.value || undefined) as EnquiryPriority })}>
              <option value="">All priorities</option>
              {ENQUIRY_PRIORITIES.map((p) => (
                <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
              ))}
            </Select>
            <Select value={filters.source ?? ""} onChange={(e) => push({ source: e.target.value || undefined })}>
              <option value="">All sources</option>
              {ENQUIRY_SOURCES.map((s) => (
                <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
              ))}
            </Select>
            <Select value={filters.assigned} onChange={(e) => push({ assigned: e.target.value })}>
              <option value="">Anyone</option>
              <option value="unassigned">Unassigned</option>
              {team.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>
            <Select value={filters.linked ?? ""} onChange={(e) => push({ linked: (e.target.value || undefined) as "linked" | "unlinked" })}>
              <option value="">Customer: any</option>
              <option value="linked">Linked</option>
              <option value="unlinked">Not linked</option>
            </Select>
            {hasFilters ? (
              <button
                onClick={() => {
                  setQ("");
                  router.push("/enquiries");
                }}
                className="cursor-pointer text-[13px] font-medium text-brand hover:text-brand-hover"
              >
                Clear all
              </button>
            ) : null}
          </div>

          {/* The stage filter. Closed lives here, which is the one place it is
              drawn now that the stats row is one card per working stage. */}
          <div role="tablist" aria-label="Stage" className="flex gap-1 overflow-x-auto border-t border-divider px-3.5 py-2.5">
            {tabs.map((t) => {
              const active = filters.stage === t.stage;
              return (
                <button
                  key={t.label}
                  role="tab"
                  aria-selected={active}
                  onClick={() => push({ stage: t.stage })}
                  className={cx(
                    "cursor-pointer rounded-full px-3 py-1 text-[13px] font-medium whitespace-nowrap",
                    active ? "bg-brand-soft text-brand" : "text-body hover:bg-canvas",
                  )}
                >
                  {t.label} <span className={active ? "" : "text-muted"}>{t.n}</span>
                </button>
              );
            })}
          </div>

          <div className="overflow-x-auto border-t border-divider">
            <table>
              <thead>
                <tr>
                  <Th>Enquiry</Th>
                  <Th>Source</Th>
                  <Th>Stage</Th>
                  <Th>Priority</Th>
                  <Th>Assigned to</Th>
                  <Th
                    className="cursor-pointer"
                    onClick={() => push({ sort: filters.sort === "received_desc" ? "received_asc" : "received_desc" })}
                  >
                    Received {filters.sort === "received_asc" ? "↑" : "↓"}
                  </Th>
                  <Th>Customer</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => {
                  const who = e.name ?? "Unknown";
                  return (
                    <Tr
                      key={e.id}
                      className={cx(canOpenEnquiry && "cursor-pointer hover:bg-canvas")}
                      onClick={canOpenEnquiry ? () => router.push(`/enquiries/list/${e.id}`) : undefined}
                    >
                      <Td className={cx("border-l-[3px] whitespace-normal", e.assignedToName ? "border-transparent" : "border-danger")}>
                        <div className="flex items-center gap-3">
                          <span className="flex size-8 flex-none items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand">
                            {initialsOf(who) || "?"}
                          </span>
                          <div>
                            <div className="font-medium text-ink">{who}</div>
                            <div className="text-xs text-muted">
                              {e.phone ? phoneDisplay(e.phone) : "No phone"}
                              {e.company ? ` · ${e.company}` : ""}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <div className="font-medium text-ink">{sourceLabel(e.source)}</div>
                        {e.sourceForm ? <div className="text-xs text-muted">{sourceFormLabel(e.sourceForm)}</div> : null}
                        {e.category ? <div className="text-xs text-muted">{categoryLabel(e.category)}</div> : null}
                      </Td>
                      <Td><Badge tone={STAGE_TONE[e.stage]}>{STAGE_LABEL[e.stage]}</Badge></Td>
                      <Td><Badge tone={PRIORITY_TONE[e.priority]}>{PRIORITY_LABEL[e.priority]}</Badge></Td>
                      <Td>
                        {e.assignedToName ? (
                          <span className="inline-flex items-center gap-2">
                            <span className="flex size-6 flex-none items-center justify-center rounded-full bg-brand-softer text-[10px] font-semibold text-brand-deep">
                              {initialsOf(e.assignedToName)}
                            </span>
                            {e.assignedToName}
                          </span>
                        ) : (
                          <span className="font-medium text-danger">Unassigned</span>
                        )}
                      </Td>
                      <Td>{stamp(e.receivedAt)}</Td>
                      <Td>
                        {e.customerId ? (
                          <Badge tone="success">Linked</Badge>
                        ) : (
                          <span className="inline-flex h-5 items-center rounded-full border border-dashed border-line-strong px-2 text-[11px] whitespace-nowrap text-muted">
                            Not linked
                          </span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </table>
            {items.length === 0 ? (
              <EmptyState
                title="No enquiries match these filters"
                body="Try clearing a filter or searching a different name, phone or company."
              />
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-divider px-3.5 py-2.5 text-xs text-muted">
            <span>
              Showing {items.length} of {total} enquir{total === 1 ? "y" : "ies"}
            </span>
            <span>Stages: {Object.values(STAGE_LABEL).join(" · ")}</span>
          </div>
        </Card>
      )}

      {totalPages > 1 ? (
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[13px] text-muted">Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            {/* Previous never re-queries "backwards" — it pops the last
                boundary off the stack and asks for the page it already knows
                that cursor reaches, the same way it was reached going forward. */}
            <Button
              variant="secondary"
              size="sm"
              disabled={cursors.length === 0}
              onClick={() => push({ cursors: cursors.slice(0, -1) })}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!more || !nextCursor}
              onClick={() => nextCursor && push({ cursors: [...cursors, nextCursor] })}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
