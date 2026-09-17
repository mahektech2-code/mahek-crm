"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { money } from "@/lib/format";
import { APP_TIMEZONE, addDays } from "@/lib/business-date";
import { useToast } from "@/components/ui/toast";
import { acceptVisit, askAboutVisit, decidePinCorrection } from "@/lib/actions/sales";
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
  SortHead,
  Table,
} from "@/components/console/parts";
import { CustomerName } from "@/components/console/customer-name";
import { readSort, sortHref, sortRows, type SortColumns } from "@/components/console/sort";
import { VISIT_OUTCOME_LABEL, label } from "@/components/console/words";

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

  /*
   * THE SORT IS A URL HERE, THOUGH THIS IS A CLIENT COMPONENT.
   *
   * `sort.ts` argues for a link rather than component state so a manager who
   * has sorted to what is worst can send that to somebody, and the argument
   * does not stop applying because the screen also holds a modal. The day and
   * the filter chips on this screen are ALREADY search params — the chips are
   * plain links and the page re-reads `day` on the server — so holding the
   * sort in React state instead would give one table two kinds of memory: two
   * of its three controls survive a reload and the third does not.
   *
   * It is read with `useSearchParams` rather than taken as a prop because the
   * page component hands this screen `day` and `show` and nothing else, and a
   * sort that is display-only has no business making the server re-run
   * `visitsList` to answer for it.
   *
   * Sorting is display-only, which is the half worth stating: the four figures
   * above — the count, the unverified, the off-plan and the time in shops —
   * are all counted over `all` and never over the sorted copy, so none of them
   * moves when a column is clicked.
   */
  const search = useSearchParams();
  const sort = readSort(
    { sort: search.get("sort") ?? undefined, dir: search.get("dir") ?? undefined },
    COLUMNS,
  );
  const sorted = sortRows(rows, sort, COLUMNS);
  /* `text` rather than `label`, which is the name of the outcome resolver this
     file already imports — one shadowing the other would compile and read as a
     mistake to whoever came next. */
  const head = (key: string, text: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/visits", sort, key, `day=${day}&show=${show}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {text}
    </SortHead>
  );

  async function accept(v: VisitRow) {
    const result = await acceptVisit({ visitId: v.id });
    if (!result.ok) {
      toast.push(result.error);
      return;
    }
    toast.push(result.message ?? "Accepted.");
    router.refresh();
  }

  /**
   * He said the shop is not where the book has it. One of the two is wrong,
   * and this is where somebody decides which.
   *
   * No coordinates are sent: what is being accepted is the check-in fix
   * already on the row, which is the point the manager can see on the map link
   * beside it. It deliberately does not touch `verified` — accepting the pin
   * says the book was wrong, and standing behind the visit is the item above.
   */
  async function decidePin(v: VisitRow, accept: boolean) {
    const result = await decidePinCorrection({ visitId: v.id, accept });
    if (!result.ok) {
      toast.push(result.error);
      return;
    }
    toast.push(result.message ?? "Done.");
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
              {head("salesman", "Salesman", 170)}
              {head("customer", "Customer", 200)}
              {head("in", "At", 80)}
              {head("duration", "Inside", 80, "right")}
              {head("distance", "From shop", 110, "right")}
              {head("outcome", "Outcome", 150)}
              <HeadCell align="right" width={80}>Photos</HeadCell>
              {head("value", "Value", 130, "right")}
              <HeadCell>State</HeadCell>
              <HeadCell width={44} />
            </>
          }
        >
          {sorted.map((v, i) => (
            <Row key={v.id} striped={i % 2 === 1}>
              <Cell truncate={170}>
                <Link
                  href={`/sales/people/${v.salesmanId}`}
                  className="no-underline"
                >
                  {v.salesmanName}
                </Link>
              </Cell>
              <Cell truncate={200}>
                <CustomerName id={v.customerId} name={v.customerName} />
              </Cell>
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
                {/*
                  A REQUEST IS A THING TO DO, so it is drawn as one rather than
                  folded into the sentence underneath. "He says the shop is
                  somewhere else" is the row a manager should be able to find
                  by eye on a day of forty visits — the reason he gave is on
                  the line below, and the two are different facts.
                */}
                {v.pinCorrection ? (
                  <span
                    className="ml-1.5"
                    /* Truthiness only, never formatted — `visitsList` runs
                       raw SQL through `db.execute`, which hands back a STRING
                       where the type says Date, and `acceptedAt` beside it is
                       read the same way for the same reason. */
                    title={
                      v.pinCorrectionDecidedAt
                        ? "Somebody has answered this."
                        : "Waiting for somebody to answer this."
                    }
                  >
                    <Pill tone={v.pinCorrection === "requested" ? "warn" : "neutral"}>
                      {v.pinCorrection === "requested"
                        ? "Pin questioned"
                        : v.pinCorrection === "accepted"
                          ? "Pin moved"
                          : "Pin kept"}
                    </Pill>
                  </span>
                ) : null}
                {v.unverifiedReason || v.deviationReason ? (
                  <span className="block truncate text-[12px] text-muted">
                    {v.unverifiedReason ?? v.deviationReason}
                  </span>
                ) : null}
                {/*
                  HIS OWN WORDS, IN FULL AND NOT TRUNCATED.

                  The server folds this into `unverifiedReason` above, which is
                  right — that is the column every other screen and any export
                  reads. But that sentence leads with the distance and truncates
                  at the column width, so the half that gets cut is the half a
                  manager is actually deciding on: a salesman refused at a shop
                  door typed this standing in front of the shopkeeper, and it is
                  the only account anybody has of why the book and the man
                  disagree. It gets its own line and wraps.
                */}
                {v.checkInOverrideReason ? (
                  <span className="mt-0.5 block text-[12px] text-body italic">
                    &ldquo;{v.checkInOverrideReason}&rdquo;
                  </span>
                ) : null}
                {v.checkInLat != null || v.checkOutLat != null ? (
                  <span className="mt-0.5 flex gap-2.5 text-[12px]">
                    {v.checkInLat != null && v.checkInLng != null ? (
                      <a
                        href={`https://www.google.com/maps?q=${v.checkInLat},${v.checkInLng}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-brand no-underline"
                        title={
                          v.checkInAccuracyM != null
                            ? `Accurate to about ${v.checkInAccuracyM} m`
                            : "Accuracy was not reported"
                        }
                      >
                        Check-in ↗
                      </a>
                    ) : null}
                    {v.checkOutLat != null && v.checkOutLng != null ? (
                      <a
                        href={`https://www.google.com/maps?q=${v.checkOutLat},${v.checkOutLng}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-brand no-underline"
                        title={
                          v.checkOutAccuracyM != null
                            ? `Accurate to about ${v.checkOutAccuracyM} m`
                            : "Accuracy was not reported"
                        }
                      >
                        Check-out ↗
                      </a>
                    ) : null}
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
                    /*
                      Only where somebody asked. Offered on every row it would
                      be a way to move a shop's pin from a table of visits,
                      which is a different thing to answering a request — and
                      one nobody standing at the shop had made.
                    */
                    ...(v.pinCorrection === "requested"
                      ? [
                          {
                            label: "Move the shop's pin here",
                            run: () => void decidePin(v, true),
                            disabled: v.checkInLat == null,
                            title:
                              v.checkInLat == null
                                ? "That check-in carried no location to move it to."
                                : undefined,
                          },
                          {
                            label: "Leave the pin as it is",
                            run: () => void decidePin(v, false),
                          },
                        ]
                      : []),
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

const COLUMNS: SortColumns<VisitRow> = {
  salesman: (v) => v.salesmanName,
  customer: (v) => v.customerName,
  /* `visitsList` runs raw SQL through `db.execute`, which hands back a STRING
     where the type says Date — the same reading the pin-correction pill makes
     two hundred lines up. `new Date` takes either, and a full ISO instant
     carries its own zone, so nothing here has to name one. */
  in: (v) => (v.checkInAt ? new Date(v.checkInAt).getTime() : null),
  /* A visit that never closed has no duration, and it sorts LAST under both
     directions rather than reading as the longest one. He walked out of signal
     or forgot to check out; neither is a long visit, and floating those rows to
     the top of "longest first" would answer the question with the only rows
     that cannot answer it. The open ones are worth finding, and the Unverified
     chip is where that is asked. */
  duration: (v) => v.durationSeconds,
  /* Null is a visit there was nothing to measure against — a shop with no pin,
     or a check-in with no fix — and it is not a distance of zero. Zero would
     read as having stood exactly on the doorway, which is the most reassuring
     answer on the column and the one row nobody established. */
  distance: (v) => v.distanceFromShopM,
  /* The words on the screen rather than the stored code, so an alphabetical
     sort puts the rows in the order somebody reading the column sees. */
  outcome: (v) => label(VISIT_OUTCOME_LABEL, v.outcome),
  /* Zero is a real answer here, unlike a missing duration: a visit with no
     order is a visit where nothing was bought, which is a fact and not an
     absence. It is drawn as a dash and it sorts as the nothing it is. */
  value: (v) => Number(v.orderValuePaise),
};

/** Named, because this renders on a server that is not in Asia/Kolkata. */
function clock(at: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}
