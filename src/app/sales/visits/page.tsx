import Link from "next/link";
import { money } from "@/lib/format";
import { APP_TIMEZONE, addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { visitsList } from "@/lib/services/sales-service";
import {
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";
import {
  VISIT_OUTCOME_LABEL,
  label,
} from "../words";

export const metadata = { title: "Visits — Sales Dashboard — MahekOne" };

/**
 * Every visit logged on a day.
 *
 * The design's subtitle carries the rule that matters: **an unverified visit
 * still counts as work — it needs a word from you.** The handset saves a visit
 * whatever the checklist says, because refusing teaches people to stop logging
 * them and then the office knows nothing rather than something imperfect. What
 * it records instead is WHY it could not be verified, and that sentence is the
 * column a manager reads.
 *
 * An off-plan visit is treated the same way: it is ordinary — a shop that
 * called, a walk-in on the way past — and it carries the reason the salesman
 * gave rather than a flag implying he went wandering.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; show?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.day ?? "") ? params.day! : now;

  const all = await visitsList(day);
  const show = ["all", "unverified", "offplan"].includes(params.show ?? "")
    ? params.show!
    : "all";

  const unverified = all.filter((v) => !v.verified);
  const offPlan = all.filter((v) => !v.wasPlanned);
  const rows = show === "unverified" ? unverified : show === "offplan" ? offPlan : all;

  const minutes = all.reduce((n, v) => n + (v.durationSeconds ?? 0), 0) / 60;

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
            <span className="px-2 text-muted">{longDay(day)}</span>
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
          minWidth={1240}
          head={
            <>
              <HeadCell width={170}>Salesman</HeadCell>
              <HeadCell width={210}>Customer</HeadCell>
              <HeadCell width={90}>At</HeadCell>
              <HeadCell width={90}>Inside</HeadCell>
              <HeadCell width={150}>Outcome</HeadCell>
              <HeadCell align="right" width={90}>Photos</HeadCell>
              <HeadCell align="right" width={140}>Order</HeadCell>
              <HeadCell>State</HeadCell>
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
              <Cell truncate={210}>{v.customerName}</Cell>
              <Cell>{v.checkInAt ? clock(v.checkInAt) : <span className="text-muted">—</span>}</Cell>
              <Cell>
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
                  <Pill tone="success">Verified</Pill>
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
                {v.checkInLat != null || v.checkOutLat != null ? (
                  <span className="mt-0.5 flex gap-2.5 text-[12px]">
                    {v.checkInLat != null && v.checkInLng != null ? (
                      <a
                        href={`https://www.google.com/maps?q=${v.checkInLat},${v.checkInLng}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand no-underline hover:underline"
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
                        className="text-brand no-underline hover:underline"
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
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}


function longDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
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
