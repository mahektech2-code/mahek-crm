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
import type {
  ActivityHistoryRow,
  FieldActivityRow,
  VisitRow,
} from "@/lib/services/sales-service";
import { accountTypeLabel } from "@/lib/account-types";
import { useToast } from "@/components/ui/toast";
import {
  activityShopChoices,
  decideActivityShop,
  searchActivityShops,
  undoActivityShopDecision,
  type ShopChoice,
  type ShopChoices,
} from "@/lib/actions/field-activity";
import { VISIT_OUTCOME_LABEL, label } from "@/components/console/words";
import { VisitDetail, VisitState, clock, useVisitActions } from "../journeys/visit-parts";

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

function rowKey(r: ActivityHistoryRow): string {
  return r.source === "mbos" ? `m:${r.visit.id}` : `s:${r.sheet.id}`;
}

const TH =
  "sticky top-0 z-2 h-8.5 border-b border-line bg-canvas px-3 text-left text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase";

export function ActivityTable({
  rows,
  total,
  page,
  perPage,
  baseQuery,
  canActOnVisits,
  canDecideShops,
}: {
  rows: ActivityHistoryRow[];
  total: number;
  page: number;
  perPage: number;
  /** The filters in force, without page or per-page. */
  baseQuery: string;
  /** Whether the visit actions (accept, ask, answer a pin) are this person's. */
  canActOnVisits: boolean;
  /** Whether this person may say which account an old-app shop name is. */
  canDecideShops: boolean;
}) {
  const router = useRouter();
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const open = rows.find((r) => rowKey(r) === openKey) ?? null;

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
          <col style={{ width: 132 }} />
        </colgroup>
        <thead>
          <tr>
            {["Date", "Salesman", "Customer", "Visit", "What happened", "Status"].map((h) => (
              <th key={h} className={TH}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = rowKey(r);
            return (
              <tr
                key={key}
                tabIndex={0}
                onClick={() => setOpenKey(key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenKey(key);
                  }
                }}
                aria-label="Open this visit"
                className="cursor-pointer border-b border-divider align-top last:border-b-0 hover:bg-brand-soft focus-visible:bg-brand-soft focus-visible:outline-none"
              >
                {r.source === "mbos" ? <MbosCells v={r.visit} /> : <SheetCells r={r.sheet} />}
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
      {open?.source === "sheet" ? (
        <ActivityDetail key={openKey} row={open.sheet} canDecide={canDecideShops} onClose={() => setOpenKey(null)} />
      ) : null}
      {open?.source === "mbos" ? (
        <MbosVisitModal key={openKey} v={open.visit} canAct={canActOnVisits} onClose={() => setOpenKey(null)} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- MBOS row */

function MbosCells({ v }: { v: VisitRow }) {
  const note = v.notes?.trim() || v.transcript?.trim() || null;
  const mins = v.durationSeconds != null ? Math.round(v.durationSeconds / 60) : null;
  return (
    <>
      <td className="px-3 py-2.5 text-sm">
        <div className="font-medium whitespace-nowrap text-ink tabular-nums">{longDate(v.day)}</div>
        <div className="text-xs text-muted">
          {weekday(v.day ?? "").slice(0, 3)}
          {v.checkInAt ? ` · ${clock(v.checkInAt)}` : ""}
        </div>
      </td>
      <td className="px-3 py-2.5 text-sm break-words text-ink">{v.salesmanName}</td>
      <td className="px-3 py-2.5 text-sm break-words">
        <div className="text-ink">{v.customerName}</div>
        <div className="text-xs text-muted">
          {[v.customerCity, accountTypeLabel({ kind: v.customerKind, thirdParty: v.customerThirdParty })]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </td>
      <td className="px-3 py-2.5 text-sm">
        <div className="text-ink">
          {label(VISIT_OUTCOME_LABEL, v.outcome)}
          {mins != null ? <span className="whitespace-nowrap text-muted"> · {minutes(mins)}</span> : null}
        </div>
        <div className="text-xs text-muted">
          {v.checkOutAt ? (v.wasPlanned ? "On the route" : "Off the route") : "Still checked in"}
        </div>
      </td>
      <td className="px-3 py-2.5 text-sm text-body">
        {note ? <p className="line-clamp-2 break-words">{note}</p> : <span className="text-muted">No note</span>}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-col items-start gap-1">
          <Pill tone="brand">MBOS</Pill>
          {v.verified ? (
            <Pill tone="success">{v.acceptedAt ? "Accepted" : "Verified"}</Pill>
          ) : (
            <Pill tone="warn">{v.locationMismatch ? "Wrong place" : "Unverified"}</Pill>
          )}
        </div>
      </td>
    </>
  );
}

function MbosVisitModal({ v, canAct, onClose }: { v: VisitRow; canAct: boolean; onClose: () => void }) {
  const actions = useVisitActions();
  const items = canAct ? actions.items(v) : [];
  return (
    <>
      <Modal
        open
        onClose={onClose}
        width={820}
        title={
          <span>
            {v.customerName}
            <span className="ml-2 text-sm font-normal text-muted">
              {weekday(v.day ?? "")}, {longDate(v.day)}
              {v.checkInAt ? ` · ${clock(v.checkInAt)}` : ""}
            </span>
          </span>
        }
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {items.map((it) => (
                <button
                  key={it.label}
                  disabled={it.disabled}
                  title={it.title}
                  onClick={() => it.run?.()}
                  className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas disabled:cursor-default disabled:opacity-50"
                >
                  {it.label}
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas"
            >
              Close
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
            <Field label="Salesman">
              <Link href={`/sales/live/${v.salesmanId}?day=${v.day}`} target="_blank">
                {v.salesmanName}
              </Link>
              <span className="block text-xs text-muted">Opens his whole day</span>
            </Field>
            <Field label="Customer">
              <Link href={`/crm/customers/${v.customerId}`}>{v.customerName}</Link>
              <span className="block text-xs text-muted">
                {[v.customerCity, accountTypeLabel({ kind: v.customerKind, thirdParty: v.customerThirdParty })]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </Field>
            <Field label="Outcome">
              {label(VISIT_OUTCOME_LABEL, v.outcome)}
              {v.durationSeconds != null ? (
                <span className="block text-xs text-muted">
                  {minutes(Math.round(v.durationSeconds / 60))} in the shop
                </span>
              ) : null}
            </Field>
          </dl>
          <div className="text-[13px]">
            <VisitState v={v} />
          </div>
          <VisitDetail v={v} />
        </div>
      </Modal>
      {actions.modal}
    </>
  );
}

/* ------------------------------------------------------------ old app row */

function SheetCells({ r }: { r: FieldActivityRow }) {
  const status = salesmanStatus(r);
  const note = [r.meetingNote, r.issueNote].filter(Boolean).join(" — ");
  return (
    <>
      <td className="px-3 py-2.5 text-sm">
        {r.visitDate ? (
          <>
            <div className="font-medium whitespace-nowrap text-ink tabular-nums">{longDate(r.visitDate)}</div>
            <div className="text-xs text-muted">{weekday(r.visitDate)}</div>
          </>
        ) : (
          <span className="text-warn-ink">Date unreadable</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-sm break-words">
        <div className="text-ink">{r.salesmanName ?? r.employeeNameRaw ?? "—"}</div>
        {status ? (
          <div className={cx("text-xs", status.tone === "warn" ? "font-medium text-warn-ink" : "text-muted")}>
            {status.text}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2.5 text-sm break-words">
        <div className="text-ink">{r.customerName ?? r.customerNameRaw ?? "—"}</div>
        {r.customerCity ? <div className="text-xs text-muted">{r.customerCity}</div> : null}
      </td>
      <td className="px-3 py-2.5 text-sm">
        <div className="text-ink">
          {r.meetingType ?? "—"}
          {r.durationMinutes != null ? <span className="whitespace-nowrap text-muted"> · {minutes(r.durationMinutes)}</span> : null}
        </div>
        {r.meetingPurpose ? <div className="text-xs text-muted">{r.meetingPurpose}</div> : null}
      </td>
      <td className="px-3 py-2.5 text-sm text-body">
        {note ? <p className="line-clamp-2 break-words">{note}</p> : <span className="text-muted">No note</span>}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-col items-start gap-1">
          <Pill tone="neutral">Old app</Pill>
          <Pill tone={MATCH_TONE[r.customerMatchStatus]}>{MATCH_LABEL[r.customerMatchStatus]}</Pill>
        </div>
      </td>
    </>
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
  canDecide,
  onClose,
}: {
  row: FieldActivityRow;
  canDecide: boolean;
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
                    ? "Not linked — a person has to say which shop"
                    : "Not linked to any account"}
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
          {canDecide && r.customerNameRaw ? <ShopDecision rowId={r.id} onDone={onClose} /> : null}
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

/* ------------------------------------------------------- which shop is it */

/**
 * WHICH ACCOUNT IS THIS SHOP — said once for the NAME, so every visit the
 * old app typed under it moves together. Accounts carrying exactly the name
 * come first; close names and a search are there to find the right one when
 * the old app spelled it differently. Nothing here is ever picked for you.
 */
function ShopDecision({ rowId, onDone }: { rowId: string; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [choices, setChoices] = React.useState<ShopChoices | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [found, setFound] = React.useState<ShopChoice[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void activityShopChoices({ rowId }).then((r) => {
      if (!live) return;
      if (r.ok) setChoices(r.data);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [rowId]);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const r = await searchActivityShops({ q });
    if (r.ok) setFound(r.data);
    else setError(r.error);
  }

  async function decide(customerId: string | null) {
    setBusy(true);
    try {
      const r = await decideActivityShop({ rowId, customerId });
      if (!r.ok) return setError(r.error);
      toast.push(r.message ?? "Saved.");
      router.refresh();
      onDone();
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    setBusy(true);
    try {
      const r = await undoActivityShopDecision({ rowId });
      if (!r.ok) return setError(r.error);
      toast.push(r.message ?? "Taken back.");
      router.refresh();
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="mt-3 text-[13px] text-danger">{error}</p>;
  if (!choices) return <p className="mt-3 text-[13px] text-muted">Looking for the shop…</p>;

  const list = (title: string, items: ShopChoice[]) =>
    items.length ? (
      <div className="mt-2">
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{title}</div>
        <ul className="mt-1 divide-y divide-divider rounded-[4px] border border-line">
          {items.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-[13px]">
              <span className="min-w-0">
                <span className="text-ink">{c.name}</span>
                <span className="text-muted"> · {[c.city, c.type].filter(Boolean).join(" · ")}</span>
              </span>
              <button
                disabled={busy || choices.decision?.customer?.id === c.id}
                onClick={() => void decide(c.id)}
                className="h-7 shrink-0 cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 text-[12px] font-medium text-body hover:bg-canvas disabled:cursor-default disabled:opacity-50"
              >
                {choices.decision?.customer?.id === c.id ? "Linked" : "This is the shop"}
              </button>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <div className="mt-3 rounded-[6px] border border-line bg-canvas p-3">
      <p className="text-[13px] font-semibold text-ink">Which shop is this?</p>
      <p className="text-[12px] text-muted">
        Applies to all {choices.rows} visit{choices.rows === 1 ? "" : "s"}{" "}
        the old app typed as &ldquo;{choices.shownName}&rdquo;. Only a name spelled exactly like one account is linked
        without asking.
      </p>
      {choices.decision ? (
        <p className="mt-2 text-[13px] text-body">
          {choices.decision.customer
            ? `Decided: ${choices.decision.customer.name}${choices.decision.customer.city ? ` (${choices.decision.customer.city})` : ""}`
            : "Decided: not on MahekOne"}
          {choices.decision.by ? ` — by ${choices.decision.by}` : ""}.{" "}
          <button onClick={() => void undo()} disabled={busy} className="cursor-pointer text-brand underline-offset-2 hover:underline">
            Take it back
          </button>
        </p>
      ) : null}
      {list("Exactly this name", choices.exact)}
      {list("Close names — check the town", choices.near)}
      <form onSubmit={search} className="mt-2 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the book for the right shop"
          className="h-8 min-w-0 flex-1 rounded-[4px] border border-line bg-surface px-2 text-[13px]"
        />
        <button className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas">
          Search
        </button>
      </form>
      {found ? (found.length ? list("Found", found) : <p className="mt-2 text-[13px] text-muted">Nothing on the book by that name.</p>) : null}
      <div className="mt-3">
        <button
          disabled={busy || (choices.decision !== null && choices.decision.customer === null)}
          onClick={() => void decide(null)}
          className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-canvas disabled:cursor-default disabled:opacity-50"
        >
          Not on MahekOne
        </button>
      </div>
    </div>
  );
}
