"use client";

import * as React from "react";
import Link from "next/link";
import { Cell, Empty, HeadCell, Row, Table } from "@/components/console/parts";
import { VISIT_OUTCOME_LABEL, label, plural } from "@/components/console/words";
import { Modal } from "@/components/ui/modal";
import { cx } from "@/components/ui/primitives";

/**
 * Today's table, and the day a row opens.
 *
 * The arithmetic stays on the server in `today-tab.tsx` — it reads the trail,
 * which does not cross to a browser — and this draws the rows it worked out.
 * A row opens the salesman's day in a modal: his route stop by stop, the shops
 * he actually walked into, and the ways on to his map and his month. It used
 * to be a menu of five links, each of which left the page.
 */

export type TodayRow = {
  id: string;
  name: string;
  initials: string;
  planned: number;
  done: number;
  offPlan: number;
  km: string;
  adherencePct: number | null;
  note: string;
  hasFixes: boolean;
  city: string | null;
  route: Array<{ id: string; name: string; status: string; skipReason: string | null }>;
  walked: Array<{
    id: string;
    name: string;
    at: string | null;
    outcome: string;
    wasPlanned: boolean;
    verified: boolean;
  }>;
};

export function TodayTable({ rows, today }: { rows: TodayRow[]; today: string }) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const open = rows.find((r) => r.id === openId) ?? null;

  if (rows.length === 0) {
    return <Empty title="Nobody in the field" body="No active salesman holds the Salesman App yet." />;
  }

  return (
    <>
      <Table
        minWidth={840}
        head={
          <>
            <HeadCell width={210}>Salesman</HeadCell>
            <HeadCell width={150}>City</HeadCell>
            <HeadCell width={90}>Stops</HeadCell>
            <HeadCell align="right" width={80}>
              Off plan
            </HeadCell>
            <HeadCell align="right" width={90}>
              Distance
            </HeadCell>
            <HeadCell width={110}>Adherence</HeadCell>
            <HeadCell width={110}>Note</HeadCell>
          </>
        }
      >
        {rows.map((r, i) => (
          <Row key={r.id} striped={i % 2 === 1} onClick={() => setOpenId(r.id)}>
            <Cell>
              <span className="flex items-center gap-2.5">
                <span className="flex size-7 flex-none items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-[#5223E0]">
                  {r.initials}
                </span>
                <span className="truncate font-medium text-ink">{r.name}</span>
              </span>
            </Cell>
            <Cell>
              <span className="block truncate">{r.city ?? <span className="text-muted">—</span>}</span>
            </Cell>
            <Cell>
              <span className="tabular-nums">
                {r.done}/{r.planned || "—"}
              </span>
            </Cell>
            <Cell align="right">{r.offPlan || <span className="text-muted">—</span>}</Cell>
            <Cell align="right">{r.km}</Cell>
            <Cell>
              {r.adherencePct === null ? (
                <span className="text-muted">—</span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <span className="block h-1.5 w-[44px] overflow-hidden rounded-[3px] bg-divider">
                    <span
                      className={cx(
                        "block h-full",
                        r.adherencePct >= 80 ? "bg-success" : r.adherencePct >= 50 ? "bg-warn" : "bg-danger",
                      )}
                      style={{ width: `${Math.min(100, r.adherencePct)}%` }}
                    />
                  </span>
                  <span className="text-[12px] text-ink tabular-nums">{r.adherencePct}%</span>
                </span>
              )}
            </Cell>
            <Cell title={r.note}>
              <span className={cx("block truncate text-[12px]", r.note === "—" ? "text-muted" : "text-body")}>
                {r.note}
              </span>
            </Cell>
          </Row>
        ))}
      </Table>

      {open ? <DayModal key={open.id} r={open} today={today} onClose={() => setOpenId(null)} /> : null}
    </>
  );
}

function DayModal({ r, today, onClose }: { r: TodayRow; today: string; onClose: () => void }) {
  const base = `/sales/journeys?tab=salesman&salesman=${r.id}`;
  return (
    <Modal
      open
      onClose={onClose}
      width={680}
      title={
        <span className="block">
          {r.name}
          <span className="block text-[12px] font-normal text-muted">
            Today{r.city ? ` · ${r.city}` : ""} · {r.done}/{r.planned || 0} stops · {r.km}
          </span>
        </span>
      }
      footer={
        <>
          <FooterLink href={`/sales/live?salesman=${r.id}&view=today`} newTab>
            Live map
          </FooterLink>
          <FooterLink href={`/sales/journeys?tab=visits&salesman=${r.id}`}>Visit log</FooterLink>
          <FooterLink href={`${base}&month=${today.slice(0, 7)}&open=${today}`} primary>
            Open his calendar
          </FooterLink>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-5">
        <section>
          <h3 className="mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Route · {plural(r.route.length, "stop")}
          </h3>
          {r.route.length ? (
            <ol className="space-y-1">
              {r.route.map((s, i) => (
                <li key={s.id} className="flex items-start gap-2 text-[13px]">
                  <span className="w-4 flex-none text-right text-[11px] text-muted tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{s.name}</span>
                    {s.skipReason ? <span className="block truncate text-[11px] text-muted">{s.skipReason}</span> : null}
                  </span>
                  <StopPill status={s.status} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[13px] text-muted">No route planned today.</p>
          )}
        </section>

        <section>
          <h3 className="mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Visited · {r.walked.length}
          </h3>
          {r.walked.length ? (
            <ol className="space-y-1">
              {r.walked.map((v) => (
                <li key={v.id} className="flex items-start gap-2 text-[13px]">
                  <span className="w-10 flex-none text-[11px] text-muted tabular-nums">{v.at ? clock(v.at) : "—"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{v.name}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {label(VISIT_OUTCOME_LABEL, v.outcome)}
                      {!v.wasPlanned ? <span className="text-warn-ink"> · off route</span> : null}
                      {!v.verified ? <span className="text-warn-ink"> · unverified</span> : null}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[13px] text-muted">No visits yet.</p>
          )}
        </section>
      </div>
    </Modal>
  );
}

function StopPill({ status }: { status: string }) {
  const skin =
    status === "visited"
      ? "bg-success-soft text-success"
      : status === "skipped"
        ? "bg-divider text-muted"
        : "bg-warn-soft text-warn-ink";
  const word = status === "visited" ? "Visited" : status === "skipped" ? "Skipped" : "Pending";
  return <span className={cx("flex-none rounded-[9px] px-2 text-[11px] font-medium", skin)}>{word}</span>;
}

function FooterLink({
  href,
  children,
  primary = false,
  newTab = false,
}: {
  href: string;
  children: React.ReactNode;
  primary?: boolean;
  newTab?: boolean;
}) {
  return (
    <Link
      href={href}
      target={newTab ? "_blank" : undefined}
      rel={newTab ? "noopener" : undefined}
      className={cx(
        "inline-flex h-8 items-center rounded-[4px] px-3 text-[13px] no-underline hover:no-underline",
        primary ? "bg-brand font-medium text-white hover:opacity-90" : "border border-line bg-surface text-body hover:bg-canvas",
      )}
    >
      {children}
    </Link>
  );
}

/**
 * `09:32` in Asia/Kolkata, by arithmetic rather than Intl: this renders on the
 * server and again in the browser, and the two must spell it identically.
 * India keeps no daylight saving, so the offset is fixed.
 */
function clock(iso: string): string {
  const ist = new Date(new Date(iso).getTime() + 330 * 60_000);
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const mm = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
