"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { Pager } from "@/components/ui/pager";
import { Pill } from "@/components/console/parts";
import { cx } from "@/components/ui/primitives";
import { longDate } from "@/lib/format";
import { FIELD_ACTIVITY_COL } from "@/lib/field-activity-parse";
import type { FieldActivityRow } from "@/lib/services/sales-service";

/* ---------------------------------------------------------------------------
 * The activity log as a table that fits beside the sidebar and wraps rather
 * than clips — every name, every date and the start of every note readable
 * without hovering — and a row that opens the whole record.
 *
 * It does not use the console's `Table`, on purpose: that one clips every cell
 * to one line, which is right for a fourteen-column ledger and wrong for a log
 * whose whole content is a shop name and a sentence somebody typed in a shop.
 * ------------------------------------------------------------------------- */

const MATCH_TONE = {
  matched: "success",
  ambiguous: "warn",
  unmatched: "neutral",
  pending: "neutral",
} as const;
const MATCH_LABEL = {
  matched: "Matched",
  ambiguous: "Needs review",
  unmatched: "No match",
  pending: "Pending",
} as const;
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** "Wednesday" for "2026-10-07". A date-only value, so read in UTC on purpose. */
function weekday(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
}

function minutes(n: number | null): string | null {
  if (n == null) return null;
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  return n % 60 ? `${h} h ${n % 60} min` : `${h} h`;
}

/**
 * What a date says about the salesman it is filed under, from HRMS. A visit dated
 * after somebody left, or before they joined, is the clearest sign the date or
 * the name is wrong — and it is said on the row, not discovered in a review.
 */
export function salesmanWarning(r: FieldActivityRow): string | null {
  if (r.visitDate && r.dateOfLeaving && r.visitDate > r.dateOfLeaving) {
    return `Dated after leaving (${longDate(r.dateOfLeaving)})`;
  }
  if (r.visitDate && r.dateOfJoining && r.visitDate < r.dateOfJoining) {
    return `Dated before joining (${longDate(r.dateOfJoining)})`;
  }
  return null;
}

function salesmanStatus(
  r: FieldActivityRow,
): { text: string; tone: "warn" | "muted" } | null {
  const warning = salesmanWarning(r);
  if (warning) return { text: warning, tone: "warn" };
  if (r.employmentStatus === "inactive") {
    return {
      text: r.dateOfLeaving
        ? `Left ${longDate(r.dateOfLeaving)}`
        : "No longer working here",
      tone: "muted",
    };
  }
  if (r.salesmanAccountActive === false)
    return { text: "Sign-in disabled", tone: "muted" };
  if (!r.salesmanId) return { text: "No MahekOne account", tone: "muted" };
  return null;
}

export function ActivityTable({
  rows,
  total,
  page,
  perPage,
  baseQuery,
}: {
  rows: FieldActivityRow[];
  total: number;
  page: number;
  perPage: number;
  /** The filters in force, without page or per-page. */
  baseQuery: string;
}) {
  const router = useRouter();
  const [openId, setOpenId] = React.useState<string | null>(null);
  const open = rows.find((r) => r.id === openId) ?? null;

  const go = (p: number, n: number) => {
    const qs = new URLSearchParams(baseQuery);
    if (p > 1) qs.set("page", String(p));
    if (n !== 50) qs.set("per", String(n));
    router.push(`/sales/activity-history?${qs.toString()}`);
  };

  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col style={{ width: 118 }} />
          <col style={{ width: "17%" }} />
          <col style={{ width: "21%" }} />
          <col style={{ width: 156 }} />
          <col />
          <col style={{ width: 118 }} />
        </colgroup>
        <thead>
          <tr>
            {[
              "Date",
              "Salesman",
              "Customer",
              "Visit",
              "What happened",
              "Match",
            ].map((h) => (
              <th
                key={h}
                className="sticky top-0 z-2 h-8.5 border-b border-line bg-canvas px-3 text-left text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const status = salesmanStatus(r);
            const note = [r.meetingNote, r.issueNote]
              .filter(Boolean)
              .join(" — ");
            return (
              <tr
                key={r.id}
                tabIndex={0}
                onClick={() => setOpenId(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenId(r.id);
                  }
                }}
                aria-label={`Open the activity of ${r.visitDate ? longDate(r.visitDate) : "an unknown date"}`}
                className="cursor-pointer border-b border-divider align-top last:border-b-0 hover:bg-brand-soft focus-visible:bg-brand-soft focus-visible:outline-none"
              >
                <td className="px-3 py-2.5 text-sm">
                  {r.visitDate ? (
                    <>
                      <div className="font-medium whitespace-nowrap text-ink tabular-nums">
                        {longDate(r.visitDate)}
                      </div>
                      <div className="text-xs text-muted">
                        {weekday(r.visitDate)}
                      </div>
                    </>
                  ) : (
                    <span className="text-warn-ink">Date unreadable</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-sm break-words">
                  <div className="text-ink">
                    {r.salesmanName ?? r.employeeNameRaw ?? "—"}
                  </div>
                  {status ? (
                    <div
                      className={cx(
                        "text-xs",
                        status.tone === "warn"
                          ? "font-medium text-warn-ink"
                          : "text-muted",
                      )}
                    >
                      {status.text}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 text-sm break-words">
                  <div className="text-ink">
                    {r.customerName ?? r.customerNameRaw ?? "—"}
                  </div>
                  {r.customerCity ? (
                    <div className="text-xs text-muted">{r.customerCity}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 text-sm">
                  <div className="text-ink">
                    {r.meetingType ?? "—"}
                    {r.durationMinutes != null ? (
                      <span className="text-muted">
                        {" "}
                        · {minutes(r.durationMinutes)}
                      </span>
                    ) : null}
                  </div>
                  {r.meetingPurpose ? (
                    <div className="text-xs text-muted">{r.meetingPurpose}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 text-sm text-body">
                  {note ? (
                    <p className="line-clamp-2 break-words">{note}</p>
                  ) : (
                    <span className="text-muted">No note</span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <Pill tone={MATCH_TONE[r.customerMatchStatus]}>
                    {MATCH_LABEL[r.customerMatchStatus]}
                  </Pill>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Pager
        total={total}
        page={page}
        perPage={perPage}
        note="newest first · click a row for everything on it"
        onPage={(p) => go(p, perPage)}
        onPerPage={(n) => go(1, n)}
      />
      {open ? (
        <ActivityDetail
          key={open.id}
          row={open}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm break-words text-ink">
        {children ?? <span className="text-muted">—</span>}
      </dd>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-divider pt-3 first:border-t-0 first:pt-0">
      <h3 className="mb-2 text-[13px] font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

/** The sheet's columns in the sheet's order, then anything else it carried. */
function rawCells(raw: Record<string, string>): [string, string][] {
  const known: string[] = Object.values(FIELD_ACTIVITY_COL);
  const rest = Object.keys(raw)
    .filter((k) => !known.includes(k))
    .sort();
  return [...known, ...rest].filter((k) => k in raw).map((k) => [k, raw[k]]);
}

function ActivityDetail({
  row: r,
  onClose,
}: {
  row: FieldActivityRow;
  onClose: () => void;
}) {
  const warning = salesmanWarning(r);
  const sheetDate = r.raw[FIELD_ACTIVITY_COL.date] ?? "";

  return (
    <Modal
      open
      onClose={onClose}
      width={760}
      title={
        <span>
          {r.meetingType ?? "Activity"}
          {r.meetingPurpose ? ` · ${r.meetingPurpose}` : ""}
          <span className="ml-2 text-sm font-normal text-muted">
            {r.visitDate
              ? `${weekday(r.visitDate)}, ${longDate(r.visitDate)}`
              : "date unreadable"}
          </span>
        </span>
      }
      footer={
        <button
          onClick={onClose}
          className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas"
        >
          Close
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        {warning || r.issues.length ? (
          <div className="rounded-[6px] bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
            {warning ? (
              <p className="font-medium">
                {warning}. Check the date against the sheet below.
              </p>
            ) : null}
            {r.issues.map((i) => (
              <p key={`${i.column}-${i.problem}`}>
                {i.problem}
                {i.value ? ` — the sheet says “${i.value}”` : ""}
              </p>
            ))}
          </div>
        ) : null}

        <Section title="Activity">
          <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
            <Field label="Date">
              {r.visitDate ? longDate(r.visitDate) : null}
              {sheetDate ? (
                <span className="block text-xs text-muted">
                  Sheet: {sheetDate}
                </span>
              ) : null}
            </Field>
            <Field label="Time spent">{minutes(r.durationMinutes)}</Field>
            <Field label="Type">{r.meetingType}</Field>
            <Field label="Purpose">{r.meetingPurpose}</Field>
            <Field label="Mood / stage">{r.moodRaw}</Field>
            <Field label="Reminder">
              {r.reminderDate ? longDate(r.reminderDate) : null}
            </Field>
          </dl>
          <dl className="mt-3 grid grid-cols-1 gap-y-3">
            <Field label="Meeting note">
              {r.meetingNote ? (
                <span className="whitespace-pre-wrap">{r.meetingNote}</span>
              ) : null}
            </Field>
            {r.issueNote ? (
              <Field label="Issue">
                <span className="whitespace-pre-wrap">{r.issueNote}</span>
              </Field>
            ) : null}
            <Field label="Location">{r.location}</Field>
          </dl>
        </Section>

        <Section title="Salesman">
          <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
            <Field label="Name in the sheet">{r.employeeNameRaw}</Field>
            <Field label="MahekOne account">
              {r.salesmanId ? (
                <Link href={`/sales/people/${r.salesmanId}`}>
                  {r.salesmanName}
                </Link>
              ) : r.salesmanMatchStatus === "ambiguous" ? (
                "More than one account has this name"
              ) : (
                <span className="text-muted">None matches this name</span>
              )}
              {r.salesmanAccountActive === false ? (
                <span className="block text-xs text-muted">
                  Sign-in disabled
                </span>
              ) : null}
            </Field>
            <Field label="HRMS">
              {r.employmentStatus && r.employmentStatus !== "unknown" ? (
                <>
                  {r.employmentStatus === "active" ? "Working here" : "Left"}
                  <span className="block text-xs text-muted">
                    {[
                      r.dateOfJoining
                        ? `Joined ${longDate(r.dateOfJoining)}`
                        : null,
                      r.dateOfLeaving
                        ? `Left ${longDate(r.dateOfLeaving)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </>
              ) : r.salesmanId ? (
                <span className="text-muted">Account not linked to HRMS</span>
              ) : null}
            </Field>
          </dl>
        </Section>

        <Section title="Customer">
          <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
            <Field label="Name in the sheet">{r.customerNameRaw}</Field>
            <Field label="Matched to">
              {r.customerId ? (
                <>
                  <Link href={`/crm/customers/${r.customerId}`}>
                    {r.customerName}
                  </Link>
                  {r.customerCity ? (
                    <span className="block text-xs text-muted">
                      {r.customerCity}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-muted">
                  {r.customerMatchStatus === "ambiguous"
                    ? "Not decided — several are close"
                    : "No customer close enough"}
                </span>
              )}
            </Field>
            <Field label="Match">
              <Pill tone={MATCH_TONE[r.customerMatchStatus]}>
                {MATCH_LABEL[r.customerMatchStatus]}
              </Pill>
            </Field>
          </dl>
          {r.matchNote ? (
            <p className="mt-2 text-[13px] text-muted">{r.matchNote}</p>
          ) : null}
        </Section>

        <Section title="Exactly as the sheet has it">
          <p className="mb-2 text-xs text-muted">
            Activity ID {r.activityId} · row {r.rowNumber} of the Activity tab ·
            last read {r.readAt}
          </p>
          <table className="w-full table-fixed border-collapse text-[13px]">
            <tbody>
              {rawCells(r.raw).map(([k, v]) => (
                <tr
                  key={k}
                  className="border-b border-divider last:border-b-0 align-top"
                >
                  <td className="w-[150px] py-1.5 pr-3 text-muted">{k}</td>
                  <td className="py-1.5 break-words whitespace-pre-wrap text-ink">
                    {v || <span className="text-muted">blank</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </Modal>
  );
}
