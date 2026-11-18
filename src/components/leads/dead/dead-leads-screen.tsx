"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Cell, Empty, HeadCell, Pill, Row, ScreenHeader, Table, plural } from "@/components/console/parts";
import { shortDate } from "@/lib/format";
import { LOST_REASONS, labelOf, stageLabel, type LeadStage } from "@/lib/lead-labels";
import { DEAD_REASONS } from "@/lib/lead-dead";
import { DEAD_REQUEST_STATE_LABEL } from "@/lib/lead-dead";
import type { DeadLeadRow, DeadRequestRow } from "@/lib/services/lead-dead-service";
import { DecideDeadDialog } from "./decide-dead-dialog";
import { WithdrawButton } from "./withdraw-button";

type Tab = "list" | "queue" | "mine";

const leadHref = (id: string) => `/crm/leads/${id}`;

const when = (iso: string | null) => (iso ? shortDate(iso.slice(0, 10)) : "—");

export function DeadLeadsScreen({
  tab,
  list,
  queue,
  mine,
  reasons,
  viewerId,
}: {
  /** Who is looking — Withdraw is drawn only on their own pending requests. */
  viewerId: string;
  tab: Tab;
  /** Null for somebody who does not hold the module: they see only their own requests. */
  list: { rows: DeadLeadRow[]; total: number; page: number; pageCount: number; perPage: number } | null;
  queue: DeadRequestRow[];
  mine: DeadRequestRow[];
  reasons: { code: string; label: string }[];
}) {
  const router = useRouter();
  const search = useSearchParams();
  const [deciding, setDeciding] = React.useState<DeadRequestRow | null>(null);

  const go = (patch: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") next.delete(k);
      else next.set(k, String(v));
    }
    router.push(`?${next.toString()}`, { scroll: false });
  };

  const urlQ = search.get("q") ?? "";
  const [typed, setTyped] = React.useState(urlQ);
  React.useEffect(() => {
    if (typed === urlQ) return;
    const t = setTimeout(() => go({ q: typed || undefined, page: undefined }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, urlQ]);

  const tabs: Array<{ key: Tab; label: string; show: boolean; count?: number }> = [
    { key: "queue", label: "Awaiting my decision", show: true, count: queue.length },
    { key: "list", label: "Dead leads", show: Boolean(list), count: list?.total },
    { key: "mine", label: "My requests", show: true, count: mine.length },
  ];

  return (
    <div className="p-6">
      <ScreenHeader
        title="Dead Leads"
        subtitle="Lost leads that a reporting manager has approved as permanently Dead. A Dead lead is read-only for ever — it can be viewed with its whole history, but never reopened, reassigned, edited or worked."
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => go({ tab: t.key, page: undefined })}
              className={
                "h-8.5 cursor-pointer rounded-[4px] border px-3 text-[13px] " +
                (tab === t.key ? "border-brand bg-brand-soft font-medium text-ink" : "border-line bg-surface text-body hover:bg-canvas")
              }
            >
              {t.label}
              {t.count ? <span className="ml-1.5 text-muted tabular-nums">{t.count}</span> : null}
            </button>
          ))}
      </div>

      {tab === "list" && list ? (
        <DeadList list={list} typed={typed} onTyped={setTyped} go={go} reasons={reasons} />
      ) : tab === "queue" ? (
        queue.length ? (
          <Table
            minWidth={1000}
            head={
              <>
                <HeadCell width={220}>Lead</HeadCell>
                <HeadCell width={160}>Asked by</HeadCell>
                <HeadCell width={120}>Asked on</HeadCell>
                <HeadCell width={230}>Why it is Dead</HeadCell>
                <HeadCell width={170}>Lost for</HeadCell>
                <HeadCell width={100}>Decide</HeadCell>
              </>
            }
          >
            {queue.map((r, i) => (
              <Row key={r.id} striped={i % 2 === 1}>
                <Cell truncate={220}>
                  <Link href={leadHref(r.customerId)} className="font-medium text-ink no-underline hover:text-brand hover:underline">
                    {r.leadName}
                  </Link>
                  <span className="block truncate text-[12px] text-muted">
                    {[r.companyName, r.city].filter(Boolean).join(" · ") || "—"}
                  </span>
                </Cell>
                <Cell truncate={160}>{r.requestedByName ?? "—"}</Cell>
                <Cell>{when(r.requestedAt)}</Cell>
                <Cell truncate={230}>
                  {labelOf(reasons.length ? reasons : DEAD_REASONS, r.reasonCode)}
                  {r.note ? <span className="block truncate text-[12px] text-muted">{r.note}</span> : null}
                </Cell>
                <Cell truncate={170}>{labelOf(LOST_REASONS, r.lostReasonAtRequest)}</Cell>
                <Cell>
                  <Button onClick={() => setDeciding(r)}>Review</Button>
                </Cell>
              </Row>
            ))}
          </Table>
        ) : (
          <Empty
            title="Nothing is waiting on you"
            body="Only requests the Org Chart routed to you appear here — nobody else's, and nothing is broadcast to every manager."
          />
        )
      ) : mine.length ? (
        <Table
          minWidth={1290}
          head={
            <>
              <HeadCell width={220}>Lead</HeadCell>
              <HeadCell width={130}>Status</HeadCell>
              <HeadCell width={190}>Action</HeadCell>
              <HeadCell width={150}>Asked by</HeadCell>
              <HeadCell width={150}>Decided by</HeadCell>
              <HeadCell width={120}>Asked on</HeadCell>
              <HeadCell width={120}>Decided on</HeadCell>
              <HeadCell width={210}>Reason</HeadCell>
            </>
          }
        >
          {mine.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell truncate={220}>
                <Link href={leadHref(r.customerId)} className="font-medium text-ink no-underline hover:text-brand hover:underline">
                  {r.leadName}
                </Link>
              </Cell>
              <Cell>
                <Pill tone={r.state === "approved" ? "danger" : r.state === "rejected" || r.state === "withdrawn" ? "neutral" : "warn"}>
                  {DEAD_REQUEST_STATE_LABEL[r.state]}
                </Pill>
              </Cell>
              <Cell>{r.state === "pending" && r.requestedById === viewerId ? <WithdrawButton requestId={r.id} size="sm" /> : null}</Cell>
              <Cell truncate={150}>{r.requestedByName ?? "—"}</Cell>
              <Cell truncate={150}>{r.decidedByName ?? (r.state === "pending" ? `Waiting on ${r.approverName ?? "—"}` : "—")}</Cell>
              <Cell>{when(r.requestedAt)}</Cell>
              <Cell>{when(r.decidedAt)}</Cell>
              <Cell truncate={210}>
                {labelOf(DEAD_REASONS, r.reasonCode)}
                {r.decisionNote ? <span className="block truncate text-[12px] text-muted">Reply: {r.decisionNote}</span> : null}
              </Cell>
            </Row>
          ))}
        </Table>
      ) : (
        <Empty title="No Dead requests" body="Requests you ask for, or are asked to decide, are listed here — rejected ones included." />
      )}

      {deciding ? <DecideDeadDialog key={deciding.id} request={deciding} reasons={reasons} onClose={() => setDeciding(null)} /> : null}
    </div>
  );
}

function DeadList({
  list,
  typed,
  onTyped,
  go,
  reasons,
}: {
  list: { rows: DeadLeadRow[]; total: number; page: number; pageCount: number; perPage: number };
  typed: string;
  onTyped: (v: string) => void;
  go: (patch: Record<string, string | number | undefined>) => void;
  reasons: { code: string; label: string }[];
}) {
  return (
    <div className="rounded-[6px] border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <input
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          aria-label="Search dead leads"
          placeholder="Search a shop, a town, a phone number, an owner…"
          className="h-8.5 w-[280px] rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-brand"
        />
        <span className="flex-1" />
        <span className="text-[13px] text-muted">{plural(list.total, "dead lead")}</span>
      </div>
      {list.rows.length === 0 ? (
        <div className="px-4 py-14 text-center text-muted">No lead has been approved as Dead{typed ? " that matches" : " yet"}.</div>
      ) : (
        <Table
          chrome={false}
          minWidth={1480}
          head={
            <>
              <HeadCell width={230}>Lead</HeadCell>
              <HeadCell width={150}>Owner</HeadCell>
              <HeadCell width={210}>Dead reason</HeadCell>
              <HeadCell width={150}>Requested by</HeadCell>
              <HeadCell width={150}>Approved by</HeadCell>
              <HeadCell width={120}>Approved on</HeadCell>
              <HeadCell width={180}>Lost for</HeadCell>
              <HeadCell width={140}>Lost from</HeadCell>
              <HeadCell width={100}>Status</HeadCell>
            </>
          }
        >
          {list.rows.map((l, i) => (
            <Row key={l.id} striped={i % 2 === 1}>
              <Cell truncate={230}>
                <Link href={leadHref(l.id)} className="font-medium text-ink no-underline hover:text-brand hover:underline">
                  {l.name}
                </Link>
                <span className="block truncate text-[12px] text-muted">
                  {[l.companyName, l.city].filter(Boolean).join(" · ") || l.mobile || "—"}
                </span>
              </Cell>
              <Cell truncate={150}>{l.ownerName ?? <span className="text-muted">Nobody</span>}</Cell>
              <Cell truncate={210}>
                {labelOf(reasons.length ? reasons : DEAD_REASONS, l.deadReasonCode)}
                {l.deadNote ? <span className="block truncate text-[12px] text-muted">{l.deadNote}</span> : null}
              </Cell>
              <Cell truncate={150}>{l.requestedByName ?? "—"}</Cell>
              <Cell truncate={150}>{l.approvedByName ?? "—"}</Cell>
              <Cell>{when(l.deadAt)}</Cell>
              <Cell truncate={180}>{labelOf(LOST_REASONS, l.lostReason)}</Cell>
              <Cell truncate={140}>{l.lostFromStage ? stageLabel(l.lostFromStage as LeadStage) : "—"}</Cell>
              <Cell>
                <Pill tone="danger">Dead</Pill>
              </Cell>
            </Row>
          ))}
        </Table>
      )}
      {list.total > list.perPage ? (
        <div className="flex items-center gap-3 border-t border-line bg-canvas px-4 py-2.5 text-[13px] text-muted">
          <span>
            {(list.page - 1) * list.perPage + 1}&ndash;{Math.min(list.page * list.perPage, list.total)} of {list.total}
          </span>
          <span className="flex-1" />
          <Button tone="default" size="sm" disabled={list.page <= 1} onClick={() => go({ page: list.page - 1 })}>
            Previous
          </Button>
          <span className="tabular-nums text-body">
            {list.page} / {list.pageCount}
          </span>
          <Button tone="default" size="sm" disabled={list.page >= list.pageCount} onClick={() => go({ page: list.page + 1 })}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
