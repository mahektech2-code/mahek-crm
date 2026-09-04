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
  MetricStrip,
  MoneyInput,
  PageHeader,
  Progress,
  SectionLabel,
  Select,
  Td,
  Th,
  Tr,
  cx,
  type Tone,
} from "@/components/ui/primitives";
import { Modal, RowMenu, Tabs } from "@/components/ui/overlays";
import { MultiSelect } from "@/components/ui/multi-select";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import { APP_TIMEZONE } from "@/lib/business-date";
import { setTarget, setTargetsBulk } from "@/lib/actions/crm";
import { money, moneyShort, pct, periodLabel } from "@/lib/format";
import { UNASSIGNED_FILTER_VALUE } from "@/lib/am-filters";

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
 * Monthly targets — per customer, per month.
 *
 * SHARED between the CRM (`/crm/targets`) and Accounts
 * (`/accounts/customer-targets`), the same way `CustomersScreen` is: one read
 * (`listTargets`), one write (`setTarget`/`setTargetsBulk`), one shortfall
 * engine, rendered from one component so the two doors can never disagree
 * about what a customer's target is. `basePath` and `customerHrefTemplate`
 * are the only things that differ between the two apps — everything else,
 * including the business rules, is identical.
 *
 * `customerHrefTemplate` is a STRING, not a function: this is a client
 * component, and a function prop from the server page that renders it cannot
 * cross that boundary without being marked `"use server"`. A `{id}` token
 * gets replaced with the real id instead.
 * ------------------------------------------------------------------------- */

type Row = {
  customerId: string;
  customerName: string;
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
};

type Classified = {
  customerId: string;
  name: string;
  gap: number;
  cycleDays: number;
  contactsThisMonth: number;
  expectedContacts: number;
};

type Shortfall = {
  coverageGap: Classified[];
  customerGap: Classified[];
  coverageGapValue: number;
  customerGapValue: number;
  totalShortfall: number;
} | null;

type Tab = "targets" | "shortfall";

export function MonthlyTargetsScreen({
  app,
  basePath,
  customerHrefTemplate,
  scopeLabel,
  canSet,
  period,
  rows,
  shortfall,
  filters,
  pageInfo,
  totals,
  amOptions,
}: {
  /** Only changes which extra row-menu link is offered — CRM has its own bills screen, Accounts folds everything into the customer's ledger. */
  app: "crm" | "accounts";
  /** e.g. `/crm/targets` or `/accounts/customer-targets` — the period switcher navigates here. */
  basePath: string;
  /** Where a customer's name and "Open customer record" lead, e.g. `/crm/customers/{id}`. */
  customerHrefTemplate: string;
  scopeLabel: string;
  /** Whether THIS person holds `target.set`/`target.shortfall` — a manager or accounts, never a telecaller. */
  canSet: boolean;
  period: string;
  /** Already filtered, counted and sliced by Postgres — this is one page. */
  rows: Row[];
  shortfall: Shortfall;
  /** The same four filters the Customers list offers, read the same way. */
  filters: {
    query: string;
    status: string;
    salesAm: string;
    salesManager: string;
    backOfficeAm: string;
    perPage: number;
  };
  pageInfo: { page: number; pageCount: number; total: number; bookTotal: number };
  /** Over the filtered set, not the page — the summary card describes the search. */
  totals: {
    target: number;
    achieved: number;
    gap: number;
    defaults: number;
    behind: number;
    maxGap: number;
  };
  /** The names each of the three seat filters can offer — `listAmFilterOptions`. */
  amOptions: { sales: string[]; salesManager: string[]; backOffice: string[] };
}) {
  const router = useRouter();
  const search = useSearchParams();
  const { run } = useToast();
  const customerHref = React.useCallback(
    (customerId: string) => customerHrefTemplate.replace("{id}", customerId),
    [customerHrefTemplate],
  );

  const [tab, setTab] = React.useState<Tab>("targets");
  const [editing, setEditing] = React.useState<Row | null>(null);
  const [bulkOpen, setBulkOpen] = React.useState(false);

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

  // The search box is the one control that cannot afford a round trip per
  // keystroke, so it holds its own text and navigates when typing settles.
  const [draft, setDraft] = React.useState(filters.query);
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const asList = (v: string) => (v ? v.split(",").filter(Boolean) : []);
  // "Unassigned" is not one of the names the column ever renders, so it is
  // not among `amOptions` — offered here as a fixed option on all three,
  // same as on the Customers list.
  const unassignedOption = { value: UNASSIGNED_FILTER_VALUE, label: "Unassigned" };
  const salesAmOptions = [
    unassignedOption,
    ...amOptions.sales.map((n) => ({ value: n, label: n })),
  ];
  const salesManagerOptions = [
    unassignedOption,
    ...amOptions.salesManager.map((n) => ({ value: n, label: n })),
  ];
  const backOfficeOptions = [
    unassignedOption,
    ...amOptions.backOffice.map((n) => ({ value: n, label: n })),
  ];

  const { page, pageCount, total } = pageInfo;
  const perPage = filters.perPage;
  const from = (page - 1) * perPage;
  const target = totals.target;
  const achieved = totals.achieved;
  const gap = totals.gap;
  const percent = pct(achieved, target);
  const defaults = totals.defaults;

  const describeMulti = (raw: string, options: { value: string; label: string }[]) => {
    const vals = asList(raw);
    if (!vals.length) return "";
    const byValue = new Map(options.map((o) => [o.value, o.label]));
    return vals.map((v) => byValue.get(v) ?? v).join(", ");
  };

  const chips = [
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
    });
  }

  // The engine classifies the shortfall — the screen only lays it out. The
  // distinction is the point of the tab: a coverage gap is the telecaller's to
  // fix, a customer gap is a price, stock or terms conversation. Unfiltered
  // and unpaginated on purpose — it reads the whole scoped book, independent
  // of whatever the Targets tab's filters are currently set to.
  const behind = totals.behind;
  const groups: Array<{
    title: string;
    accent: string;
    blurb: string;
    rows: Classified[];
    value: number;
  }> = [
    {
      title: "Coverage gap",
      accent: "#B3261E",
      blurb:
        "Behind target and contacted less often than their own buying cycle implies. Call these before anything else.",
      rows: shortfall?.coverageGap ?? [],
      value: shortfall?.coverageGapValue ?? 0,
    },
    {
      title: "Customer gap",
      accent: "#B77B08",
      blurb:
        "Contacted often enough and the number still is not moving. Look at price, stock or terms.",
      rows: shortfall?.customerGap ?? [],
      value: shortfall?.customerGapValue ?? 0,
    },
  ];

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Monthly targets"
        subtitle={`${scopeLabel} · Per customer, per month. Where no target was set, a default is applied and marked.`}
        actions={
          <>
            <Select
              value={period}
              onChange={(e) => router.push(`${basePath}?period=${e.target.value}`)}
              className="h-9"
            >
              {recentPeriods().map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p)}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              disabled={!canSet}
              title={canSet ? undefined : "Setting targets is a manager or accounts action"}
              onClick={() => setBulkOpen(true)}
            >
              Set targets in bulk
            </Button>
          </>
        }
      />

      <Card className="mb-4 flex items-center gap-8 px-5 py-4">
        <span>
          <SectionLabel>Target</SectionLabel>
          <span className="text-[22px] font-semibold text-ink">{money(total)}</span>
        </span>
        <span>
          <SectionLabel>Achieved</SectionLabel>
          <span className="text-[22px] font-semibold text-ink">{money(achieved)}</span>
        </span>
        <span>
          <SectionLabel>Gap</SectionLabel>
          <span
            className={cx(
              "text-[22px] font-semibold",
              gap ? "text-danger" : "text-success",
            )}
          >
            {money(gap)}
          </span>
        </span>
        <span className="flex max-w-[260px] flex-1 items-center gap-2.5">
          <Progress value={percent} className="flex-1" />
          <span className="text-[13px] font-medium text-ink">{percent}%</span>
        </span>
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {defaults} customer{defaults === 1 ? "" : "s"} on an auto-applied default
        </span>
      </Card>

      <MetricStrip
        metrics={[
          { label: "Customers", value: String(total) },
          { label: "On or above target", value: String(total - behind), tone: "success" },
          { label: "Behind", value: String(behind), tone: behind ? "danger" : "ink" },
          {
            label: "Biggest single gap",
            value: behind ? moneyShort(totals.maxGap) : "-",
          },
        ]}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-4"
        tabs={[
          { key: "targets", label: "Targets", count: total },
          { key: "shortfall", label: "Where the shortfall is", count: behind },
        ]}
      />

      {tab === "shortfall" ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(420px,1fr))] items-start gap-4">
          {groups.map((g) => (
            <Card key={g.title}>
              <div
                className="border-b border-divider border-l-[3px] px-5 py-4"
                style={{ borderLeftColor: g.accent }}
              >
                <div className="text-lg font-semibold text-ink">{g.title}</div>
                <div className="mt-1 text-[13px] text-muted">{g.blurb}</div>
                <div className="mt-3 flex gap-6">
                  <span>
                    <SectionLabel>Customers</SectionLabel>
                    <span className="text-[22px] font-semibold text-ink">
                      {g.rows.length}
                    </span>
                  </span>
                  <span>
                    <SectionLabel>Value shortfall</SectionLabel>
                    <span className="text-[22px] font-semibold text-danger">
                      {money(g.value)}
                    </span>
                  </span>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <Th>Customer</Th>
                    <Th align="right">Shortfall</Th>
                    <Th align="right">Contacts</Th>
                    <Th align="right">Cycle</Th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.slice(0, 12).map((r) => (
                    <Tr key={r.customerId} className="hover:bg-canvas">
                      <Td className="font-medium text-ink">
                        <Link
                          href={customerHref(r.customerId)}
                          className="no-underline"
                        >
                          {r.name}
                        </Link>
                      </Td>
                      <Td align="right" className="font-medium text-danger">
                        {money(r.gap)}
                      </Td>
                      <Td align="right">
                        {r.contactsThisMonth} of {r.expectedContacts}
                      </Td>
                      <Td align="right">{r.cycleDays} days</Td>
                    </Tr>
                  ))}
                  {!g.rows.length ? (
                    <Tr>
                      <Td colSpan={4} className="py-8 text-center text-muted">
                        Nobody in this group.
                      </Td>
                    </Tr>
                  ) : null}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      ) : (
        <>
          <Card className="mb-0 flex flex-wrap items-center gap-2.5 rounded-b-none border-b-0 px-4 py-3">
            <div className="relative w-[260px]">
              <Icon
                name="search"
                size={16}
                className="pointer-events-none absolute top-2 left-2.5 text-muted"
              />
              <input
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  // Typing settles before the server is asked. A round trip
                  // per keystroke would make the box feel broken on a 4G
                  // handset.
                  clearTimeout(searchTimer.current);
                  searchTimer.current = setTimeout(
                    () => navigate({ q: e.target.value }),
                    300,
                  );
                }}
                placeholder="Search customer name"
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
            {chips.length ? (
              <Button variant="ghost" size="sm" onClick={clearAll}>
                Clear filters
              </Button>
            ) : null}
          </Card>
          {chips.length ? (
            <div className="flex flex-wrap items-center gap-1.5 border-r border-b border-l border-line bg-surface px-4 py-2.5">
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
            </div>
          ) : null}
          <Card className={cx("overflow-auto", chips.length ? "rounded-t-none" : "mt-0 rounded-t-none border-t-0")}>
            {rows.length ? (
          <table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th align="right">Target</Th>
                <Th align="right">Achieved</Th>
                <Th align="right">Gap</Th>
                <Th>Achievement</Th>
                <Th>Account manager</Th>
                <Th align="right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.customerId} className="hover:bg-canvas">
                  <Td className="font-medium text-ink">
                    <Link
                      href={customerHref(r.customerId)}
                      className="no-underline"
                    >
                      {r.customerName}
                    </Link>
                    {r.isDefault ? (
                      <span className="ml-2">
                        <Badge tone="muted">Default</Badge>
                      </span>
                    ) : r.carriedForward ? (
                      <span className="ml-2">
                        <Badge tone="brand" title="Set by hand last month, continuing unchanged">
                          Carried forward
                        </Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td align="right">{money(r.target)}</Td>
                  <Td align="right">{money(r.achieved)}</Td>
                  <Td align="right" className={r.gap ? "text-danger" : "text-success"}>
                    {money(r.gap)}
                  </Td>
                  <Td>
                    <span className="flex min-w-[160px] items-center gap-2.5">
                      <Progress
                        value={r.percent}
                        tone={r.percent >= 100 ? "success" : r.percent >= 60 ? "brand" : "danger"}
                        className="flex-1"
                      />
                      <span className="w-9 text-right text-[13px] text-body">
                        {r.percent}%
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
                      <span className="text-muted">-</span>
                    )}
                  </Td>
                  <Td align="right">
                    <span className="flex justify-end">
                      <RowMenu
                        items={[
                          {
                            label: "Set target",
                            onSelect: () => setEditing(r),
                            disabled: !canSet,
                            title: canSet ? undefined : "Manager or accounts action",
                          },
                          {
                            label: app === "crm" ? "Open customer record" : "Open customer account",
                            onSelect: () => router.push(customerHref(r.customerId)),
                          },
                          ...(app === "crm"
                            ? [
                                {
                                  label: "See their bills",
                                  onSelect: () => router.push(`/crm/bills?customer=${r.customerId}`),
                                },
                              ]
                            : []),
                        ]}
                      />
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
            ) : (
              <EmptyState
                title="No customers match these filters"
                body="Widen the search or clear the filters to see the full list."
                action={
                  <Button variant="primary" onClick={clearAll}>
                    Clear filters
                  </Button>
                }
              />
            )}
          </Card>

          {total ? (
            <div className="flex flex-wrap items-center gap-3 border-r border-b border-l border-line bg-surface px-4 py-3">
              <span className="text-[13px] text-muted">
                {from + 1}&ndash;{Math.min(from + perPage, total)} of{" "}
                {total.toLocaleString("en-IN")}
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
        </>
      )}

      <SetTargetModal
        row={editing}
        period={period}
        onClose={() => setEditing(null)}
        onSubmit={async (amount) => {
          if (!editing) return;
          const result = await run(setTarget(editing.customerId, amount, period));
          if (result.ok) {
            setEditing(null);
            router.refresh();
          }
        }}
      />

      <BulkTargetModal
        open={bulkOpen}
        count={total}
        hasFilters={Boolean(
          filters.query || filters.status || filters.salesAm || filters.salesManager || filters.backOfficeAm,
        )}
        onClose={() => setBulkOpen(false)}
        onSubmit={async (mode, value, onlyDefaults) => {
          const result = await run(
            setTargetsBulk({
              filters: {
                query: filters.query || undefined,
                status: filters.status || undefined,
                salesAm: filters.salesAm || undefined,
                salesManager: filters.salesManager || undefined,
                backOfficeAm: filters.backOfficeAm || undefined,
              },
              onlyDefault: onlyDefaults,
              mode,
              value,
              period,
            }),
          );
          if (result.ok) {
            setBulkOpen(false);
            router.refresh();
          }
        }}
      />
    </div>
  );
}

function recentPeriods(): string[] {
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

  const out: string[] = [];
  let year = Number(now.year);
  let month = Number(now.month);
  for (let i = 0; i < 6; i++) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

type SetTargetProps = {
  row: Row | null;
  period: string;
  onClose: () => void;
  onSubmit: (amount: string) => Promise<void>;
};

function SetTargetModal(props: SetTargetProps) {
  if (!props.row) return null;
  return <SetTargetModalBody key={props.row.customerId} {...props} />;
}

function SetTargetModalBody({ row, period, onClose, onSubmit }: SetTargetProps) {
  const [amount, setAmount] = React.useState(
    String(Math.round((row?.target ?? 0) / 100)),
  );
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={Boolean(row)}
      onClose={onClose}
      title={`Set target · ${row?.customerName ?? ""}`}
      width={440}
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
                await onSubmit(amount);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save target
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">
        {periodLabel(period)} · achieved so far {money(row?.achieved ?? 0)}
      </div>
      <Field
        label="Monthly target"
        hint={
          row?.isDefault
            ? "This customer is currently on the auto-applied default. Saving replaces it with a real number."
            : row?.carriedForward
              ? "Carried forward from last month, unchanged. Saving fixes this month's own number."
              : undefined
        }
      >
        <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
    </Modal>
  );
}

function BulkTargetModal({
  open,
  count,
  hasFilters,
  onClose,
  onSubmit,
}: {
  open: boolean;
  /** How many customers the current filters match — what this actually touches. */
  count: number;
  hasFilters: boolean;
  onClose: () => void;
  onSubmit: (
    mode: "amount" | "uplift",
    value: string,
    onlyDefaults: boolean,
  ) => Promise<void>;
}) {
  const [mode, setMode] = React.useState<"amount" | "uplift">("uplift");
  const [value, setValue] = React.useState("10");
  const [onlyDefaults, setOnlyDefaults] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set targets in bulk"
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
                await onSubmit(mode, value, onlyDefaults);
              } finally {
                setBusy(false);
              }
            }}
          >
            Apply targets
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="How to set them">
          <Select
            value={mode}
            onChange={(e) => {
              const next = e.target.value as "amount" | "uplift";
              setMode(next);
              setValue(next === "uplift" ? "10" : "100000");
            }}
          >
            <option value="uplift">Uplift on each customer&apos;s own run rate</option>
            <option value="amount">The same flat amount for everyone</option>
          </Select>
        </Field>

        {mode === "uplift" ? (
          <Field
            label="Uplift %"
            hint="Applied to the customer's average order spread over a month - so a big account gets a big target."
          >
            <Input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-[140px]"
            />
          </Field>
        ) : (
          <Field label="Target for each customer">
            <MoneyInput value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}

        <label className="flex cursor-pointer items-center gap-2 text-sm text-body">
          <input
            type="checkbox"
            checked={onlyDefaults}
            onChange={(e) => setOnlyDefaults(e.target.checked)}
            className="h-[15px] w-[15px] accent-[#6835FB]"
          />
          Only customers still on the auto-applied default
        </label>

        <div className="rounded-[4px] border border-warn-line bg-warn-soft px-2.5 py-2 text-[13px] text-warn-ink">
          This overwrites existing targets for {hasFilters ? "the customers your filters match" : "the customers it touches"}
          {onlyDefaults
            ? " - with the box ticked, only the untouched defaults change."
            : `, all ${count.toLocaleString("en-IN")} of them${hasFilters ? " (matching your current filters)" : ""}.`}
        </div>
      </div>
    </Modal>
  );
}
