"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { money } from "@/lib/format";
import { APP_TIMEZONE, addDays } from "@/lib/business-date";
import { useToast } from "@/components/ui/toast";
import { acceptVisit, askAboutVisit } from "@/lib/actions/sales";
import type { VisitRow } from "@/lib/services/sales-service";
import {
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  ReasonModal,
  Row,
  RowMenu,
  ScreenHeader,
  Table,
} from "../parts";
import { VISIT_OUTCOME_LABEL, label } from "../words";

/**
 * The interactive half of Visits — the table itself is server-rendered data,
 * this is the `···` row menu the design carries on every one of these
 * screens: standing behind a visit the phone could not verify ("Accept it
 * anyway"), or asking the salesman about it rather than taking the phone's
 * word for it either way ("Ask them to explain" — a required reason, the
 * same `askReason(...)` pattern as archiving a lead).
 */
export function VisitsScreen({
  day,
  longDay,
  all,
  show,
  mismatchThresholdM,
}: {
  day: string;
  longDay: string;
  all: VisitRow[];
  show: string;
  mismatchThresholdM: number;
}) {
  const router = useRouter();
  const toast = useToast();

  const [asking, setAsking] = React.useState<VisitRow | null>(null);
  const [question, setQuestion] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const unverified = all.filter((v) => !v.verified);
  const offPlan = all.filter((v) => !v.wasPlanned);
  const rows = show === "unverified" ? unverified : show === "offplan" ? offPlan : all;

  const minutes = all.reduce((n, v) => n + (v.durationSeconds ?? 0), 0) / 60;

  async function accept(v: VisitRow) {
    const result = await acceptVisit({ visitId: v.id });
    if (!result.ok) {
      toast.push(result.error);
      return;
    }
    toast.push(result.message ?? "Accepted.");
    router.refresh();
  }

  async function submitAsk() {
    if (!asking) return;
    setBusy(true);
    setError(null);
    try {
      const result = await askAboutVisit({ visitId: asking.id, question });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAsking(null);
      toast.push(result.message ?? "Asked.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6">
      <ScreenHeader
        title="Visits"
        subtitle="Every visit logged, how long they stayed and whether the phone agreed they were at the shop. An unverified visit still counts as work — it needs a word from you, not a red mark."
        actions={
          <div className="flex items-center gap-1 text-[13px]">
            <Link
              href={`/sales/visits?day=${addDays(day, -1)}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              ←
            </Link>
            <span className="px-2 text-muted">{longDay}</span>
            <Link
              href={`/sales/visits?day=${addDays(day, 1)}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              →
            </Link>
          </div>
        }
      />

      <MetricRow
        metrics={[
          { label: "Visits", value: String(all.length) },
          {
            label: "Unverified",
            value: String(unverified.length),
            sub: unverified.length ? "each has a reason" : "all check out",
            tone: unverified.length ? "warn" : "success",
          },
          {
            label: "Off plan",
            value: String(offPlan.length),
            sub: offPlan.length ? "ordinary, but worth reading" : undefined,
          },
          {
            label: "Time in shops",
            value: minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes)}m`,
            sub: all.length ? `about ${Math.round(minutes / all.length)} min a visit` : undefined,
          },
        ]}
      />

      <FilterChips
        current={show}
        options={[
          { key: "all", href: `/sales/visits?day=${day}&show=all`, label: "Every visit", count: all.length },
          { key: "unverified", href: `/sales/visits?day=${day}&show=unverified`, label: "Could not be verified", count: unverified.length },
          { key: "offplan", href: `/sales/visits?day=${day}&show=offplan`, label: "Off the plan", count: offPlan.length },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title={
            show === "unverified"
              ? "Every visit checks out"
              : show === "offplan"
                ? "Everybody stayed on plan"
                : "No visits logged"
          }
          body={
            show === "all"
              ? "Nothing has come off a handset for this day. A visit reaches the office on the next sync, so a salesman with no signal will appear later rather than not at all."
              : "Nothing here is waiting on a word from you."
          }
        />
      ) : (
        <Table
          minWidth={1360}
          head={
            <>
              <HeadCell width={170}>Salesman</HeadCell>
              <HeadCell width={200}>Customer</HeadCell>
              <HeadCell width={80}>At</HeadCell>
              <HeadCell align="right" width={80}>Inside</HeadCell>
              <HeadCell align="right" width={110}>From shop</HeadCell>
              <HeadCell width={150}>Outcome</HeadCell>
              <HeadCell align="right" width={80}>Photos</HeadCell>
              <HeadCell align="right" width={130}>Value</HeadCell>
              <HeadCell>State</HeadCell>
              <HeadCell width={44} />
            </>
          }
        >
          {rows.map((v, i) => (
            <Row key={v.id} striped={i % 2 === 1}>
              <Cell truncate={170}>
                <Link
                  href={`/sales/people/${v.salesmanId}`}
                  className="no-underline hover:underline"
                >
                  {v.salesmanName}
                </Link>
              </Cell>
              <Cell truncate={200}>{v.customerName}</Cell>
              <Cell>{v.checkInAt ? clock(v.checkInAt) : <span className="text-muted">—</span>}</Cell>
              <Cell align="right">
                {v.durationSeconds != null ? (
                  `${Math.round(v.durationSeconds / 60)}m`
                ) : (
                  <span
                    className="text-muted"
                    title="The visit never closed — the salesman walked out of signal or did not check out."
                  >
                    open
                  </span>
                )}
              </Cell>
              <Cell
                align="right"
                className={
                  v.distanceFromShopM != null && v.distanceFromShopM > mismatchThresholdM
                    ? "font-medium text-danger"
                    : undefined
                }
              >
                {v.distanceFromShopM != null ? `${v.distanceFromShopM} m` : <span className="text-muted">—</span>}
              </Cell>
              <Cell>{label(VISIT_OUTCOME_LABEL, v.outcome)}</Cell>
              <Cell align="right">
                {v.photos || <span className="text-muted">—</span>}
              </Cell>
              <Cell align="right">
                {Number(v.orderValuePaise) ? (
                  money(v.orderValuePaise)
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Cell>
              <Cell truncate={340}>
                {v.verified ? (
                  <Pill tone="success">{v.acceptedAt ? "Accepted" : "Verified"}</Pill>
                ) : (
                  <Pill tone="warn">{v.locationMismatch ? "Wrong place" : "Unverified"}</Pill>
                )}
                {!v.wasPlanned ? (
                  <span className="ml-1.5">
                    <Pill>Off plan</Pill>
                  </span>
                ) : null}
                {v.unverifiedReason || v.deviationReason ? (
                  <span className="block truncate text-[12px] text-muted">
                    {v.unverifiedReason ?? v.deviationReason}
                  </span>
                ) : null}
              </Cell>
              <Cell align="right" onClick={(e) => e.stopPropagation()}>
                <RowMenu
                  items={[
                    {
                      label: "Accept it anyway",
                      run: () => void accept(v),
                      disabled: v.verified,
                      title: v.verified ? "Already verified." : undefined,
                    },
                    {
                      label: "Ask them to explain",
                      run: () => {
                        setAsking(v);
                        setQuestion("");
                        setError(null);
                      },
                    },
                  ]}
                />
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      <ReasonModal
        open={Boolean(asking)}
        onClose={() => setAsking(null)}
        title="Ask about this visit"
        subject={asking?.customerName}
        subjectDetail={asking ? `${asking.salesmanName} · ${label(VISIT_OUTCOME_LABEL, asking.outcome)}` : undefined}
        fieldLabel="What do you want to ask · required"
        reason={question}
        onReasonChange={setQuestion}
        confirmLabel="Send it"
        danger={false}
        busy={busy}
        error={error}
        onConfirm={() => void submitAsk()}
      />
    </div>
  );
}

/** Named, because this renders on a server that is not in Asia/Kolkata. */
function clock(at: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}
