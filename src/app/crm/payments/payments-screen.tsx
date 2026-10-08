"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  MoneyInput,
  PageHeader,
  Select,
  Td,
  Th,
  cx,
} from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { Modal, RowMenu, Tabs } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import {
  recordPayment,
  recordPromise,
  startStageOneBatch,
} from "@/lib/actions/crm";
import { toCsv, downloadCsv } from "@/lib/csv";
import {
  addDays,
  ageLabel,
  money,
  shortDate,
  signedMoney,
  stamp,
  today,
} from "@/lib/format";

import { PaymentPanel } from "@/components/crm/payment-panel";
import type {
  WorklistRow,
  PaymentFollowUpPlan,
  CollectionsMetrics,
} from "@/lib/services/payment-service";
import type { PayOutcomeDefinition } from "@/lib/services/payment-followup-service";
import { PaymentModeFields } from "@/components/crm/payment-mode-fields";
import { Pager } from "@/components/ui/pager";
import type { ReminderDay, ReminderSummary, TrackerRow } from "@/lib/services/whatsapp-tracker-service";
import { previewOf, statusView, wentAt, whenLabel } from "@/lib/whatsapp-status";

type Row = WorklistRow & {
  openBills: Array<{ id: string; billNo: string; balance: number; dueDate: string }>;
  /** The newest WhatsApp message to this customer, and how far it got. */
  lastWa: TrackerRow | null;
};

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Stage is the engine's, not the interface's — 1, 2, 3 and nothing else. */
const STAGE_LABEL: Record<number, string> = {
  1: "Stage 1 · nudge",
  2: "Stage 2 · call",
  3: "Stage 3 · escalate",
};
/** The word in the Stage column: what the stage asks for, in one word. */
const STAGE_SHORT: Record<number, string> = {
  1: "Nudge",
  2: "Call",
  3: "Urgent",
};
const STAGE_TONE: Record<number, "danger" | "warn" | "brand"> = {
  1: "brand",
  2: "warn",
  3: "danger",
};

/**
 * The status in a word, for a column. The full sentence — "copied to paste,
 * nobody confirmed it went" — is still on the hover; the badge only has to be
 * told apart from its neighbours. A pasted send keeps its own word ("Sent")
 * with no ticks, so it never reads as WhatsApp's receipt.
 */
const SHORT_WA: Record<string, string> = {
  sent_manually: "Sent",
  copied: "Not confirmed",
};

type Tab =
  | "calls"
  | "messages"
  | "all"
  | "stage1"
  | "stage2"
  | "stage3"
  | "promised";

/*
 * FOUR TABS AND A STAGE FILTER, not seven tabs.
 *
 * The three stage tabs were the same list as "All" narrowed by one column,
 * sitting beside three tabs that are genuinely different worklists — so the
 * row of seven read as seven jobs. The URL keeps its seven values (a stage
 * link sent last week still opens the same list); only the drawing changed:
 * a stage is picked from the Stage filter, and "All" stays lit while it is.
 */
type PrimaryTab = "calls" | "messages" | "promised" | "all";

function primaryOf(tab: Tab): PrimaryTab {
  return tab.startsWith("stage") ? "all" : (tab as PrimaryTab);
}

export function PaymentsScreen({
  modes,
  datedModes,
  today: businessDay,
  scopeLabel,
  showAssignee,
  canBulk,
  canExport,
  rows,
  aging,
  workingDaysLeft,
  plan,
  outcomes,
  metrics,
  batchCount,
  reminders,
  filters,
  pageInfo,
  counts,
  held,
  filteredOverdue,
}: {
  /** `payments.modes` — the list is configuration, never a literal on a screen. */
  modes: string[];
  /** `payments.datedModes` — modes whose instrument carries a date of its own. */
  datedModes: string[];
  /** The business date, read on the server: the clock is not read during render. */
  today: string;
  scopeLabel: string;
  /** Team view: every row belongs to somebody, so every row says who. */
  showAssignee: boolean;
  /**
   * The two capabilities behind the two header buttons, asked by name. The
   * export is a CSV of rows already on this page, so the button IS the gate
   * for it; the batch is checked again in its action.
   */
  canBulk: boolean;
  canExport: boolean;
  rows: Row[];
  aging: { total: number; buckets: Array<{ label: string; amount: number }> };
  workingDaysLeft: number;
  /** Today's cadence, from E7 — who is due a call, a message, or neither. */
  plan: PaymentFollowUpPlan;
  /** Declared server-side, so the form and the action cannot disagree. */
  outcomes: PayOutcomeDefinition[];
  /** Derived from bills, payments and promises — nothing stored. */
  metrics: CollectionsMetrics;
  /** How many stage 1 customers a batch would actually go to today. */
  batchCount: number;
  /** Today's and yesterday's WhatsApp payment reminders over this book. */
  reminders: ReminderSummary;
  /** What is on screen is what the address says — see page.tsx. */
  filters: {
    tab: Tab;
    query: string;
    slowOnly: boolean;
    monthEnd: boolean;
  };
  pageInfo: {
    page: number;
    pageCount: number;
    perPage: number;
    /** Matching the filters. */
    total: number;
    /** The whole scoped worklist, before any filter. */
    listTotal: number;
  };
  /** Per-tab counts from SQL, over everything the OTHER filters match. */
  counts: Record<Tab, number>;
  /** Disputed and not escalating — over the scoped set, not the page. */
  held: number;
  /** Overdue paise over the filtered set, not the page. */
  filteredOverdue: number;
}) {
  const router = useRouter();
  const { run, push } = useToast();

  const search = useSearchParams();

  const { tab, query, slowOnly, monthEnd } = filters;
  const { page, perPage, total: matched, listTotal } = pageInfo;

  const navigate = React.useCallback(
    (patch: Record<string, string | number | undefined>) => {
      const next = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === "" || v === null) next.delete(k);
        else next.set(k, String(v));
      }
      // Any change to what is being looked at starts at the beginning of it —
      // unless the change IS the page.
      if (!("page" in patch)) next.delete("page");
      router.push(`?${next.toString()}`, { scroll: false });
    },
    [router, search],
  );

  // The search box is the one control that cannot afford a round trip per
  // keystroke, so it holds its own text and navigates when typing settles.
  const [draft, setDraft] = React.useState(query);
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [promising, setPromising] = React.useState<Row | null>(null);
  const [paying, setPaying] = React.useState<Row | null>(null);
  const [heldOpen, setHeldOpen] = React.useState(false);
  /*
   * THE FIGURES THAT ARE NOT TODAY'S WORK ARE ONE CLICK AWAY, not gone.
   * Ageing, promises kept, held disputes and the WhatsApp reminder tally were
   * three strips and eight tiles above the list, so the list itself started
   * below the fold. They are a manager's reading; a telecaller opens the page
   * to work the list.
   */
  const [statsOpen, setStatsOpen] = React.useState(false);
  // The whole follow-up happens in the panel — a telecaller working a list of
  // twelve should not lose their place to look at a bill.
  const [openAt, setOpenAt] = React.useState<number | null>(null);

  // The engine decides who is due; this only says why, beside the name.
  const callReason = new Map(plan.calls.map((c) => [c.customerId, c.reason]));
  const messageReason = new Map(plan.messages.map((m) => [m.customerId, m.reason]));
  const dueReason = tab === "messages" ? messageReason : callReason;
  const onCadenceTab = tab === "calls" || tab === "messages";
  // Held back from the channel being looked at, not from both at once.
  const heldBack = plan.heldBack.filter((h) =>
    tab === "messages" ? h.channel === "whatsapp" : h.channel === "call",
  );

  /*
   * `rows` IS the page — filtered, sorted and cut in SQL. Nothing here
   * narrows it further: a second filter in the browser would disagree with the
   * count above the table, and the count is the half people read.
   */
  const visible = rows;
  const stageFilter = tab.startsWith("stage") ? tab.slice(5) : "";
  const filtered = Boolean(query || slowOnly || monthEnd || stageFilter);

  return (
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <PageHeader
        title="Payment follow-up"
        subtitle={scopeLabel}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={!canBulk || batchCount === 0}
              title={
                !canBulk
                  ? "Bulk sending needs the right to send WhatsApp in bulk"
                  : batchCount === 0
                    ? "Nobody at stage 1 is due a reminder today"
                    : `Queue the stage 1 reminder for ${plural(batchCount, "customer")}`
              }
              onClick={async () => {
                const result = await run(startStageOneBatch());
                // A batch is still sent one confirmed message at a time, on the
                // screen built for exactly that.
                if (result.ok) router.push("/crm/whatsapp");
              }}
            >
              Send stage 1 batch{batchCount ? ` · ${batchCount}` : ""}
            </Button>
            <Button
              variant="secondary"
              disabled={!canExport}
              title={canExport ? "Download this page as CSV" : "Exporting needs the right to export customers"}
              onClick={() => {
                downloadCsv(
                  "mahek-collections",
                  toCsv(
                    // "Assigned to", not "Owner": the export names the same
                    // person the list does.
                    ["Customer", "Assigned to", "Stage", "Bills overdue", "Oldest (days)", "Outstanding (₹)", "Next action"],
                    visible.map((r) => [
                      r.name,
                      r.assignedToName ?? "Unassigned",
                      STAGE_LABEL[r.stage] ?? r.stage,
                      r.overdueBillCount,
                      r.daysOverdue,
                      Math.round(r.totalOverdue / 100),
                      r.nextAction,
                    ]),
                  ),
                  [tab === "all" ? null : tab, slowOnly ? "slow-payers" : null,
                   monthEnd ? "month-end" : null, query || null],
                );
                // The page, not the filtered set — said out loud, because
                // exporting twenty-five of three hundred silently is a trap.
                push(`Exported ${visible.length} rows · this page of ${matched}`);
              }}
            >
              Export
            </Button>
          </>
        }
      />

      {/*
        FOUR NUMBERS, and the first two are the day's work. They are the
        engine's plan rather than the filtered set — "how many calls are due
        today" regardless of what anybody typed — and pressing one opens it.
      */}
      <CardGrid min="card" gap="gap-3" className="mb-3">
        <Kpi
          label="To call today"
          value={String(plan.calls.length)}
          tone={plan.calls.length ? "danger" : undefined}
          active={tab === "calls"}
          onClick={() => navigate({ tab: undefined })}
        />
        <Kpi
          label="To message today"
          value={String(plan.messages.length)}
          tone={plan.messages.length ? "brand" : undefined}
          active={tab === "messages"}
          onClick={() => navigate({ tab: "messages" })}
        />
        <Kpi
          label="Outstanding"
          value={money(metrics.outstanding)}
          sub={plural(metrics.outstandingCustomers, "customer")}
          delta={
            metrics.outstandingChange === 0
              ? undefined
              : { text: `${signedMoney(metrics.outstandingChange)} this week`, bad: metrics.outstandingChange > 0 }
          }
        />
        <Kpi
          label="Collected this month"
          value={money(metrics.collectedThisMonth)}
          tone="success"
          sub={`of ${money(metrics.dueThisMonth)} due`}
        />
      </CardGrid>

      <div className="mb-3">
        <button
          type="button"
          onClick={() => setStatsOpen((o) => !o)}
          className="cursor-pointer border-none bg-transparent p-0 text-[13px] text-brand"
          aria-expanded={statsOpen}
        >
          {statsOpen ? "Hide details ▴" : "More details — ageing, promises, reminders ▾"}
        </button>
        {statsOpen ? (
          <BookDetails
            aging={aging}
            metrics={metrics}
            held={held}
            reminders={reminders}
            today={businessDay}
          />
        ) : null}
      </div>

      {monthEnd ? (
        <div className="mb-3 rounded-[6px] border border-warn-line bg-warn-soft px-4 py-2.5 text-sm text-warn-ink">
          <span className="font-medium">Month-end push</span> · {workingDaysLeft} working days
          left · {money(filteredOverdue)} collectable · biggest first
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <Tabs
          value={primaryOf(tab)}
          onChange={(next) => navigate({ tab: next === "calls" ? undefined : next })}
          className="px-3"
          tabs={[
            { key: "calls", label: "Call today", count: counts.calls },
            { key: "messages", label: "Message today", count: counts.messages },
            { key: "promised", label: "Promised", count: counts.promised },
            { key: "all", label: "All", count: counts.all },
          ]}
        />

        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-2.5">
          <div className="w-[240px] flex-none">
            <Input
              value={draft}
              onChange={(e) => {
                const v = e.target.value;
                setDraft(v);
                clearTimeout(searchTimer.current);
                searchTimer.current = setTimeout(() => navigate({ q: v || undefined }), 250);
              }}
              placeholder="Search customer"
              className="h-8"
            />
          </div>
          <div className="w-[190px] flex-none">
            <Select
              value={stageFilter}
              onChange={(e) =>
                navigate({ tab: e.target.value ? `stage${e.target.value}` : "all" })
              }
              className="h-8"
              aria-label="Stage"
            >
              <option value="">All stages</option>
              <option value="1">Stage 1 · Nudge ({counts.stage1})</option>
              <option value="2">Stage 2 · Call ({counts.stage2})</option>
              <option value="3">Stage 3 · Urgent ({counts.stage3})</option>
            </Select>
          </div>
          <Checkbox
            label="Slow payers"
            checked={slowOnly}
            onChange={(e) => navigate({ slow: e.target.checked ? "1" : undefined })}
          />
          <button
            onClick={() => navigate({ sort: monthEnd ? undefined : "value" })}
            title="Sort by amount, biggest first"
            className={cx(
              "h-8 flex-none cursor-pointer rounded-[4px] border px-2.5 text-[13px] whitespace-nowrap",
              monthEnd
                ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                : "border-line bg-surface text-body hover:bg-canvas",
            )}
          >
            Month-end view
          </button>
          {filtered ? (
            <button
              onClick={() => {
                setDraft("");
                navigate({
                  q: undefined,
                  slow: undefined,
                  sort: undefined,
                  tab: stageFilter ? "all" : undefined,
                });
              }}
              className="h-8 flex-none cursor-pointer border-none bg-transparent px-1.5 text-[13px] whitespace-nowrap text-brand"
            >
              Clear
            </button>
          ) : null}
          <span className="flex-1" />
          {onCadenceTab && heldBack.length ? (
            <button
              type="button"
              onClick={() => setHeldOpen((o) => !o)}
              title="Customers kept off today's list, and why"
              className="cursor-pointer border-none bg-transparent p-0 text-[13px] text-muted hover:text-body"
            >
              {heldBack.length} held back {heldOpen ? "▴" : "▾"}
            </button>
          ) : null}
          {/* A filtered list says what it is a slice of. */}
          <span className="text-[13px] text-muted">
            {matched === listTotal
              ? plural(matched, "customer")
              : `${matched.toLocaleString("en-IN")} of ${listTotal.toLocaleString("en-IN")}`}
          </span>
        </div>

        {onCadenceTab && heldOpen && heldBack.length ? (
          <div className="border-b border-line bg-canvas px-4 py-2">
            {heldBack.map((h) => (
              <div key={h.customerId} className="flex items-center gap-3 py-1 text-[13px]">
                <Link
                  href={`/crm/customers/${h.customerId}`}
                  className="w-[240px] flex-none truncate text-body no-underline"
                >
                  {h.name}
                </Link>
                <span className="truncate text-muted">{h.reason}</span>
              </div>
            ))}
          </div>
        ) : null}

        {visible.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] table-fixed border-collapse">
                <colgroup>
                  <col />
                  <col className="w-[96px]" />
                  <col className="w-[130px]" />
                  <col className="w-[96px]" />
                  <col className="w-[130px]" />
                  <col className="w-[180px]" />
                  {showAssignee ? <col className="w-[130px]" /> : null}
                  <col className="w-[190px]" />
                </colgroup>
                <thead>
                  <tr>
                    <Th>Customer</Th>
                    <Th>Stage</Th>
                    <Th align="right">Overdue</Th>
                    <Th align="right">Oldest</Th>
                    <Th>Last chased</Th>
                    <Th>WhatsApp</Th>
                    {showAssignee ? <Th>Assigned</Th> : null}
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r, i) => (
                    <WorklistLine
                      key={r.customerId}
                      r={r}
                      reason={onCadenceTab ? (dueReason.get(r.customerId) ?? null) : null}
                      showAssignee={showAssignee}
                      today={businessDay}
                      onOpen={() => setOpenAt(i)}
                      onPay={() => setPaying(r)}
                      onPromise={() => setPromising(r)}
                      onGo={(href) => router.push(href)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              total={matched}
              page={page}
              perPage={perPage}
              note={`${money(filteredOverdue)} overdue in this list`}
              onPage={(p) => navigate({ page: p })}
              onPerPage={(n) => navigate({ per: n === 25 ? undefined : n })}
            />
          </>
        ) : (
          <EmptyState
            title="Nobody to chase here"
            body="Everyone in this list has paid or has a live promise."
          />
        )}
      </Card>

      <PaymentPanel
        modes={modes}
        datedModes={datedModes}
        today={businessDay}
        target={
          openAt === null || !visible[openAt]
            ? null
            : {
                customerId: visible[openAt].customerId,
                index: openAt,
                total: visible.length,
              }
        }
        outcomes={outcomes}
        onClose={() => setOpenAt(null)}
        onMove={(delta) =>
          setOpenAt((at) =>
            at === null ? null : Math.min(visible.length - 1, Math.max(0, at + delta)),
          )
        }
        onSaved={() => {
          setOpenAt(null);
          router.refresh();
        }}
        onRefresh={() => router.refresh()}
        onSavedNext={() => {
          // The row just worked usually leaves the list on the next load, so
          // staying put lands on the following customer rather than skipping
          // one. At the end of the list, close.
          setOpenAt((at) =>
            at === null ? null : at >= visible.length - 1 ? null : at + 1,
          );
          router.refresh();
        }}
      />

      <PromiseModal
        row={promising}
        onClose={() => setPromising(null)}
        onSubmit={async (amount, promisedBy, note) => {
          if (!promising) return;
          const result = await run(
            recordPromise({
              customerId: promising.customerId,
              amount,
              promisedBy,
              note,
            }),
          );
          if (result.ok) {
            setPromising(null);
            router.refresh();
          }
        }}
      />

      <PaymentModal
        modes={modes}
        datedModes={datedModes}
        today={businessDay}
        row={paying}
        onClose={() => setPaying(null)}
        onSubmit={async (billId, amount, mode, reference, receivedOn, instrumentDate) => {
          const result = await run(
            recordPayment({
              billId,
              amount,
              mode,
              reference,
              instrumentDate: instrumentDate || undefined,
              receivedOn,
            }),
          );
          if (result.ok) {
            setPaying(null);
            router.refresh();
          }
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

function Kpi({
  label,
  value,
  sub,
  tone,
  delta,
  active,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "danger" | "success" | "brand";
  delta?: { text: string; bad: boolean };
  active?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cx(
        "rounded-[6px] border bg-surface px-4 py-3 text-left",
        active ? "border-brand ring-1 ring-brand" : "border-line",
        onClick ? "cursor-pointer hover:border-brand" : "",
      )}
    >
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div
        className={cx(
          "mt-0.5 text-[24px] leading-8 font-semibold",
          tone === "danger"
            ? "text-danger"
            : tone === "success"
              ? "text-success"
              : tone === "brand"
                ? "text-brand-hover"
                : "text-ink",
        )}
      >
        {value}
      </div>
      {sub || delta ? (
        <div className="text-[12px] text-muted">
          {sub}
          {sub && delta ? " · " : ""}
          {delta ? (
            <span className={delta.bad ? "text-danger" : "text-success"}>{delta.text}</span>
          ) : null}
        </div>
      ) : null}
    </Tag>
  );
}

/**
 * ONE ROW, ONE LINE OF FACTS. The customer and why they are on the list on
 * the left, the money in the middle, the button on the right. Everything that
 * used to be a sentence under the name — how many bills, the promise, what
 * was reported, the last WhatsApp with its full text — is a column or a flag,
 * and the words behind a flag are on its hover.
 */
function WorklistLine({
  r,
  reason,
  showAssignee,
  today: businessDay,
  onOpen,
  onPay,
  onPromise,
  onGo,
}: {
  r: Row;
  reason: string | null;
  showAssignee: boolean;
  today: string;
  onOpen: () => void;
  onPay: () => void;
  onPromise: () => void;
  onGo: (href: string) => void;
}) {
  const wa = r.lastWa ? statusView(r.lastWa) : null;
  /*
   * The newest WhatsApp to them FAILED — the automatic reminder never
   * arrived, so somebody has to send it by hand. The button says so, and the
   * panel it opens leads with the manual route and the reason.
   */
  const waFailed = r.lastWa?.status === "failed";
  const flags: Array<{ label: string; tone: "warn" | "danger"; title?: string }> = [];
  if (r.promiseBroken) flags.push({ label: "Promise broken", tone: "danger" });
  if (r.held) flags.push({ label: "Held", tone: "warn", title: r.heldReason ?? undefined });
  if (r.reportedAmount) {
    // Money reported and not yet found. The balance has not moved, and
    // without this that reads as nobody having done anything about it.
    flags.push({
      label: `Paid ${money(r.reportedAmount)}?`,
      tone: "warn",
      title: `${money(r.reportedAmount)} reported paid${r.reportedOn ? ` on ${shortDate(r.reportedOn)}` : ""} — waiting for accounts to find it`,
    });
  }
  if (r.slowPayer) flags.push({ label: "Slow payer", tone: "warn" });

  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer border-b border-divider last:border-0 hover:bg-canvas"
    >
      <Td className="py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={`/crm/customers/${r.customerId}`}
            onClick={(e) => e.stopPropagation()}
            className="truncate text-sm font-medium text-ink no-underline hover:underline"
            title={r.name}
          >
            {r.name}
          </Link>
          {flags.map((f) => (
            <Badge key={f.label} tone={f.tone} title={f.title} className="flex-none">
              {f.label}
            </Badge>
          ))}
        </div>
        {reason || r.promisedDate ? (
          <div className="mt-0.5 truncate text-[12px] text-muted" title={reason ?? undefined}>
            {r.promisedDate ? (
              <span className="text-body">
                Promised {money(r.promisedAmount ?? 0)} by {shortDate(r.promisedDate)}
              </span>
            ) : null}
            {r.promisedDate && reason ? " · " : ""}
            {reason}
          </div>
        ) : null}
      </Td>
      <Td>
        <Badge tone={STAGE_TONE[r.stage] ?? "neutral"} title={STAGE_LABEL[r.stage]}>
          {r.stage} · {STAGE_SHORT[r.stage] ?? "Stage"}
        </Badge>
      </Td>
      <Td align="right">
        <div className="text-sm font-semibold text-danger">{money(r.totalOverdue)}</div>
        <div className="text-[12px] text-muted">{plural(r.overdueBillCount, "bill")}</div>
      </Td>
      <Td align="right" className="text-[13px]">
        {ageLabel(r.daysOverdue)}
      </Td>
      {/* The last PAYMENT follow-up, not the last time anybody spoke to them. */}
      <Td className={cx("text-[13px]", r.lastFollowUpAt ? "text-body" : "text-muted")}>
        {r.lastFollowUpAt ? stamp(r.lastFollowUpAt) : "Never"}
      </Td>
      <Td className="overflow-hidden text-[13px]">
        {r.lastWa && wa ? (
          <span
            className="inline-flex max-w-full items-center gap-1.5"
            title={[
              whenLabel(wentAt(r.lastWa), businessDay),
              `${r.lastWa.templateName ?? "Message"} to ${r.lastWa.destination}`,
              r.lastWa.viaRule ? "sent by an automatic rule" : `by ${r.lastWa.sentBy}`,
              wa.explain,
              r.lastWa.body ? `“${previewOf(r.lastWa.body)}”` : "",
            ]
              .filter(Boolean)
              .join("\n")}
          >
            {/* "4 days ago", not "4 days ago · 2 Oct, 9:04 pm" — the
                stamp is on the hover with the rest. */}
            <span className="text-body">
              {whenLabel(wentAt(r.lastWa), businessDay).split(/[,·]/)[0].trim()}
            </span>
            <Badge tone={wa.tone === "brand" ? "brand" : wa.tone}>
              {wa.ticks ? (
                <span className={cx("mr-0.5 font-semibold", wa.tone === "brand" ? "text-[#1d9bf0]" : "")}>
                  {wa.ticks}
                </span>
              ) : null}
              {r.lastWa.repliedAt ? "Replied" : (SHORT_WA[r.lastWa.status] ?? wa.label)}
            </Badge>
          </span>
        ) : (
          // Said rather than left blank: a debt nobody has messaged is the
          // row a telecaller most needs to notice.
          <span className="text-muted">None sent</span>
        )}
      </Td>
      {showAssignee ? (
        <Td
          className={cx("truncate text-[13px]", r.assignedToName ? "text-body" : "text-muted")}
          title={r.assignedToName ?? undefined}
        >
          {r.assignedToName ?? "Unassigned"}
        </Td>
      ) : null}
      <Td align="right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1.5">
          <Button
            size="sm"
            variant={r.promiseBroken || r.stage === 3 ? "danger" : "primary"}
            disabled={r.held}
            title={
              r.held
                ? (r.heldReason ?? "Held while the dispute is open")
                : waFailed
                  ? `The automatic WhatsApp failed${r.lastWa?.failureReason ? ` — ${r.lastWa.failureReason}` : ""}. Send it yourself.`
                  : r.nextAction
            }
            onClick={onOpen}
          >
            {waFailed ? "Send manually" : r.nextChannel === "whatsapp" ? "Send reminder" : "Call & log"}
          </Button>
          <RowMenu
            items={[
              { label: "Open follow-up", onSelect: onOpen },
              {
                label: "Record a payment",
                onSelect: onPay,
                disabled: !r.openBills.length,
                title: r.openBills.length ? undefined : "No open bills",
              },
              {
                label: "Record a promise",
                onSelect: onPromise,
                disabled: r.held,
                title: r.held ? (r.heldReason ?? undefined) : undefined,
              },
              {
                label: "Open WhatsApp chat",
                onSelect: () => onGo(`/crm/whatsapp?tab=replies&chat=${r.customerId}`),
              },
              {
                label: "See their bills",
                onSelect: () => onGo(`/crm/bills?customer=${r.customerId}`),
              },
              {
                label: "Open customer record",
                onSelect: () => onGo(`/crm/customers/${r.customerId}`),
              },
            ]}
          />
        </div>
      </Td>
    </tr>
  );
}

type PromiseProps = {
  row: Row | null;
  onClose: () => void;
  onSubmit: (amount: string, promisedBy: string, note: string) => Promise<void>;
};

/** Remounts per customer so the amount defaults to their own balance. */
function PromiseModal(props: PromiseProps) {
  if (!props.row) return null;
  return <PromiseModalBody key={props.row.customerId} {...props} />;
}

function PromiseModalBody({ row, onClose, onSubmit }: PromiseProps) {
  const [amount, setAmount] = React.useState(
    String(Math.round((row?.totalOverdue ?? 0) / 100)),
  );
  const [promisedBy, setPromisedBy] = React.useState(addDays(today(), 7));
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={Boolean(row)}
      onClose={onClose}
      title="Record payment promise"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(amount, promisedBy, note);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save promise
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">
        {row?.name} · {money(row?.totalOverdue ?? 0)} overdue
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount promised">
          <MoneyInput
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="2,00,000"
          />
        </Field>
        <Field label="Promised by">
          <Input
            type="date"
            value={promisedBy}
            onChange={(e) => setPromisedBy(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Note" className="mt-3">
        <VoiceTextarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onDictate={setNote}
          className="h-16"
          placeholder="Who promised, and how it will be paid"
        />
      </Field>
      <div className="mt-3 rounded-[4px] border border-warn-line bg-warn-soft px-2.5 py-2 text-[13px] text-warn-ink">
        If it does not arrive, a reminder comes up on {shortDate(addDays(promisedBy, 1))}.
      </div>
    </Modal>
  );
}

type PaymentProps = {
  modes: string[];
  datedModes: string[];
  today: string;
  row: Row | null;
  onClose: () => void;
  onSubmit: (
    billId: string,
    amount: string,
    mode: string,
    reference: string,
    receivedOn: string,
    /** The date on the cheque, where the mode carries one. */
    instrumentDate: string,
  ) => Promise<void>;
};

function PaymentModal(props: PaymentProps) {
  if (!props.row) return null;
  return <PaymentModalBody key={props.row.customerId} {...props} />;
}

function PaymentModalBody({ row, onClose, onSubmit, modes, datedModes, today: businessDay }: PaymentProps) {
  const [billId, setBillId] = React.useState(row?.openBills[0]?.id ?? "");
  const [amount, setAmount] = React.useState(
    String(Math.round((row?.openBills[0]?.balance ?? 0) / 100)),
  );
  const [mode, setMode] = React.useState("Bank transfer");
  const [reference, setReference] = React.useState("");
  /** The date written on the cheque — see `payments.datedModes`. */
  const [instrumentDate, setInstrumentDate] = React.useState("");
  const [receivedOn, setReceivedOn] = React.useState(today());
  const [busy, setBusy] = React.useState(false);

  const bill = row?.openBills.find((b) => b.id === billId);

  return (
    <Modal
      open={Boolean(row)}
      onClose={onClose}
      title={`Record payment · ${bill?.billNo ?? ""}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(billId, amount, mode, reference, receivedOn, instrumentDate);
              } finally {
                setBusy(false);
              }
            }}
          >
            Record payment
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">{row?.name}</div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Against bill" className="col-span-2">
          <Select
            value={billId}
            onChange={(e) => {
              setBillId(e.target.value);
              const next = row?.openBills.find((b) => b.id === e.target.value);
              if (next) setAmount(String(Math.round(next.balance / 100)));
            }}
          >
            {row?.openBills.map((b) => (
              <option key={b.id} value={b.id}>
                {b.billNo} · {money(b.balance)} open · due {shortDate(b.dueDate)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Amount received"
          hint={bill ? `Up to ${money(bill.balance)}` : undefined}
        >
          <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Received on">
          <Input
            type="date"
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
        </Field>
        <PaymentModeFields
          modes={modes}
          datedModes={datedModes}
          today={businessDay}
          mode={mode}
          onMode={setMode}
          reference={reference}
          onReference={setReference}
          instrumentDate={instrumentDate}
          onInstrumentDate={setInstrumentDate}
        />
      </div>
    </Modal>
  );
}

/**
 * THE BOOK, FOR WHOEVER ASKS. Ageing, promises, disputes and whether today's
 * WhatsApp reminders went — the figures a manager reads, folded behind one
 * link so the worklist is the first thing on the page.
 */
function BookDetails({
  aging,
  metrics,
  held,
  reminders,
  today: businessDay,
}: {
  aging: { total: number; buckets: Array<{ label: string; amount: number }> };
  metrics: CollectionsMetrics;
  held: number;
  reminders: ReminderSummary;
  today: string;
}) {
  // Only a real comparison: with no promise judged in the previous window
  // there is no trend, and inventing one would be worse than showing none.
  const keptDelta =
    metrics.promisesKeptPercent === null || metrics.promisesKeptPreviousPercent === null
      ? null
      : metrics.promisesKeptPercent - metrics.promisesKeptPreviousPercent;
  const { lastRun, lastSendingRun } = reminders;

  return (
    <Card className="mt-2 divide-y divide-divider">
      <DetailRow label="Ageing">
        {aging.buckets.map((b) => (
          <span key={b.label}>
            {b.label} <span className="font-medium text-ink">{money(b.amount)}</span>
          </span>
        ))}
      </DetailRow>
      <DetailRow label="Promises">
        <span>
          Open <span className="font-medium text-ink">{money(metrics.promisedOpen)}</span> ·{" "}
          {plural(metrics.promisedCount, "promise")}
        </span>
        <span>
          Kept (30 days){" "}
          <span
            className={cx(
              "font-medium",
              metrics.promisesKeptPercent !== null && metrics.promisesKeptPercent < 60
                ? "text-danger"
                : "text-ink",
            )}
          >
            {metrics.promisesKeptPercent === null ? "—" : `${metrics.promisesKeptPercent}%`}
          </span>
          {keptDelta === null ? null : (
            <span className={keptDelta < 0 ? "text-danger" : "text-success"}>
              {" "}
              {keptDelta > 0 ? "+" : "−"}
              {Math.abs(keptDelta)} pts
            </span>
          )}
        </span>
        <span>
          Over {metrics.urgentThresholdDays} days{" "}
          <span className="font-medium text-danger">{money(metrics.urgent)}</span>
        </span>
        <span>
          Disputed <span className={cx("font-medium", held ? "text-danger" : "text-ink")}>{held}</span>
        </span>
      </DetailRow>
      <DetailRow
        label="Reminders"
        right={
          <Link href="/crm/whatsapp" className="text-[12px] text-brand no-underline">
            WhatsApp →
          </Link>
        }
      >
        <ReminderDayLine label="Today" d={reminders.today} />
        <ReminderDayLine label="Yesterday" d={reminders.yesterday} />
        {/* Whether the runner ran at all is said separately: "no rule sent
            anything" and "no rule was checked" are different facts. */}
        <span className="text-muted">
          {!lastRun
            ? "Auto rules never ran"
            : lastSendingRun
              ? `Auto rules last sent ${inline(whenLabel(lastSendingRun.at, businessDay))}`
              : "Auto rules preview only"}
        </span>
      </DetailRow>
    </Card>
  );
}

function DetailRow({
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2.5 text-[13px] text-body">
      <span className="w-[80px] flex-none text-[12px] font-medium text-muted">{label}</span>
      {children}
      {right ? (
        <>
          <span className="flex-1" />
          {right}
        </>
      ) : null}
    </div>
  );
}

/** "Today, 9 am" mid-sentence is "today, 9 am" — but "29 Sep" keeps its capital. */
function inline(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function ReminderDayLine({ label, d }: { label: string; d: ReminderDay }) {
  if (!d.total) {
    return (
      <span>
        {label} <span className="text-muted">none</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`${d.byRule} by automatic rules, ${d.byPerson} by the team`}
    >
      {label} <span className="font-medium text-ink">{d.total}</span>
      {d.delivered ? <Badge tone="success">✓✓ {d.delivered}</Badge> : null}
      {d.read ? <Badge tone="brand">{d.read} read</Badge> : null}
      {d.replied ? (
        <Link href="/crm/whatsapp?tab=replies&show=all" className="no-underline" title="Read what they wrote">
          <Badge tone="warn">{d.replied} replied</Badge>
        </Link>
      ) : null}
      {d.unconfirmed ? (
        <Badge tone="warn" title="Copied to paste, nobody confirmed it went">
          {d.unconfirmed} unconfirmed
        </Badge>
      ) : null}
      {d.failed ? <Badge tone="danger">{d.failed} failed</Badge> : null}
    </span>
  );
}
