"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  MoneyInput,
  PageHeader,
  Progress,
  SectionLabel,
  Select,
  SortableTh,
  Td,
  Th,
  Tr,
  cx,
  type Tone,
} from "@/components/ui/primitives";
import { FilterPills, Modal, RowMenu, Tabs } from "@/components/ui/overlays";
import { MultiSelect } from "@/components/ui/multi-select";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import { ExportMenu } from "@/components/ui/export-menu";
import { shiftMonth } from "@/components/ui/month";
import { APP_TIMEZONE } from "@/lib/business-date";
import { findTargetCandidates, setTarget, setTargetsBulk } from "@/lib/actions/crm";
import { money, moneyShort, pct, periodLabel } from "@/lib/format";
import { UNASSIGNED_FILTER_VALUE } from "@/lib/am-filters";
import { useRestoreSort, rememberSort } from "@/components/ui/use-remembered-sort";
import { parseSort, nextSort, formatSort } from "@/lib/sort-param";

const PER_PAGE = [25, 50, 100] as const;

/**
 * The same words `customerStatusLabel` and `STATUS_LABEL_SQL` produce on
 * the Customers list — with one deliberate omission. "Deactivated" is not
 * offered: a deactivated customer never reaches this table at all (see
 * `targetFilterClause`), so it would be a filter that always finds
 * nothing.
 */
const STATUS_OPTIONS = [
  { value: "Active", label: "Active" },
  { value: "Slow payer", label: "Slow payer" },
  { value: "Inactive", label: "Inactive" },
  { value: "New", label: "New" },
];

type Source = "hand" | "carried" | "default";

/**
 * Where a month's figure came from, in the words the table and the dialog
 * both use. A figure somebody typed for THIS month carries no badge — it is
 * the ordinary case, and a badge on every row is a badge nobody reads.
 */
const SOURCE_LABEL: Record<Source, string> = {
  hand: "Set by hand",
  carried: "Carried forward",
  default: "Auto default",
};
const SOURCE_HINT: Record<Source, string> = {
  hand: "Typed by a manager or accounts for this month",
  carried: "Set by hand last month, continuing unchanged",
  default: "Derived from what they bought in recent months — nobody chose this number",
};
const SOURCE_TONE: Record<Source, Tone> = {
  hand: "neutral",
  carried: "brand",
  default: "muted",
};

/**
 * How the Account manager column says WHICH seat `ownerName` came through —
 * see `CREDITED_TO_SEAT_SQL`. The column used to show only the credited
 * name, so "Heena" against an account meant nothing without opening the
 * record to see whether she sells to it or is only the back-office
 * fallback.
 */
const SEAT_LABEL: Record<Row["creditedSeat"], string> = {
  sales: "Sales",
  "back-office": "Back office",
  owner: "Lead owner",
  none: "Unattributed",
};
const SEAT_TONE: Record<Row["creditedSeat"], Tone> = {
  sales: "brand",
  "back-office": "neutral",
  owner: "muted",
  none: "muted",
};

/* ---------------------------------------------------------------------------
 * Monthly targets — per DIRECT customer, per month, and only where one is
 * allocated.
 *
 * SHARED between the CRM (`/crm/targets`) and Accounts
 * (`/accounts/customer-targets`), the same way `CustomersScreen` is: one read
 * (`listTargetsPage`), and one write (`setTarget`/`setTargetsBulk`), rendered
 * from one component so the two doors can never disagree about what a
 * customer's target is. `basePath` and `customerHrefTemplate` are the only
 * things that differ between the two apps.
 *
 * THE TABLE IS THE ALLOCATED TARGETS, NOT THE BOOK. It used to list every
 * direct customer, and most of them carried a target of ₹0 met at 0% — so
 * the accounts somebody had actually set a number for were scattered through
 * pages of rows that said nothing. A customer with nothing allocated is
 * COUNTED in the allocation strip instead, and the Allocate dialog is where
 * one gets a number: the table shows what is being chased, the strip says
 * what is not, and nothing is silently dropped.
 *
 * `customerHrefTemplate` is a STRING, not a function: this is a client
 * component, and a function prop from the server page that renders it cannot
 * cross that boundary without being marked `"use server"`. A `{id}` token
 * gets replaced with the real id instead.
 * ------------------------------------------------------------------------- */

type Row = {
  customerId: string;
  customerName: string;
  city: string | null;
  ownerName: string | null;
  /** Which seat `ownerName` was credited through — see sales-attribution.ts. */
  creditedSeat: "sales" | "back-office" | "owner" | "none";
  /** The two seats, read straight off the id — for showing the OTHER one too. */
  salesSeatName: string | null;
  backOfficeSeatName: string | null;
  target: number;
  achieved: number;
  gap: number;
  percent: number;
  isDefault: boolean;
  carriedForward: boolean;
  cycleDays: number;
  contactsThisMonth: number;
  /** Sales bills asked for in the month — null where none is. */
  billTarget: number | null;
  /** Sales bills raised this month so far. */
  billsAchieved: number;
  billGap: number;
};

type Candidate = {
  customerId: string;
  customerName: string;
  city: string | null;
  ownerName: string | null;
  target: number;
  source: Source | null;
  achieved: number;
  trailing: number[];
  billTarget: number | null;
  bills: number;
  trailingBills: number[];
};

/** "1 bill", "4 bills" — said the same way everywhere on this screen. */
function bills(n: number): string {
  return `${n.toLocaleString("en-IN")} bill${n === 1 ? "" : "s"}`;
}

/**
 * How far a row is through its month. The rupee figure leads where one is
 * set; a bills-only target is measured by its count, so a shop asked for five
 * bills and nothing else is not drawn at 0% of ₹0.
 */
function rowPercent(r: Pick<Row, "target" | "percent" | "billTarget" | "billsAchieved">): number {
  if (r.target > 0) return r.percent;
  return r.billTarget ? pct(r.billsAchieved, r.billTarget) : 0;
}

function sourceOf(r: Pick<Row, "isDefault" | "carriedForward">): Source {
  return r.isDefault ? "default" : r.carriedForward ? "carried" : "hand";
}

function progressTone(percent: number): "success" | "brand" | "warn" | "danger" {
  if (percent >= 100) return "success";
  if (percent >= 60) return "brand";
  if (percent >= 30) return "warn";
  return "danger";
}

export function MonthlyTargetsScreen({
  app,
  basePath,
  customerHrefTemplate,
  scopeLabel,
  canSet,
  period,
  rows,
  filters,
  pageInfo,
  totals,
  allocation,
  amOptions,
  view = "targets",
  topContent,
}: {
  /** Only changes which extra row-menu link is offered — CRM has its own bills screen, Accounts folds everything into the customer's ledger. */
  app: "crm" | "accounts";
  /** e.g. `/crm/targets` or `/accounts/customer-targets` — the period switcher navigates here. */
  basePath: string;
  /** Where a customer's name and "Open customer record" lead, e.g. `/crm/customers/{id}`. */
  customerHrefTemplate: string;
  scopeLabel: string;
  /** Whether THIS person holds `target.set` — a manager or accounts, never a telecaller. */
  canSet: boolean;
  period: string;
  /** Already filtered, counted and sliced by Postgres — this is one page. */
  rows: Row[];
  /** The Customers list's filters, plus where a figure came from and the Behind/Met tab. */
  filters: {
    query: string;
    status: string;
    salesAm: string;
    salesManager: string;
    backOfficeAm: string;
    source: string;
    progress: string;
    /** "column:asc"/"column:desc", or empty — see lib/sort-param.ts. */
    sort: string;
    perPage: number;
  };
  pageInfo: { page: number; pageCount: number; total: number; bookTotal: number };
  /** Over the filtered set (before the Behind/Met tab), not the page. */
  totals: {
    customers: number;
    target: number;
    achieved: number;
    gap: number;
    defaults: number;
    behind: number;
    maxGap: number;
    billTargeted: number;
    billTarget: number;
    billsAchieved: number;
  };
  /** Over every direct customer in scope, before any filter. */
  allocation: {
    allocated: number;
    unallocated: number;
    hand: number;
    carried: number;
    default: number;
  };
  /** The names each of the three seat filters can offer — `listAmFilterOptions`. */
  amOptions: { sales: string[]; salesManager: string[]; backOffice: string[] };
  /** Which tab is open — `?view=top` in the URL, so the report can be linked to. */
  view?: "targets" | "top" | "focus";
  /**
   * The Top customers report, rendered on the server and handed in whole. It
   * shares this screen's header and nothing else: it is not cut by the target
   * month or by these filters, because it is the company's list for its own
   * period and a filtered copy of it would no longer be the top anything.
   */
  topContent?: React.ReactNode;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const { run } = useToast();
  const customerHref = React.useCallback(
    (customerId: string) => customerHrefTemplate.replace("{id}", customerId),
    [customerHrefTemplate],
  );

  /*
   * One dialog for both doors into a target: `allocate` opens on a search,
   * `edit` opens on the row it was pressed from. The key is what makes each
   * opening start clean — see the React Compiler note in AGENTS.md.
   */
  const [dialog, setDialog] = React.useState<
    | { kind: "allocate"; nonce: number }
    | { kind: "edit"; row: Row; nonce: number }
    | null
  >(null);
  const [bulk, setBulk] = React.useState<"listed" | "unallocated" | null>(null);
  const openAllocate = () => setDialog({ kind: "allocate", nonce: Date.now() });

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
      router.push(`${basePath}?${next.toString()}`, { scroll: false });
    },
    [router, search, basePath],
  );

  const sort = parseSort(filters.sort);
  // Remembered per app — see the same reasoning on the Customers list.
  const sortTable = `targets.${app}`;
  useRestoreSort(sortTable, sort, (v) => navigate({ sort: formatSort(v) }));
  const sortBy = React.useCallback(
    (column: string) => {
      const v = nextSort(sort, column);
      rememberSort(sortTable, v);
      navigate({ sort: formatSort(v) });
    },
    [sort, sortTable, navigate],
  );

  // The search box is the one control that cannot afford a round trip per
  // keystroke, so it holds its own text and navigates when typing settles.
  const [draft, setDraft] = React.useState(filters.query);
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const asList = (v: string) => (v ? v.split(",").filter(Boolean) : []);
  // "Unassigned" is not one of the names the column ever renders, so it is
  // not among `amOptions` — offered here as a fixed option on all three,
  // same as on the Customers list.
  const unassignedOption = { value: UNASSIGNED_FILTER_VALUE, label: "Unassigned" };
  const salesAmOptions = [unassignedOption, ...amOptions.sales.map((n) => ({ value: n, label: n }))];
  const salesManagerOptions = [
    unassignedOption,
    ...amOptions.salesManager.map((n) => ({ value: n, label: n })),
  ];
  const backOfficeOptions = [
    unassignedOption,
    ...amOptions.backOffice.map((n) => ({ value: n, label: n })),
  ];
  const sourceOptions = (["hand", "carried", "default"] as const).map((k) => ({
    value: k,
    label: `${SOURCE_LABEL[k]} (${allocation[k].toLocaleString("en-IN")})`,
  }));

  const { page, pageCount, total } = pageInfo;
  const perPage = filters.perPage;
  const from = (page - 1) * perPage;
  const percent = pct(totals.achieved, totals.target);
  const met = totals.customers - totals.behind;
  const progressKey = (filters.progress === "behind" || filters.progress === "met"
    ? filters.progress
    : "all") as "all" | "behind" | "met";

  const describeMulti = (raw: string, options: { value: string; label: string }[]) => {
    const vals = asList(raw);
    if (!vals.length) return "";
    const byValue = new Map(options.map((o) => [o.value, o.label]));
    return vals.map((v) => byValue.get(v) ?? v).join(", ");
  };

  const chips = [
    filters.source
      ? {
          label: `Source: ${asList(filters.source)
            .map((v) => SOURCE_LABEL[v as Source] ?? v)
            .join(", ")}`,
          clear: () => navigate({ source: undefined }),
        }
      : null,
    filters.status
      ? {
          label: `Status: ${describeMulti(filters.status, STATUS_OPTIONS)}`,
          clear: () => navigate({ status: undefined }),
        }
      : null,
    filters.salesAm
      ? {
          label: `Sales: ${describeMulti(filters.salesAm, salesAmOptions)}`,
          clear: () => navigate({ sales: undefined }),
        }
      : null,
    filters.salesManager
      ? {
          label: `Sales manager: ${describeMulti(filters.salesManager, salesManagerOptions)}`,
          clear: () => navigate({ salesmanager: undefined }),
        }
      : null,
    filters.backOfficeAm
      ? {
          label: `Back office: ${describeMulti(filters.backOfficeAm, backOfficeOptions)}`,
          clear: () => navigate({ backoffice: undefined }),
        }
      : null,
    filters.query
      ? {
          label: `Search: ${filters.query}`,
          clear: () => {
            setDraft("");
            navigate({ q: undefined });
          },
        }
      : null,
  ].filter(Boolean) as Array<{ label: string; clear: () => void }>;

  function clearAll() {
    setDraft("");
    navigate({
      q: undefined,
      status: undefined,
      sales: undefined,
      salesmanager: undefined,
      backoffice: undefined,
      source: undefined,
      progress: undefined,
    });
  }

  const hasFilters = Boolean(
    filters.query ||
      filters.status ||
      filters.salesAm ||
      filters.salesManager ||
      filters.backOfficeAm ||
      filters.source,
  );
  const cannotSetTitle = "Setting targets is a manager or accounts action";

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Monthly targets"
        subtitle={
          view === "top"
            ? `${scopeLabel} · The company's biggest customers over whole months, generated on the 1st.`
            : view === "focus"
              ? `${scopeLabel} · Customers marked as needing attention to grow into top customers.`
            : `${periodLabel(period)} · ${scopeLabel} · Direct customers with a target for the month. Sales are counted net of GST.`
        }
        actions={
          view !== "targets" ? null : (
          <>
            <Select
              value={period}
              onChange={(e) => router.push(`${basePath}?period=${e.target.value}`)}
              className="h-9"
              aria-label="Month"
            >
              {periodOptions(period).map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
            <ExportMenu
              name={`Monthly targets, ${periodLabel(period)}`}
              csv={() => [
                [
                  "Customer",
                  "City",
                  "Target (Rs)",
                  "Achieved (Rs)",
                  "Gap (Rs)",
                  "Achievement (%)",
                  "Bill target",
                  "Bills raised",
                  "Account manager",
                  "Source",
                ],
                ...rows.map((r) => [
                  r.customerName,
                  r.city ?? "",
                  Math.round(r.target / 100),
                  Math.round(r.achieved / 100),
                  Math.round(r.gap / 100),
                  r.percent,
                  r.billTarget ?? "",
                  r.billsAchieved,
                  r.ownerName ?? "",
                  SOURCE_LABEL[sourceOf(r)],
                ]),
              ]}
            />
            <Button
              variant="secondary"
              disabled={!canSet}
              title={canSet ? undefined : cannotSetTitle}
              onClick={() => setBulk("listed")}
            >
              Bulk update
            </Button>
            <Button
              variant="primary"
              disabled={!canSet}
              title={canSet ? undefined : cannotSetTitle}
              onClick={openAllocate}
            >
              <Icon name="plus" size={16} />
              Allocate target
            </Button>
          </>
          )
        }
      />

      <Tabs
        value={view}
        onChange={(v) => router.push(v === "targets" ? basePath : `${basePath}?view=${v}`)}
        className="mb-4"
        tabs={[
          { key: "targets", label: "Targets" },
          { key: "top", label: "Top customers" },
          { key: "focus", label: "Focus customers" },
        ]}
      />

      {view !== "targets" ? (
        topContent
      ) : (
      <>

      {/* ------------------------------------------------ the month at a glance */}
      <Card className="mb-4 overflow-hidden">
        <div className="flex flex-wrap items-stretch">
          <div className="min-w-[320px] flex-[1.4] border-r border-divider px-5 py-4">
            <SectionLabel>Achieved against target</SectionLabel>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <span className="text-[26px] leading-8 font-semibold text-ink tabular-nums">
                {money(totals.achieved)}
              </span>
              <span className="text-[14px] text-muted tabular-nums">
                of {money(totals.target)}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Progress value={percent} tone={progressTone(percent)} className="h-2 flex-1" />
              <span className="w-10 text-right text-[13px] font-semibold text-ink tabular-nums">
                {percent}%
              </span>
            </div>
            <div className="mt-2 text-[13px] text-muted">
              {totals.gap ? (
                <>
                  <span className="font-medium text-danger tabular-nums">{money(totals.gap)}</span>{" "}
                  still to go across {totals.behind.toLocaleString("en-IN")} customer
                  {totals.behind === 1 ? "" : "s"}
                </>
              ) : totals.customers ? (
                <span className="font-medium text-success">Every target here is met</span>
              ) : (
                "No targets to measure yet"
              )}
            </div>
            {totals.billTargeted ? (
              <div className="mt-1.5 text-[13px] text-muted">
                <span className="font-medium text-ink tabular-nums">
                  {totals.billsAchieved.toLocaleString("en-IN")}
                </span>{" "}
                of {bills(totals.billTarget)} raised across{" "}
                {totals.billTargeted.toLocaleString("en-IN")} customer
                {totals.billTargeted === 1 ? "" : "s"} with a bill target
              </div>
            ) : null}
          </div>

          <SummaryStat
            label="With a target"
            value={totals.customers.toLocaleString("en-IN")}
            sub={
              hasFilters
                ? "matching your filters"
                : `of ${pageInfo.bookTotal.toLocaleString("en-IN")} direct customers`
            }
          />
          <SummaryStat
            label="Met"
            value={met.toLocaleString("en-IN")}
            tone="success"
            sub={totals.customers ? `${pct(met, totals.customers)}% of them` : undefined}
            onClick={() => navigate({ progress: progressKey === "met" ? undefined : "met" })}
            active={progressKey === "met"}
          />
          <SummaryStat
            label="Behind"
            value={totals.behind.toLocaleString("en-IN")}
            tone={totals.behind ? "danger" : undefined}
            sub={totals.behind ? `biggest gap ${moneyShort(totals.maxGap)}` : undefined}
            onClick={() => navigate({ progress: progressKey === "behind" ? undefined : "behind" })}
            active={progressKey === "behind"}
          />
        </div>

        {allocation.unallocated > 0 ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-divider bg-canvas px-5 py-2.5">
            <Icon name="target" size={16} className="text-muted" />
            <span className="text-[13px] text-body">
              <span className="font-semibold text-ink">
                {allocation.unallocated.toLocaleString("en-IN")}
              </span>{" "}
              direct customer{allocation.unallocated === 1 ? " has" : "s have"} no target for{" "}
              {periodLabel(period)}, so {allocation.unallocated === 1 ? "it is" : "they are"} not on
              this table.
            </span>
            <span className="flex-1" />
            {canSet ? (
              <span className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setBulk("unallocated")}>
                  Allocate in bulk
                </Button>
                <Button variant="secondary" size="sm" onClick={openAllocate}>
                  Allocate one
                </Button>
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* ----------------------------------------------------- the table */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-divider px-4 py-3">
          <FilterPills
            options={[
              { key: "all", label: "All", count: totals.customers },
              { key: "behind", label: "Behind", count: totals.behind },
              { key: "met", label: "Met", count: met },
            ]}
            value={progressKey}
            onChange={(k) => navigate({ progress: k === "all" ? undefined : k })}
          />
          <span className="mx-1 h-6 w-px bg-divider" />
          <div className="relative w-[240px]">
            <Icon
              name="search"
              size={16}
              className="pointer-events-none absolute top-2 left-2.5 text-muted"
            />
            <input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                clearTimeout(searchTimer.current);
                searchTimer.current = setTimeout(() => navigate({ q: e.target.value }), 300);
              }}
              placeholder="Search customer, phone or town"
              aria-label="Search customers"
              className="h-8 w-full rounded-[4px] border border-line pr-7 pl-7.5 text-sm outline-none focus:border-brand"
            />
            {filters.query ? (
              <button
                onClick={() => {
                  setDraft("");
                  navigate({ q: undefined });
                }}
                aria-label="Clear search"
                className="absolute top-1.5 right-1.5 h-4.5 w-4.5 cursor-pointer text-muted"
              >
                ×
              </button>
            ) : null}
          </div>
          <MultiSelect
            label="Source"
            placeholder="Any source"
            options={sourceOptions}
            selected={asList(filters.source)}
            onChange={(next) => navigate({ source: next.join(",") || undefined })}
          />
          <MultiSelect
            label="Status"
            placeholder="All statuses"
            options={STATUS_OPTIONS}
            selected={asList(filters.status)}
            onChange={(next) => navigate({ status: next.join(",") || undefined })}
          />
          <MultiSelect
            label="Sales people"
            placeholder="All sales people"
            options={salesAmOptions}
            selected={asList(filters.salesAm)}
            onChange={(next) => navigate({ sales: next.join(",") || undefined })}
          />
          <MultiSelect
            label="Sales managers"
            placeholder="All sales managers"
            options={salesManagerOptions}
            selected={asList(filters.salesManager)}
            onChange={(next) => navigate({ salesmanager: next.join(",") || undefined })}
          />
          <MultiSelect
            label="Back office"
            placeholder="All back office"
            options={backOfficeOptions}
            selected={asList(filters.backOfficeAm)}
            onChange={(next) => navigate({ backoffice: next.join(",") || undefined })}
          />
        </div>

        {chips.length ? (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-divider px-4 py-2.5">
            {chips.map((c) => (
              <button
                key={c.label}
                onClick={c.clear}
                className="flex cursor-pointer items-center gap-1 rounded-[4px] border border-line bg-canvas px-2 py-1 text-[12px] text-body hover:bg-line-soft"
              >
                {c.label}
                <span className="text-muted">×</span>
              </button>
            ))}
            <Button variant="ghost" size="sm" onClick={clearAll}>
              Clear all
            </Button>
          </div>
        ) : null}

        <div className="overflow-auto">
          {rows.length ? (
            <table>
              <thead>
                <tr>
                  <SortableTh
                    active={sort?.column === "name"}
                    direction={sort?.direction ?? "asc"}
                    onSort={() => sortBy("name")}
                  >
                    Customer
                  </SortableTh>
                  <Th>Account manager</Th>
                  <SortableTh
                    align="right"
                    active={sort?.column === "target"}
                    direction={sort?.direction ?? "asc"}
                    onSort={() => sortBy("target")}
                  >
                    Target
                  </SortableTh>
                  <SortableTh
                    align="right"
                    active={sort?.column === "achieved"}
                    direction={sort?.direction ?? "asc"}
                    onSort={() => sortBy("achieved")}
                  >
                    Achieved
                  </SortableTh>
                  <SortableTh
                    align="right"
                    active={sort?.column === "gap"}
                    direction={sort?.direction ?? "asc"}
                    onSort={() => sortBy("gap")}
                  >
                    Gap
                  </SortableTh>
                  <SortableTh
                    align="right"
                    active={sort?.column === "bills"}
                    direction={sort?.direction ?? "asc"}
                    onSort={() => sortBy("bills")}
                  >
                    Bills
                  </SortableTh>
                  <SortableTh
                    active={sort?.column === "achievement"}
                    direction={sort?.direction ?? "asc"}
                    onSort={() => sortBy("achievement")}
                  >
                    Progress
                  </SortableTh>
                  <Th align="right" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const source = sourceOf(r);
                  return (
                    <Tr key={r.customerId} className="hover:bg-canvas">
                      <Td>
                        <span className="flex max-w-[340px] flex-col gap-0.5 py-0.5">
                          <Link
                            href={customerHref(r.customerId)}
                            title={r.customerName}
                            className="truncate font-medium no-underline"
                          >
                            {r.customerName}
                          </Link>
                          <span className="flex items-center gap-1.5 text-[12px] text-muted">
                            {source !== "hand" ? (
                              <Badge tone={SOURCE_TONE[source]} title={SOURCE_HINT[source]}>
                                {SOURCE_LABEL[source]}
                              </Badge>
                            ) : null}
                            {r.city ? <span className="truncate">{r.city}</span> : null}
                          </span>
                        </span>
                      </Td>
                      <Td>
                        {r.ownerName ? (
                          <span className="flex flex-col gap-0.5 py-0.5">
                            <span className="flex items-center gap-1.5">
                              <span>{r.ownerName}</span>
                              <Badge tone={SEAT_TONE[r.creditedSeat]}>
                                {SEAT_LABEL[r.creditedSeat]}
                              </Badge>
                            </span>
                            {r.creditedSeat === "sales" &&
                            r.backOfficeSeatName &&
                            r.backOfficeSeatName !== r.ownerName ? (
                              <span className="text-[12px] text-muted">
                                Back office: {r.backOfficeSeatName}
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-muted">Unassigned</span>
                        )}
                      </Td>
                      <Td align="right" className="font-medium text-ink tabular-nums">
                        {r.target ? (
                          money(r.target)
                        ) : (
                          <span className="font-normal text-muted" title="Only a bill target is set">
                            —
                          </span>
                        )}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {money(r.achieved)}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {!r.target ? (
                          <span className="text-muted">—</span>
                        ) : r.gap ? (
                          <span className="text-danger">{money(r.gap)}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-success">
                            <Icon name="check" size={14} />
                            Met
                          </span>
                        )}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {r.billTarget ? (
                          <span
                            className={cx(
                              "inline-flex items-center gap-1",
                              r.billGap ? "text-ink" : "text-success",
                            )}
                            title={
                              r.billGap
                                ? `${bills(r.billGap)} still to raise this month`
                                : "Bill target met"
                            }
                          >
                            {r.billGap ? null : <Icon name="check" size={14} />}
                            {r.billsAchieved}
                            <span className="text-muted">/ {r.billTarget}</span>
                          </span>
                        ) : (
                          <span className="text-muted" title="No bill target this month">
                            {r.billsAchieved}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <span className="flex min-w-[150px] items-center gap-2.5">
                          <Progress
                            value={rowPercent(r)}
                            tone={progressTone(rowPercent(r))}
                            className="flex-1"
                          />
                          <span className="w-10 text-right text-[13px] text-body tabular-nums">
                            {rowPercent(r)}%
                          </span>
                        </span>
                      </Td>
                      <Td align="right">
                        <span className="flex items-center justify-end gap-1.5">
                          {canSet ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDialog({ kind: "edit", row: r, nonce: Date.now() })}
                            >
                              Edit
                            </Button>
                          ) : null}
                          <RowMenu
                            items={[
                              {
                                label: "Change target",
                                onSelect: () =>
                                  setDialog({ kind: "edit", row: r, nonce: Date.now() }),
                                disabled: !canSet,
                                title: canSet ? undefined : "Manager or accounts action",
                              },
                              {
                                label:
                                  app === "crm" ? "Open customer record" : "Open customer account",
                                onSelect: () => router.push(customerHref(r.customerId)),
                              },
                              ...(app === "crm"
                                ? [
                                    {
                                      label: "See their bills",
                                      onSelect: () =>
                                        router.push(`/crm/bills?customer=${r.customerId}`),
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        </span>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </table>
          ) : allocation.allocated === 0 ? (
            <EmptyState
              title={`No targets allocated for ${periodLabel(period)}`}
              body={
                allocation.unallocated
                  ? `${allocation.unallocated.toLocaleString("en-IN")} direct customers are waiting for one. Allocate a target to a customer, or give a group of them one in bulk.`
                  : "There are no direct customers in your view to give a target to."
              }
              action={
                canSet && allocation.unallocated ? (
                  <span className="flex gap-2">
                    <Button variant="secondary" onClick={() => setBulk("unallocated")}>
                      Allocate in bulk
                    </Button>
                    <Button variant="primary" onClick={openAllocate}>
                      Allocate target
                    </Button>
                  </span>
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              title="No targets match these filters"
              body="Widen the search or clear the filters to see every allocated target."
              action={
                <Button variant="primary" onClick={clearAll}>
                  Clear filters
                </Button>
              }
            />
          )}
        </div>

        {total ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-divider px-4 py-3">
            <span className="text-[13px] text-muted">
              {from + 1}&ndash;{Math.min(from + perPage, total)} of {total.toLocaleString("en-IN")}
            </span>

            <span className="flex items-center gap-2 text-[13px] text-muted">
              <label htmlFor="targets-per-page">Show</label>
              <select
                id="targets-per-page"
                value={perPage}
                onChange={(e) => {
                  // Keep the first row of this page in view rather than
                  // jumping to the top: a page size is a change of zoom,
                  // not of place.
                  const next = Number(e.target.value);
                  navigate({ per: next, page: Math.floor(from / next) + 1 });
                }}
                className="h-8 cursor-pointer rounded-[4px] border border-line bg-canvas px-2 text-[13px] text-body"
              >
                {PER_PAGE.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </span>

            <span className="flex-1" />

            <span className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                title={page <= 1 ? "This is the first page" : undefined}
                onClick={() => navigate({ page: page - 1 })}
              >
                Previous
              </Button>
              <span className="text-[13px] text-body tabular-nums">
                {page} / {pageCount}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= pageCount}
                title={page >= pageCount ? "This is the last page" : undefined}
                onClick={() => navigate({ page: page + 1 })}
              >
                Next
              </Button>
            </span>
          </div>
        ) : null}
      </Card>
      </>
      )}

      {dialog ? (
        <TargetDialog
          key={dialog.nonce}
          period={period}
          initial={dialog.kind === "edit" ? dialog.row : null}
          onClose={() => setDialog(null)}
          onSave={async (customerId, amount, billCount) => {
            const result = await run(setTarget(customerId, amount, period, billCount));
            if (result.ok) router.refresh();
            return result.ok;
          }}
        />
      ) : null}

      {bulk ? (
        <BulkTargetModal
          key={bulk}
          initialPopulation={bulk}
          period={period}
          listedCount={totals.customers}
          defaultsCount={totals.defaults}
          unallocatedCount={allocation.unallocated}
          hasFilters={hasFilters}
          onClose={() => setBulk(null)}
          onSubmit={async (population, mode, value) => {
            const result = await run(
              setTargetsBulk({
                filters: {
                  query: filters.query || undefined,
                  status: filters.status || undefined,
                  salesAm: filters.salesAm || undefined,
                  salesManager: filters.salesManager || undefined,
                  backOfficeAm: filters.backOfficeAm || undefined,
                  source: filters.source || undefined,
                },
                population,
                mode,
                value,
                period,
              }),
            );
            if (result.ok) {
              setBulk(null);
              router.refresh();
            }
          }}
        />
      ) : null}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  sub,
  tone,
  onClick,
  active,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "success" | "danger";
  onClick?: () => void;
  active?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-pressed={onClick ? Boolean(active) : undefined}
      title={onClick ? (active ? "Show every target" : `Show only: ${label}`) : undefined}
      className={cx(
        // A button centres its content by default; the tiles beside it are
        // plain blocks, so the two read at different heights without this.
        "flex min-w-[150px] flex-1 flex-col items-start justify-start border-r border-divider px-5 py-4 text-left last:border-r-0",
        onClick && "cursor-pointer hover:bg-canvas",
        active && "bg-brand-soft hover:bg-brand-soft",
      )}
    >
      <SectionLabel>{label}</SectionLabel>
      <div
        className={cx(
          "mt-1 text-[26px] leading-8 font-semibold tabular-nums",
          tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-1 text-[12px] text-muted">{sub}</div> : null}
    </Tag>
  );
}

/**
 * The months a target can be read or set for: next month — so a manager can
 * allocate before the first, when `seedMonthlyTargets` leaves a figure
 * already typed alone — this month, and the five before it. The selected
 * period is always offered, even if somebody arrived at an older one by URL.
 */
function periodOptions(selected: string): Array<{ value: string; label: string }> {
  // Which month it is, in the business's zone rather than the browser's. On
  // the first of a month a device set to a zone behind IST is still on the
  // last one, and would offer a period list starting a month back.
  const now = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: APP_TIMEZONE,
      year: "numeric",
      month: "2-digit",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const current = `${now.year}-${now.month}`;
  const out = [{ value: shiftMonth(current, 1), label: `${periodLabel(shiftMonth(current, 1))} (next)` }];
  for (let i = 0; i < 6; i++) {
    const p = shiftMonth(current, -i);
    out.push({ value: p, label: i === 0 ? `${periodLabel(p)} (this month)` : periodLabel(p) });
  }
  if (!out.some((o) => o.value === selected)) {
    out.push({ value: selected, label: periodLabel(selected) });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * ALLOCATE OR CHANGE ONE TARGET.
 *
 * One dialog for both: opened from "Allocate target" it starts on a search of
 * the direct customers in view, unallocated first; opened from a row it
 * starts on that customer. Either way the number is typed beside what the
 * customer actually bought in the three months before — a target picked
 * without that is a number picked out of the air — and the suggestions are
 * arithmetic on those months, never a figure the screen invented.
 * ------------------------------------------------------------------------- */

function TargetDialog({
  period,
  initial,
  onClose,
  onSave,
}: {
  period: string;
  /** The row an edit was opened from; null opens on the customer search. */
  initial: Row | null;
  onClose: () => void;
  onSave: (customerId: string, amount: string, bills: string) => Promise<boolean>;
}) {
  const allocating = initial === null;
  const [picked, setPicked] = React.useState<Candidate | null>(
    initial
      ? {
          customerId: initial.customerId,
          customerName: initial.customerName,
          city: initial.city,
          ownerName: initial.ownerName,
          target: initial.target,
          source: sourceOf(initial),
          achieved: initial.achieved,
          trailing: [],
          billTarget: initial.billTarget,
          bills: initial.billsAchieved,
          trailingBills: [],
        }
      : null,
  );
  const [loadingContext, setLoadingContext] = React.useState(Boolean(initial));
  const [amount, setAmount] = React.useState(
    initial && initial.target ? String(Math.round(initial.target / 100)) : "",
  );
  const [billCount, setBillCount] = React.useState(
    initial?.billTarget ? String(initial.billTarget) : "",
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedCount, setSavedCount] = React.useState(0);

  // An edit opens on a row the table already drew; the three months before
  // are the one thing the row does not carry, so they are asked for once.
  React.useEffect(() => {
    if (!initial) return;
    let live = true;
    findTargetCandidates({ period, customerId: initial.customerId }).then((r) => {
      if (!live) return;
      if (r.ok && r.data[0]) {
        const ctx = r.data[0];
        setPicked((p) =>
          p ? { ...p, trailing: ctx.trailing, trailingBills: ctx.trailingBills, bills: ctx.bills } : p,
        );
      }
      setLoadingContext(false);
    });
    return () => {
      live = false;
    };
  }, [initial, period]);

  const amountPaise = Math.round(Number(amount.replace(/[^0-9.]/g, "") || 0) * 100);
  const billNumber = Number(billCount.trim() || 0);
  const billValid = billCount.trim() === "" || (Number.isInteger(billNumber) && billNumber > 0);

  async function save(andAnother: boolean) {
    if (!picked) return;
    if (!billValid) {
      setError("Enter the number of bills as a whole number, or leave it empty.");
      return;
    }
    if (!amountPaise && !billNumber) {
      setError("Enter a sales target, a number of bills, or both.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ok = await onSave(picked.customerId, amount, billCount);
      if (!ok) return;
      if (andAnother) {
        setSavedCount((n) => n + 1);
        setPicked(null);
        setAmount("");
        setBillCount("");
      } else {
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  const title = allocating
    ? picked
      ? `Allocate target · ${periodLabel(period)}`
      : `Allocate a target · ${periodLabel(period)}`
    : `Change target · ${periodLabel(period)}`;

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width={600}
      footer={
        picked ? (
          <>
            {allocating ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setPicked(null);
                  setAmount("");
                  setBillCount("");
                  setError(null);
                }}
                className="mr-auto"
                title="Pick a different customer"
              >
                ← Back
              </Button>
            ) : null}
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            {allocating ? (
              <Button variant="secondary" disabled={busy} onClick={() => save(true)}>
                Save and add another
              </Button>
            ) : null}
            <Button variant="primary" disabled={busy} onClick={() => save(false)}>
              {busy ? "Saving…" : allocating ? "Allocate target" : "Save target"}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            {savedCount ? "Done" : "Cancel"}
          </Button>
        )
      }
    >
      {savedCount && !picked ? (
        <div className="mb-3 flex items-center gap-2 rounded-[4px] border border-success-soft bg-success-soft px-3 py-2 text-[13px] text-success">
          <Icon name="check" size={14} />
          {savedCount} target{savedCount === 1 ? "" : "s"} allocated. Pick the next customer.
        </div>
      ) : null}

      {picked ? (
        <TargetForm
          period={period}
          customer={picked}
          loadingContext={loadingContext}
          amount={amount}
          amountPaise={amountPaise}
          billCount={billCount}
          billNumber={billValid ? billNumber : 0}
          error={error}
          onAmount={(v) => {
            setAmount(v);
            setError(null);
          }}
          onBills={(v) => {
            setBillCount(v.replace(/[^0-9]/g, ""));
            setError(null);
          }}
          onSubmit={() => save(false)}
        />
      ) : (
        <CustomerPicker
          period={period}
          onPick={(c) => {
            setPicked(c);
            setAmount(c.target ? String(Math.round(c.target / 100)) : "");
            setBillCount(c.billTarget ? String(c.billTarget) : "");
            setError(null);
          }}
        />
      )}
    </Modal>
  );
}

function CustomerPicker({
  period,
  onPick,
}: {
  period: string;
  onPick: (c: Candidate) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<{
    for: string;
    rows: Candidate[];
    error: string | null;
  } | null>(null);
  const loading = state === null || state.for !== query;

  // Settled typing asks the server; the answer is kept with the query it
  // answers, so a slow reply to "ab" can never overwrite the one for "abc".
  React.useEffect(() => {
    let live = true;
    const t = setTimeout(
      () => {
        findTargetCandidates({ period, query }).then((r) => {
          if (!live) return;
          setState(
            r.ok
              ? { for: query, rows: r.data as Candidate[], error: null }
              : { for: query, rows: [], error: r.error },
          );
        });
      },
      query ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, period]);

  const rows = state?.rows ?? [];

  return (
    <div>
      <div className="relative mb-3">
        <Icon
          name="search"
          size={16}
          className="pointer-events-none absolute top-2.5 left-2.5 text-muted"
        />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search direct customers by name, phone or town"
          aria-label="Search direct customers"
          className="h-9.5 pl-8"
        />
      </div>
      <div className="mb-2 text-[12px] text-muted">
        Customers without a target for {periodLabel(period)} are listed first. Picking one that
        already has a target lets you change it.
      </div>

      <div className="max-h-[340px] overflow-y-auto rounded-[4px] border border-line">
        {state?.error ? (
          <div className="px-3 py-6 text-center text-[13px] text-danger">{state.error}</div>
        ) : rows.length === 0 && !loading ? (
          <div className="px-3 py-8 text-center text-[13px] text-muted">
            {query
              ? `No direct customer matches “${query}”. Leads and shops billed by a distributor do not carry a target.`
              : "There are no direct customers in your view."}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-[13px] text-muted">Searching…</div>
        ) : (
          <ul className={cx(loading && "opacity-60")}>
            {rows.map((c) => {
              const avg = average(c.trailing);
              const avgBills = averageCount(c.trailingBills);
              return (
                <li key={c.customerId} className="border-b border-divider last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onPick(c)}
                    className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left hover:bg-canvas"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {c.customerName}
                      </span>
                      <span className="block truncate text-[12px] text-muted">
                        {[c.city, c.ownerName].filter(Boolean).join(" · ") || "—"}
                        {avg ? ` · averages ${moneyShort(avg)}/month` : " · no recent sales"}
                        {avgBills ? `, ${bills(avgBills)}` : ""}
                      </span>
                    </span>
                    {c.target || c.billTarget ? (
                      <span className="flex flex-none flex-col items-end">
                        <span className="text-[13px] font-medium text-ink tabular-nums">
                          {[c.target ? money(c.target) : null, c.billTarget ? bills(c.billTarget) : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {c.source ? (
                          <span className="text-[11px] text-muted">{SOURCE_LABEL[c.source]}</span>
                        ) : null}
                      </span>
                    ) : (
                      <Badge tone="warn">No target</Badge>
                    )}
                    <Icon name="chevron" size={16} className="flex-none text-line-strong" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {rows.length >= 20 ? (
        <div className="mt-2 text-[12px] text-muted">
          Showing the first 20 — type to narrow the list.
        </div>
      ) : null}
    </div>
  );
}

function TargetForm({
  period,
  customer,
  loadingContext,
  amount,
  amountPaise,
  billCount,
  billNumber,
  error,
  onAmount,
  onBills,
  onSubmit,
}: {
  period: string;
  customer: Candidate;
  loadingContext: boolean;
  amount: string;
  amountPaise: number;
  billCount: string;
  /** The typed count, 0 where the box is empty or not a whole number. */
  billNumber: number;
  error: string | null;
  onAmount: (v: string) => void;
  onBills: (v: string) => void;
  onSubmit: () => void;
}) {
  const avg = average(customer.trailing);
  const last = customer.trailing[0] ?? 0;
  const best = Math.max(0, ...customer.trailing);

  // Arithmetic on their own months, rounded to the nearest hundred rupees —
  // a suggestion that reads like a bill total reads like a measurement.
  const round = (paise: number) => Math.round(paise / 10_000) * 10_000;
  const suggestions = [
    { label: "3-month average", value: round(avg) },
    { label: "Average +10%", value: round(avg * 1.1) },
    { label: "Average +20%", value: round(avg * 1.2) },
    { label: "Best month", value: round(best) },
  ].filter(
    (s, i, all) => s.value > 0 && all.findIndex((o) => o.value === s.value) === i,
  );

  // The same arithmetic on the bill counts, kept to whole bills — "about
  // four a month, ask for five" is the conversation this field is for.
  const avgBills = averageCount(customer.trailingBills);
  const bestBills = Math.max(0, ...customer.trailingBills);
  const billSuggestions = [
    { label: "3-month average", value: avgBills },
    { label: "Average +1", value: avgBills + 1 },
    { label: "Average +2", value: avgBills + 2 },
    { label: "Best month", value: bestBills },
  ].filter((s, i, all) => s.value > 0 && all.findIndex((o) => o.value === s.value) === i);
  const billsAfter = billNumber
    ? {
        percent: pct(customer.bills, billNumber),
        gap: Math.max(0, billNumber - customer.bills),
      }
    : null;

  const after = amountPaise
    ? {
        percent: pct(customer.achieved, amountPaise),
        gap: Math.max(0, amountPaise - customer.achieved),
        vsAvg: avg ? Math.round(((amountPaise - avg) / avg) * 100) : null,
      }
    : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="grid gap-4"
    >
      <div className="rounded-[4px] border border-line px-3.5 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-ink">
              {customer.customerName}
            </div>
            <div className="truncate text-[12px] text-muted">
              {[customer.city, customer.ownerName].filter(Boolean).join(" · ") || "Direct customer"}
            </div>
          </div>
          {customer.target || customer.billTarget ? (
            <span className="flex flex-none flex-col items-end">
              <span className="text-[11px] tracking-[0.04em] text-muted uppercase">Current</span>
              <span className="text-sm font-medium text-ink tabular-nums">
                {[
                  customer.target ? money(customer.target) : null,
                  customer.billTarget ? bills(customer.billTarget) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {customer.source ? (
                <span className="text-[11px] text-muted">{SOURCE_LABEL[customer.source]}</span>
              ) : null}
            </span>
          ) : (
            <Badge tone="warn">No target yet</Badge>
          )}
        </div>

        <div className="mt-3 grid grid-cols-4 gap-2 border-t border-divider pt-3">
          {[3, 2, 1].map((back) => {
            const value = customer.trailing[back - 1];
            const count = customer.trailingBills[back - 1];
            return (
              <div key={back}>
                <div className="text-[11px] text-muted">{shortMonth(shiftMonth(period, -back))}</div>
                <div className="text-[13px] font-medium text-ink tabular-nums">
                  {loadingContext || value === undefined ? "…" : money(value)}
                </div>
                <div className="text-[12px] text-muted tabular-nums">
                  {loadingContext || count === undefined ? "…" : bills(count)}
                </div>
              </div>
            );
          })}
          <div>
            <div className="text-[11px] text-muted">{shortMonth(period)} so far</div>
            <div className="text-[13px] font-medium text-brand tabular-nums">
              {money(customer.achieved)}
            </div>
            <div className="text-[12px] text-brand tabular-nums">{bills(customer.bills)}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_180px] items-start gap-3">
      <Field
        label={`Sales target for ${periodLabel(period)} (excl. GST)`}
        error={error}
        hint={
          customer.source === "default"
            ? "This customer is on the auto-applied default. Saving replaces it with your number."
            : customer.source === "carried"
              ? "Carried forward from last month. Saving fixes this month's own number."
              : undefined
        }
      >
        <MoneyInput
          autoFocus
          value={amount}
          onChange={(e) => onAmount(e.target.value)}
          placeholder="e.g. 50000"
          invalid={Boolean(error)}
        />
      </Field>
      <Field label="Bills this month" hint="Optional. Sales bills to raise.">
        <Input
          inputMode="numeric"
          value={billCount}
          onChange={(e) => onBills(e.target.value)}
          placeholder="e.g. 5"
          aria-label="Bill target"
        />
      </Field>
      </div>

      {suggestions.length ? (
        <div>
          <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Based on what they bought
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => onAmount(String(Math.round(s.value / 100)))}
                className={cx(
                  "cursor-pointer rounded-[4px] border px-2.5 py-1.5 text-left",
                  amountPaise === s.value
                    ? "border-brand bg-brand-soft"
                    : "border-line bg-surface hover:bg-canvas",
                )}
              >
                <span className="block text-[11px] text-muted">{s.label}</span>
                <span className="block text-[13px] font-medium text-ink tabular-nums">
                  {money(s.value)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : !loadingContext && !last && !avg ? (
        <div className="text-[13px] text-muted">
          No sales in the last three months, so there is nothing to suggest a figure from.
        </div>
      ) : null}

      {after ? (
        <div className="rounded-[4px] bg-canvas px-3.5 py-2.5 text-[13px] text-body">
          <div className="mb-2 flex items-center gap-2.5">
            <Progress value={after.percent} tone={progressTone(after.percent)} className="flex-1" />
            <span className="w-10 text-right font-medium text-ink tabular-nums">
              {after.percent}%
            </span>
          </div>
          {after.gap ? (
            <>
              <span className="font-medium text-danger tabular-nums">{money(after.gap)}</span> still
              to go this month
            </>
          ) : (
            <span className="font-medium text-success">Already met by this month&apos;s orders</span>
          )}
          {after.vsAvg !== null ? (
            <span className="text-muted">
              {" "}
              ·{" "}
              {after.vsAvg === 0
                ? "in line with"
                : after.vsAvg > 0
                  ? `${after.vsAvg}% above`
                  : `${-after.vsAvg}% below`}{" "}
              their 3-month average
            </span>
          ) : null}
        </div>
      ) : null}
      {billSuggestions.length ? (
        <div>
          <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Bills, based on their months
          </div>
          <div className="flex flex-wrap gap-2">
            {billSuggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => onBills(String(s.value))}
                className={cx(
                  "cursor-pointer rounded-[4px] border px-2.5 py-1.5 text-left",
                  billNumber === s.value
                    ? "border-brand bg-brand-soft"
                    : "border-line bg-surface hover:bg-canvas",
                )}
              >
                <span className="block text-[11px] text-muted">{s.label}</span>
                <span className="block text-[13px] font-medium text-ink tabular-nums">
                  {bills(s.value)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {billsAfter ? (
        <div className="rounded-[4px] bg-canvas px-3.5 py-2.5 text-[13px] text-body">
          <div className="mb-2 flex items-center gap-2.5">
            <Progress
              value={billsAfter.percent}
              tone={progressTone(billsAfter.percent)}
              className="flex-1"
            />
            <span className="w-10 text-right font-medium text-ink tabular-nums">
              {billsAfter.percent}%
            </span>
          </div>
          {billsAfter.gap ? (
            <>
              <span className="font-medium text-danger tabular-nums">{bills(billsAfter.gap)}</span>{" "}
              still to raise this month
            </>
          ) : (
            <span className="font-medium text-success">Bill target already met this month</span>
          )}
          <span className="text-muted">
            {" "}
            · {bills(customer.bills)} raised so far
            {avgBills ? `, about ${bills(avgBills)} a month lately` : ""}
          </span>
        </div>
      ) : null}

      {/* Enter saves, as a dialog with its fields should. */}
      <button type="submit" hidden />
    </form>
  );
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** An average count, to the nearest whole bill. */
function averageCount(values: number[]): number {
  if (!values.length) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function shortMonth(period: string): string {
  return periodLabel(period).replace(/^(\w{3})\w*/, "$1");
}

/* ---------------------------------------------------------------------------
 * MANY TARGETS AT ONCE, over a population the dialog names in words.
 *
 * Three populations, because "the customers my filters match" now means two
 * different sets: the targets on the table, and the direct customers the same
 * filters reach that carry no target and so are NOT on it. The server
 * resolves either from the filters (`resolveTargetCustomerIds`) rather than
 * trusting a client-side reading of one page.
 * ------------------------------------------------------------------------- */

function BulkTargetModal({
  initialPopulation,
  period,
  listedCount,
  defaultsCount,
  unallocatedCount,
  hasFilters,
  onClose,
  onSubmit,
}: {
  initialPopulation: "listed" | "unallocated";
  period: string;
  listedCount: number;
  defaultsCount: number;
  unallocatedCount: number;
  hasFilters: boolean;
  onClose: () => void;
  onSubmit: (
    population: "listed" | "defaults" | "unallocated",
    mode: "amount" | "uplift",
    value: string,
  ) => Promise<void>;
}) {
  const [population, setPopulation] = React.useState<"listed" | "defaults" | "unallocated">(
    initialPopulation,
  );
  const [mode, setMode] = React.useState<"amount" | "uplift">("uplift");
  const [value, setValue] = React.useState("10");
  const [busy, setBusy] = React.useState(false);

  const scope = hasFilters ? " matching your filters" : "";
  const options = [
    {
      key: "listed" as const,
      title: "Every target on the table",
      body: `${listedCount.toLocaleString("en-IN")} customers${scope} — overwrites their current figure`,
      count: listedCount,
    },
    {
      key: "defaults" as const,
      title: "Only targets still on the auto default",
      body: `${defaultsCount.toLocaleString("en-IN")} customers${scope} — numbers somebody chose are left alone`,
      count: defaultsCount,
    },
    {
      key: "unallocated" as const,
      title: "Direct customers with no target yet",
      body: `${unallocatedCount.toLocaleString("en-IN")} customers not on the table${hasFilters ? " (your search, status and seat filters apply)" : ""}`,
      count: unallocatedCount,
    },
  ];
  const chosen = options.find((o) => o.key === population)!;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Set targets in bulk · ${periodLabel(period)}`}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !chosen.count}
            title={chosen.count ? undefined : "Nobody is in that group"}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(population, mode, value);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Applying…" : `Apply to ${chosen.count.toLocaleString("en-IN")}`}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div>
          <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Who gets a target
          </div>
          <div className="grid gap-2">
            {options.map((o) => (
              <label
                key={o.key}
                className={cx(
                  "flex cursor-pointer items-start gap-2.5 rounded-[4px] border px-3 py-2.5",
                  population === o.key ? "border-brand bg-brand-soft" : "border-line hover:bg-canvas",
                )}
              >
                <input
                  type="radio"
                  name="bulk-population"
                  checked={population === o.key}
                  onChange={() => setPopulation(o.key)}
                  className="mt-0.5 h-[15px] w-[15px] accent-[#6835FB]"
                />
                <span>
                  <span className="block text-sm font-medium text-ink">{o.title}</span>
                  <span className="block text-[12px] text-muted">{o.body}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <Field label="How to set them">
          <Select
            value={mode}
            onChange={(e) => {
              const next = e.target.value as "amount" | "uplift";
              setMode(next);
              setValue(next === "uplift" ? "10" : "50000");
            }}
          >
            <option value="uplift">An uplift on each customer&apos;s own figure</option>
            <option value="amount">The same flat amount for everyone</option>
          </Select>
        </Field>

        {mode === "uplift" ? (
          <Field
            label="Uplift %"
            hint="Raises each customer's current target by this much. A customer with no target starts from their average month over recent months — one with no recent sales is skipped."
          >
            <Input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-[140px]"
            />
          </Field>
        ) : (
          <Field label="Target for each customer (excl. GST)">
            <MoneyInput value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}

        {population !== "unallocated" ? (
          <div className="rounded-[4px] border border-warn-line bg-warn-soft px-2.5 py-2 text-[13px] text-warn-ink">
            This replaces the existing target of {chosen.count.toLocaleString("en-IN")} customer
            {chosen.count === 1 ? "" : "s"} for {periodLabel(period)}.
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
