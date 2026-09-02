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
  PageHeader,
  Select,
  SlowPayerBadge,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import {
  ConfirmDialog,
  Modal,
  RowMenu,
  SelectionBar,
} from "@/components/ui/overlays";
import { MultiSelect } from "@/components/ui/multi-select";
import { useToast } from "@/components/ui/toast";
import { AccountManagerDialog } from "@/components/crm/account-manager-dialog";
import { SalesManagerDialog } from "@/components/crm/sales-manager-dialog";
import { updateAccountManagers } from "@/lib/actions/account-manager";
import { assignSalesManager } from "@/lib/actions/sales-manager";
import { VoiceTextarea } from "@/components/ui/dictate";
import { Icon } from "@/components/shell/icons";
import { pinnedCell, pinnedHead } from "@/components/ui/pinned";
import {
  createCustomer,
  createRemindersBulk,
  decideDeactivation,
  decideReactivation,
  requestDeactivation,
  requestReactivation,
  updateCustomer,
} from "@/lib/actions/crm";
import { convertToThirdParty, revertThirdParty } from "@/lib/actions/third-party";
import { ThirdPartyDialog } from "@/components/crm/third-party-dialog";
import { money, phoneDisplay, shortDate, stamp, today } from "@/lib/format";
import {
  NextCallCell,
  type StoredNextStep,
} from "@/components/crm/next-call-cell";
import { NEXT_STEP_LABELS } from "@/lib/next-step-labels";
import { toCsv, downloadCsv } from "@/lib/csv";
import {
  ACCOUNT_TYPE_FILTERS,
  ACCOUNT_TYPE_PARAM,
  accountTypeLabel,
} from "@/lib/account-types";

export type Row = {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string;
  city: string;
  ownerId: string | null;
  /**
   * Whose book it is, for a CUSTOMER. Not the same column as the owner, and
   * on this book never the same person: the import made one account the owner
   * of all 1075 records, while the sales AM is who actually holds each one.
   */
  salesAmId: string | null;
  /**
   * The mark that a person decided the sales seat, rather than the sheet
   * still owning it. `openingSalesValue` reads it for the same reason
   * `ASSIGNED_TO_SQL` and `SALES_AM_NAME_SQL` do — the fallback to the owner
   * is for a seat nobody has set, not for one somebody has deliberately
   * emptied, and every place that reads this seat has to draw that line the
   * same way or an unassign looks like it silently reverted itself.
   */
  amDecidedAt: Date | null;
  ownerName: string | null;
  kind: "lead" | "customer";
  leadSource: string | null;
  salesAmName: string | null;
  /**
   * Who the salesperson answers to. A third seat, and it drives nothing — no
   * queue, no scope, no target — which is why a manager may set it while the
   * two beside it stay accounts' and admin's.
   */
  salesManagerName: string | null;
  backOfficeAmId: string | null;
  backOfficeAmName: string | null;
  status: string;
  lastOrderDate: string | null;
  lastContactAt: string | null;
  outstanding: number;
  slowPayer: boolean;
  openComplaints: number;
  gstin: string | null;
  creditTermDays: number;
  cycleDays: number;
  route: string | null;
  deactivationRequested: boolean;
  /** A shop we deliver to, served through a distributor. Never prospected. */
  thirdParty: boolean;
  /** Orders whose goods came here on somebody else's bill — the evidence. */
  deliveredOrders: number;
  /** Third-party customers billed through this account. */
  servedShops: number;
  reactivationRequested: boolean;
  reactivationReason: string | null;
  /** The next call, as of the last call logged. Null where nobody has called. */
  nextStep: StoredNextStep | null;
};

/**
 * How many rows at a time. Twenty-five by default: the book is over a thousand
 * now, and a telecaller opening this screen wants the first screenful. The
 * count, the totals and the filters all still describe the whole book.
 */
const PER_PAGE = [25, 50, 100] as const;

/*
 * The account type, its filter and its label — all from `lib/account-types`,
 * which is the one statement of them.
 *
 * `?party=` now carries the CODES `lib/account-types` defines (`yes`, `lead`,
 * …) rather than the control's own words — the multi-select below is built
 * `{ value, label }` pairs directly, so there is no longer a round trip
 * through a phrase the URL has to be turned back into. `accountTypeParam`
 * still validates what it is handed, and `TYPE_FILTERS`/`TYPE_PARAM` are what
 * turn those codes into the words a person reads.
 */
const TYPE_FILTERS = ACCOUNT_TYPE_FILTERS;
const TYPE_PARAM = ACCOUNT_TYPE_PARAM;
const accountType = accountTypeLabel;

const STATUSES = [
  "All statuses",
  "Active",
  "Slow payer",
  "Inactive",
  "New",
  "Deactivated",
];

export function CustomersScreen({
  app,
  scopeLabel,
  isManager,
  canClassify,
  canReassign,
  canAssignSalesManager,
  amReasons,
  amSearchThreshold,
  amOptions,
  team,
  backOfficePeople,
  salesManagerPeople,
  rows,
  filters,
  pageInfo,
  totals,
  todayIso,
}: {
  /**
   * Which app is rendering this.
   *
   * ONE customer list, two apps. They were briefly two screens, and the thin
   * one grew a different search box, a different set of columns and a
   * different idea of what a customer row shows — which is the beginning of
   * two answers to "who are our customers". They read the same query already;
   * they now render the same component, and this prop names the handful of
   * things that genuinely differ: where a row links to, and which actions the
   * app can actually carry out.
   *
   * Accounts users hold `apps: ["accounts"]`, so every `/crm/...` link is a
   * door they are redirected away from. That is what this switches — not
   * decoration.
   */
  app: "crm" | "accounts";
  scopeLabel: string;
  isManager: boolean;
  /** `customer.classify` — marking an account as one we only deliver to. */
  canClassify: boolean;
  /**
   * Reassigning is accounts' and admin's, not a manager's — whose book an
   * account is in decides whose targets it counts toward. Passed in rather
   * than derived here, because the same check runs in the action and a screen
   * that guessed would disagree with it.
   */
  canReassign: boolean;
  /**
   * Setting the sales manager, which is a MANAGER's and not accounts'.
   *
   * A separate question to `canReassign` and deliberately a more generous one:
   * that seat decides whose targets an account counts toward, this one decides
   * who reviews the book. Asked of the same function the action asks, so a
   * visible button and a permitted action cannot disagree.
   */
  canAssignSalesManager: boolean;
  amReasons: string[];
  amSearchThreshold: number;
  /** The names each filter offers — the ones the column actually shows. */
  amOptions: { sales: string[]; salesManager: string[]; backOffice: string[] };
  team: Array<{ id: string; name: string; role?: string }>;
  /** Accounts plus the current HRMS employees — the back office seat only. */
  backOfficePeople: Array<{ id: string; name: string; role?: string }>;
  /**
   * The same list again for the sales manager seat, which needs no login
   * either — several of the people running a sales line here have never signed
   * in. Passed separately rather than reusing the back office prop so that the
   * day one of the two lists narrows, only one of them narrows.
   */
  salesManagerPeople: Array<{ id: string; name: string; role?: string }>;
  rows: Row[];
  filters: {
    query: string;
    status: string;
    salesAm: string;
    salesManager: string;
    backOfficeAm: string;
    /** The type filter's own word, or empty for all of them. */
    accountType: string;
    perPage: number;
  };
  pageInfo: { page: number; pageCount: number; total: number; bookTotal: number };
  /**
   * The working day, from the server. Named apart from `today()` in
   * lib/format, which reads the clock — a client component may not do that
   * during render, and the value has to be the SERVER's day anyway: a
   * telecaller's laptop set to the wrong date must not change which next-call
   * dates read as past.
   */
  todayIso: string;
  totals: {
    outstanding: number;
    slowPayers: number;
    withComplaints: number;
    directCustomers: number;
    leads: number;
    thirdParties: number;
  };
}) {
  const router = useRouter();

  /*
   * Everything that differs between the two apps, named once.
   *
   * The rule is not "hide what accounts should not see" — it is that an
   * accounts user is redirected out of `/crm/...` before the page renders, so
   * a row action pointing there is a dead end rather than a restriction. Where
   * Accounts has its own answer to the same question it is used: the customer
   * account statement IS the accounts-side record of a customer.
   */
  const isCrm = app === "crm";
  // The filter URLs need no base path — `navigate()` pushes a relative query
  // string, so the address it builds is already whichever list is open.
  const recordHref = (id: string) =>
    isCrm ? `/crm/customers/${id}` : `/accounts/ledger?customer=${id}`;
  const { run, push } = useToast();

  const search = useSearchParams();

  // What is on screen is what the address says. These used to be component
  // state, which was fine while the browser held the whole book; the server
  // does the filtering now, so it has to be told — and a filtered list gains a
  // shareable link and a working back button for free.
  //
  // `,`-separated, empty meaning no filter — the multi-select's own wire
  // format, and the one `customerFilterClause` reads on the way back down.
  // There is no more "All statuses" sentinel value living in the URL: an
  // empty string already means the same thing, so nothing has to compare
  // against a magic word to find out whether a filter is active.
  const status = filters.status || "";
  const salesAm = filters.salesAm || "";
  const salesManager = filters.salesManager || "";
  const backOfficeAm = filters.backOfficeAm || "";
  const accountTypeFilter = filters.accountType || "";
  const perPage = filters.perPage;
  const { page, pageCount, total, bookTotal } = pageInfo;
  const query = filters.query;

  const asList = (v: string) => (v ? v.split(",").filter(Boolean) : []);
  const statusOptions: { value: string; label: string }[] = STATUSES.slice(1).map(
    (s) => ({ value: s, label: s }),
  );
  const salesAmOptions = amOptions.sales.map((n) => ({ value: n, label: n }));
  const salesManagerOptions = amOptions.salesManager.map((n) => ({ value: n, label: n }));
  const backOfficeOptions = amOptions.backOffice.map((n) => ({ value: n, label: n }));
  const accountTypeOptions = TYPE_FILTERS.slice(1).map((word) => ({
    value: TYPE_PARAM[word] ?? "",
    label: word,
  }));

  // The search box is the one control that cannot afford a round trip per
  // keystroke, so it holds its own text and navigates when typing settles.
  const [draft, setDraft] = React.useState(filters.query);
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

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

  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Row | null>(null);
  const [bulkRemind, setBulkRemind] = React.useState(false);
  const [changingAm, setChangingAm] = React.useState(false);
  /*
   * Which SCOPE the sales manager dialog was opened with. `null` is closed —
   * one piece of state rather than a boolean plus a mode, because a dialog
   * that is open with no scope is a state the screen must not be able to
   * express.
   */
  const [smScope, setSmScope] = React.useState<"selection" | "filters" | null>(
    null,
  );
  const [deactivating, setDeactivating] = React.useState(false);
  const [reactivating, setReactivating] = React.useState(false);
  /** The rows the convert dialog is open over — one from a menu, many from the bar. */
  const [converting, setConverting] = React.useState<Row[] | null>(null);

  // Already filtered, counted and sliced by Postgres. `rows` is this page.
  const visible = rows;
  /*
   * Which way the bulk button points. Every selected row has to be
   * deactivated for it to offer the way back — a mixed selection means the
   * person has not decided what they are doing, and quietly acting on the
   * subset that happens to match is how a bulk action surprises somebody.
   */
  const selectedAllDeactivated =
    selected.size > 0 &&
    visible
      .filter((r) => selected.has(r.id))
      .every((r) => r.status === "Deactivated");
  const selectedRows = visible.filter((r) => selected.has(r.id));
  /*
   * The same all-or-nothing rule the deactivation button follows, and here it
   * carries the classification rule with it: only a lead becomes a third-party
   * customer, so a selection holding one direct customer offers nothing. Acting
   * on the subset that happens to qualify is how a bulk action surprises
   * somebody, and this one takes accounts off the calling list.
   */
  const selectedAllConvertible =
    selectedRows.length > 0 &&
    selectedRows.every((r) => r.kind === "lead" && !r.thirdParty);
  const selectedAllThirdParty =
    selectedRows.length > 0 && selectedRows.every((r) => r.thirdParty);
  const from = (page - 1) * perPage;

  // A comma-joined value said in words — one chip per FILTER, not one per
  // value picked, so ticking three statuses reads as one chip naming three
  // things rather than three chips saying the same word "Status" three times.
  const describeMulti = (raw: string, options: { value: string; label: string }[]) => {
    const vals = asList(raw);
    if (!vals.length) return "";
    const byValue = new Map(options.map((o) => [o.value, o.label]));
    return vals.map((v) => byValue.get(v) ?? v).join(", ");
  };

  const chips = [
    status
      ? {
          label: `Status: ${describeMulti(status, statusOptions)}`,
          clear: () => navigate({ status: undefined }),
        }
      : null,
    salesAm
      ? {
          label: `Sales: ${describeMulti(salesAm, salesAmOptions)}`,
          clear: () => navigate({ sales: undefined }),
        }
      : null,
    salesManager
      ? {
          label: `Sales manager: ${describeMulti(salesManager, salesManagerOptions)}`,
          clear: () => navigate({ salesmanager: undefined }),
        }
      : null,
    backOfficeAm
      ? {
          label: `Back office: ${describeMulti(backOfficeAm, backOfficeOptions)}`,
          clear: () => navigate({ backoffice: undefined }),
        }
      : null,
    accountTypeFilter
      ? {
          label: `Type: ${describeMulti(accountTypeFilter, accountTypeOptions)}`,
          clear: () => navigate({ party: undefined }),
        }
      : null,
    query ? { label: `Search: ${query}`, clear: () => { setDraft(""); navigate({ q: undefined }); } } : null,
  ].filter(Boolean) as Array<{ label: string; clear: () => void }>;

  function clearAll() {
    setDraft("");
    // Every filter, and `party` is a filter. Left out of this list it survived
    // the button that exists to remove it: the list stayed empty, the control
    // still said "Third-party customers", and Clear filters read as broken than
    // as incomplete. A filter added anywhere has to be added in four places —
    // the control, the chip, this, and the export's list of what it was taken
    // under — and three of them are invisible until somebody presses one.
    navigate({
      q: undefined,
      status: undefined,
      sales: undefined,
      salesmanager: undefined,
      backoffice: undefined,
      party: undefined,
    });
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportCsv(subset: Row[]) {
    if (!isManager) {
      push("Export is a manager action.", "error");
      return;
    }
    downloadCsv(
      "mahek-customers",
      toCsv(
        [
          "Customer",
          "Contact",
          "Phone",
          "City",
          "Type",
          "Deliveries received on another's bill",
          "Third-party customers billed for",
          "Owner",
          "Sales AM",
          "Sales manager",
          "Back office AM",
          "Lead source",
          "Status",
          "Last order",
          "Outstanding (₹)",
          "Next call",
          "Next call said on",
        ],
        subset.map((r) => [
          r.name,
          r.contactPerson,
          r.phone,
          r.city,
          accountType(r),
          r.deliveredOrders,
          r.servedShops,
          r.ownerName ?? "",
          r.salesAmName ?? "",
          r.salesManagerName ?? "",
          r.backOfficeAmName ?? "",
          r.leadSource ?? "",
          r.status,
          r.lastOrderDate ?? "",
          Math.round(r.outstanding / 100),
          // The word where there is no date, so a CSV row can never imply a
          // call is coming when the answer was "nobody can reach them".
          r.nextStep
            ? (r.nextStep.date ?? NEXT_STEP_LABELS[r.nextStep.kind].short)
            : "",
          r.nextStep?.toldOn ?? "",
        ]),
      ),
      [
        status ? `Status: ${describeMulti(status, statusOptions)}` : null,
        // The export names the filters it was taken under, so a file sent to
        // somebody says what it is a list of.
        salesAm ? `Sales: ${describeMulti(salesAm, salesAmOptions)}` : null,
        salesManager
          ? `Sales manager: ${describeMulti(salesManager, salesManagerOptions)}`
          : null,
        backOfficeAm
          ? `Back office: ${describeMulti(backOfficeAm, backOfficeOptions)}`
          : null,
        accountTypeFilter
          ? `Type: ${describeMulti(accountTypeFilter, accountTypeOptions)}`
          : null,
        query || null,
      ],
    );
    push(`Exported ${subset.length} rows`);
  }

  // Summed by Postgres over everything the filters match, not by the browser
  // over the page it happens to be holding.
  const totalOutstanding = totals.outstanding;
  const slow = totals.slowPayers;
  const withComplaints = totals.withComplaints;

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Customers"
        subtitle={`${scopeLabel} · Every account in the book, with the figures a telecaller needs mid-call.`}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={!isManager}
              title={
                isManager ? "Download as CSV" : "Export is a manager action"
              }
              onClick={() => exportCsv(visible)}
            >
              Export
            </Button>
            {isManager && isCrm ? (
              <Link
                href="/crm/customers/import"
                className="inline-flex h-9 items-center rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
              >
                Import CSV
              </Link>
            ) : null}
            {/*
              The whole-book move, and it lives in the header rather than the
              selection bar because it acts on the FILTERS and not on a
              selection — the day somebody leaves, the set that has to move is
              a hundred and forty-seven accounts spread over six pages, and
              ticking them is not a thing anybody is going to do. Filter the
              list to their name, press this, and the accounts that move are
              the accounts on the screen.

              Shown to everybody and refused with a reason, like every other
              control here: a button that is absent says the app cannot do
              this, and a button that is disabled says who can.
            */}
            <Button
              variant="secondary"
              disabled={!canAssignSalesManager}
              title={
                canAssignSalesManager
                  ? "Set the sales manager on every account these filters match"
                  : "Setting the sales manager is a manager or admin action"
              }
              onClick={() => setSmScope("filters")}
            >
              Transfer sales manager
            </Button>
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              Add lead
            </Button>
          </>
        }
      />

      <MetricStrip
        metrics={[
          {
            label: "Customers",
            value: String(total),
            sub: `of ${bookTotal.toLocaleString("en-IN")} in the book`,
          },
          /*
           * The split, which is the answer to "what is in this book" and was
           * previously unknowable without running SQL. It is also the progress
           * bar for the marking work: third parties climbs as the team works
           * through them, and leads falls by the same amount.
           */
          {
            label: "Direct customers",
            value: String(totals.directCustomers),
            sub: "bill with us",
          },
          {
            label: "Leads",
            value: String(totals.leads),
            sub: "not ordered yet",
          },
          {
            label: "Third-party customers",
            value: String(totals.thirdParties),
            sub: "we deliver, a distributor bills",
          },
          {
            label: "Outstanding",
            value: money(totalOutstanding),
            tone: totalOutstanding > 0 ? "danger" : "ink",
          },
          {
            label: "Slow payers",
            value: String(slow),
            tone: slow ? "danger" : "ink",
          },
          { label: "With open complaints", value: String(withComplaints) },
          {
            label: "Average outstanding",
            value: money(
              total
                ? Math.round(totalOutstanding / total)
                : 0,
            ),
          },
        ]}
      />

      <Card className="mb-0 flex items-center gap-2.5 rounded-b-none border-b-0 px-4 py-3">
        <div className="relative w-[300px]">
          <Icon
            name="search"
            size={16}
            className="pointer-events-none absolute top-2 left-2.5 text-muted"
          />
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              // Typing settles before the server is asked. A round trip per
              // keystroke would make the box feel broken on a 4G handset.
              clearTimeout(searchTimer.current);
              searchTimer.current = setTimeout(
                () => navigate({ q: e.target.value }),
                300,
              );
            }}
            placeholder="Search name, contact, phone, city"
            className="h-8 w-full rounded-[4px] border border-line pr-7 pl-7.5 text-sm outline-none focus:border-brand"
          />
          {query ? (
            <button
              onClick={() => { setDraft(""); navigate({ q: undefined }); }}
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
          options={statusOptions}
          selected={asList(status)}
          onChange={(next) => navigate({ status: next.join(",") || undefined })}
        />
        <MultiSelect
          label="Type"
          placeholder="All types"
          options={accountTypeOptions}
          selected={asList(accountTypeFilter)}
          onChange={(next) => navigate({ party: next.join(",") || undefined })}
          title="A direct customer bills with us. A third-party customer is a shop we deliver to and a distributor bills."
        />
        {/*
          Two filters, because an account has two managers and "owner" was
          neither of them. The old one tested `owner_id`'s name while the
          column showed the sales manager — different people on most rows, so
          picking a name filtered a column nobody could see and the list came
          back looking wrong or empty.

          The options are the names the COLUMN shows, not the staff list. Most
          of these people have no MahekOne account — the customer master names
          "Back Office Calling", "Marathwada", "Company Own" — and a dropdown
          built from `users` cannot reach a single one of those rows.
        */}
        <MultiSelect
          label="Sales AM"
          placeholder="All sales people"
          options={salesAmOptions}
          selected={asList(salesAm)}
          onChange={(next) => navigate({ sales: next.join(",") || undefined })}
        />
        {/*
          The sales MANAGER, which is the filter a regional review starts from
          and the filter a handover starts from. Built from the same expression
          the column shows, like the two beside it — a dropdown built from
          `users` could not offer the people running a line who have never
          signed in, and this seat is full of them.
        */}
        <MultiSelect
          label="Sales manager"
          placeholder="All sales managers"
          options={salesManagerOptions}
          selected={asList(salesManager)}
          onChange={(next) => navigate({ salesmanager: next.join(",") || undefined })}
        />
        <MultiSelect
          label="Back office"
          placeholder="All back office"
          options={backOfficeOptions}
          selected={asList(backOfficeAm)}
          onChange={(next) => navigate({ backoffice: next.join(",") || undefined })}
        />
        {chips.length ? (
          <button
            onClick={clearAll}
            className="h-8 cursor-pointer px-2.5 text-sm text-brand"
          >
            Clear all
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {total.toLocaleString("en-IN")} of {bookTotal.toLocaleString("en-IN")}
        </span>
      </Card>

      {chips.length ? (
        <div className="flex flex-wrap gap-2 border-r border-l border-line bg-surface px-4 pb-3">
          {chips.map((c) => (
            <button
              key={c.label}
              onClick={c.clear}
              className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-[4px] border border-line bg-canvas px-2 text-[13px] text-body"
            >
              {c.label} <span className="text-muted">×</span>
            </button>
          ))}
        </div>
      ) : null}

      <Card className="overflow-auto rounded-t-none">
        {total ? (
          <table>
            <thead>
              <tr>
                <Th className="w-9">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    className="accent-[#6835FB]"
                    checked={
                      total > 0 && selected.size === total
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? new Set(visible.map((r) => r.id))
                          : new Set(),
                      )
                    }
                  />
                </Th>
                <Th>Customer</Th>
                <Th>Contact person</Th>
                <Th>Phone</Th>
                <Th>Type</Th>
                <Th>Account managers</Th>
                <Th>Status</Th>
                <Th>Last order</Th>
                <Th>Last contact</Th>
                <Th align="right">Outstanding</Th>
                {/* WHEN THEY COME BACK, from the last call anybody logged.
                    Empty on a customer nobody has called, which is the honest
                    answer: nothing has been promised because nobody has
                    spoken to them. */}
                <Th>Next call</Th>
                <Th>City</Th>
                <Th align="right" className={pinnedHead("right")}>
                  Actions
                </Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <Tr key={r.id} className="hover:bg-canvas">
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.name}`}
                      className="accent-[#6835FB]"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                    />
                  </Td>
                  <Td className="font-medium text-ink">
                    <Link
                      href={recordHref(r.id)}
                      // Every row on the page is visible at once, so the
                      // default prefetch renders every customer's page on
                      // the one shared vCPU this app runs on.
                      prefetch={false}
                      className="no-underline hover:underline"
                    >
                      {r.name}
                    </Link>
                    {r.slowPayer ? (
                      <span className="ml-2">
                        <SlowPayerBadge />
                      </span>
                    ) : null}
                    {r.deactivationRequested ? (
                      <span className="ml-2">
                        <Badge tone="warn">Deactivation asked</Badge>
                      </span>
                    ) : null}
                    {/* A customer waiting to come back is worth flagging on
                        the row: they are off every list until somebody says
                        yes, so nothing else would surface them. */}
                    {r.reactivationRequested ? (
                      <span className="ml-2">
                        <Badge tone="brand">Reactivation asked</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td>{r.contactPerson}</Td>
                  <Td>{phoneDisplay(r.phone)}</Td>
                  <Td>
                    <Badge
                      tone={
                        r.thirdParty ? "muted" : r.kind === "lead" ? "brand" : "neutral"
                      }
                      title={
                        r.thirdParty
                          ? `We deliver here; a distributor bills. Underneath, this record is still a ${r.kind}.`
                          : undefined
                      }
                    >
                      {accountType(r)}
                    </Badge>
                    {/* The evidence, beside the answer it justifies rather than
                        in another column: a name is a guess, "14 deliveries" is
                        a fact. Shown whether or not anybody has marked it. */}
                    {r.deliveredOrders > 0 ? (
                      <span
                        className="ml-1.5 text-xs text-muted"
                        title={`Goods came here on somebody else's bill ${r.deliveredOrders} time${r.deliveredOrders === 1 ? "" : "s"}`}
                      >
                        {r.deliveredOrders}&nbsp;deliv.
                      </span>
                    ) : null}
                    {/* The other end of the same relationship. On a
                        distributor's row this is what explains why goods leave
                        on their bill and arrive somewhere else. */}
                    {r.servedShops > 0 ? (
                      <span
                        className="ml-1.5 text-xs text-muted"
                        title={`Bills for ${r.servedShops} third-party customer${r.servedShops === 1 ? "" : "s"}`}
                      >
                        serves&nbsp;{r.servedShops}
                      </span>
                    ) : null}
                  </Td>
                  {/*
                    Two lines, because a customer answers to two people and a
                    lead to one. Flattening them into a single name would hide
                    whichever one you did not pick.

                    The top line is the NAME on its own, with no "Sales:" in
                    front of it. Labelling it was tried and reverted: the
                    column is narrow, seven extra characters pushed every name
                    onto a second line, and a list whose rows are all twice as
                    tall is harder to scan than one whose header you read once.
                    The header says what the column is; the second line is
                    labelled because it has to distinguish itself from the
                    first.
                  */}
                  {/*
                    NOWRAP on both lines, and it is the whole fix.

                    The labels are worth their width — a bare name under a
                    header listing three roles makes the reader work out which
                    one it is, and the answer changes row by row. What was
                    wrong was never the labels; it was that the column had no
                    floor, so "Sales: Prakash Vasudev Prasad" folded onto a
                    second line and every row grew to twice the height.

                    A table cell wraps by default and the column then shrinks
                    to whatever is left over. This one holds its line instead
                    and the table scrolls, which it is already set up to do —
                    the Card around it carries `overflow-auto`. Scrolling a
                    wide table sideways is a thing people do without thinking;
                    reading a name broken across two lines is not.
                  */}
                  <Td className="whitespace-nowrap">
                    {/*
                      THREE LINES AT ONE SIZE, and the size is the fix.

                      The second line used to be `text-xs` while the first was
                      `text-sm`, which made the back office manager read as a
                      footnote to the salesperson rather than as the other half
                      of the same answer. They are peers: one sells to the
                      account, one raises its paperwork, and now a third says
                      who the first answers to. A hierarchy of type sizes down
                      a column claims a hierarchy of importance that does not
                      exist, and at that size the smaller line was simply
                      harder to read on the screens this is used on.

                      What separates the lines instead is COLOUR on the label
                      and weight on nothing — the label is muted, the name is
                      not, and the eye picks out the three names down the
                      column without reading a word of the labels.
                    */}
                    <span className="block text-sm text-body">
                      <span className="text-muted">
                        {r.kind === "lead" ? "Lead owner: " : "Sales: "}
                      </span>
                      {/*
                        NO fallback to `ownerName` for a customer.
                        `SALES_AM_NAME_SQL` already carries that fallback for
                        an account nobody has decided about; redoing it here
                        would override the case it deliberately excludes — an
                        account somebody has decided has no salesperson, where
                        null means unassigned rather than "ask the importer".
                      */}
                      {r.kind === "lead"
                        ? (r.ownerName ?? "Unassigned")
                        : (r.salesAmName ?? "Unassigned")}
                    </span>
                    {/* A lead has no sales manager and no back office manager:
                        nobody runs a line over an account that has not ordered
                        and nobody raises paperwork for one. It carries where it
                        came from instead, on the one line it has room for. */}
                    {r.kind === "lead" ? null : (
                      <span className="block text-sm text-body">
                        <span className="text-muted">Sales manager: </span>
                        {r.salesManagerName ?? "Unassigned"}
                      </span>
                    )}
                    <span className="block text-sm text-body">
                      <span className="text-muted">
                        {r.kind === "lead" ? "Source: " : "Back office: "}
                      </span>
                      {r.kind === "lead"
                        ? (r.leadSource ?? "not recorded")
                        : (r.backOfficeAmName ?? "Unassigned")}
                    </span>
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        r.status === "Slow payer"
                          ? "warn"
                          : // Deactivated fell through to `success` and came
                            // out the same green as Active — the one status
                            // that means "do not work this account" was the
                            // hardest to tell from the one that means work it.
                            r.status === "Deactivated"
                            ? "danger"
                            : r.status === "Inactive"
                              ? "muted"
                              : r.status === "New"
                                ? "brand"
                                : "success"
                      }
                    >
                      {r.status}
                    </Badge>
                  </Td>
                  <Td>{r.lastOrderDate ? shortDate(r.lastOrderDate) : "-"}</Td>
                  <Td>{r.lastContactAt ? stamp(r.lastContactAt) : "-"}</Td>
                  <Td
                    align="right"
                    className={
                      r.outstanding > 0 ? "font-medium text-danger" : ""
                    }
                  >
                    {money(r.outstanding)}
                  </Td>
                  <Td>
                    <NextCallCell step={r.nextStep} today={todayIso} />
                  </Td>
                  <Td>{r.city}</Td>
                  {/*
                    Pinned, because the table is wide enough to scroll and the
                    way to act on a row must not depend on where it happens to
                    be scrolled to. `i` continues the zebra striping by hand:
                    a cell lifted out of the normal flow has to paint its own
                    background or the row scrolls visibly underneath it.
                  */}
                  <Td align="right" className={pinnedCell("right", i)}>
                    <span className="flex justify-end">
                      <RowMenu
                        items={[
                          {
                            label: isCrm ? "Open record" : "Open account",
                            onSelect: () => router.push(recordHref(r.id)),
                          },
                          {
                            label: "Edit details",
                            onSelect: () => setEditing(r),
                          },
                          /*
                            CONVERTING IS OFFERED ON A LEAD AND NOWHERE ELSE.

                            A direct customer is an account we invoice, and
                            saying it does not bill with us is a contradiction
                            — so the option is absent rather than drawn and
                            refused. Lifting the mark is offered on anything
                            carrying it, because a shop that starts buying from
                            us directly is a good day and undoing must never be
                            harder than doing.
                          */
                          ...(canClassify && r.thirdParty
                            ? [
                                {
                                  label: "No longer a third-party customer",
                                  onSelect: async () => {
                                    await run(revertThirdParty([r.id]));
                                    router.refresh();
                                  },
                                },
                              ]
                            : canClassify && r.kind === "lead"
                              ? [
                                  {
                                    label: "Convert to third-party customer",
                                    onSelect: () => setConverting([r]),
                                  },
                                ]
                              : []),
                          /*
                            WhatsApp and the CRM bill list are CRM screens, and
                            an accounts user is redirected out of them. An
                            action that lands somewhere you cannot go is worse
                            than one that is absent — the second says what the
                            app does, the first says it is broken.
                          */
                          ...(isCrm
                            ? [
                                {
                                  label: "Send WhatsApp",
                                  onSelect: () =>
                                    router.push(`/crm/whatsapp?customer=${r.id}`),
                                },
                              ]
                            : []),
                          {
                            // Accounts has its own bill list, and it is the
                            // one this app's users can open.
                            label: "See their bills",
                            onSelect: () =>
                              router.push(
                                isCrm
                                  ? `/crm/bills?customer=${r.id}`
                                  : `/accounts/bills?customer=${r.id}`,
                              ),
                          },
                          /*
                           * A deactivated customer is offered the way back
                           * rather than the way out. The manager who can
                           * decide gets the decision here, where the customer
                           * actually is — there is no separate queue for it,
                           * and inventing one would hide two-a-month behind a
                           * screen nobody opens.
                           */
                          ...(r.status === "Deactivated"
                            ? isManager && r.reactivationRequested
                              ? [
                                  {
                                    label: "Approve reactivation",
                                    onSelect: async () => {
                                      await run(decideReactivation(r.id, true));
                                      router.refresh();
                                    },
                                  },
                                  {
                                    label: "Reject the request",
                                    destructive: true,
                                    onSelect: async () => {
                                      await run(decideReactivation(r.id, false));
                                      router.refresh();
                                    },
                                  },
                                ]
                              : [
                                  {
                                    label: r.reactivationRequested
                                      ? "Reactivation already asked for"
                                      : "Request reactivation",
                                    disabled: r.reactivationRequested,
                                    onSelect: () => {
                                      setSelected(new Set([r.id]));
                                      setReactivating(true);
                                    },
                                  },
                                ]
                            : isManager && r.deactivationRequested
                              ? [
                                  /*
                                   * The mirror of the reactivation decision
                                   * above, and it belongs here for the same
                                   * reason: the manager decides where the
                                   * customer is. It used to be answered on the
                                   * Inactive Watch, which is why removing that
                                   * screen left requests with nowhere to go.
                                   */
                                  {
                                    label: "Approve deactivation",
                                    destructive: true,
                                    onSelect: async () => {
                                      await run(decideDeactivation(r.id, true));
                                      router.refresh();
                                    },
                                  },
                                  {
                                    label: "Reject the request",
                                    onSelect: async () => {
                                      await run(decideDeactivation(r.id, false));
                                      router.refresh();
                                    },
                                  },
                                ]
                              : [
                                  {
                                    label: r.deactivationRequested
                                      ? "Deactivation already asked for"
                                      : "Request deactivation",
                                    destructive: true,
                                    disabled: r.deactivationRequested,
                                    title: r.deactivationRequested
                                      ? "Asked for already - a manager has yet to decide"
                                      : undefined,
                                    onSelect: () => {
                                      setSelected(new Set([r.id]));
                                      setDeactivating(true);
                                    },
                                  },
                                ]),
                        ]}
                      />
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        ) : (
          /*
           * "No customers match these filters" is true of an empty third-party
           * list and tells somebody nothing: it reads as a filter that found
           * nothing when the answer is that the work has not been started.
           * Nothing is converted until a manager converts it, so the screen
           * says that, and points at the list it is done from.
           */
          accountTypeFilter === "yes" && !query ? (
            <EmptyState
              title="No third-party customers yet"
              body={
                "A third-party customer is a shop we deliver to and a distributor bills. Nothing is converted automatically - somebody decides who bills the shop, and only a lead can be converted. The 'Delivered to on another\u2019s bill' filter lists the accounts the order sheet shows taking goods somebody else was invoiced for, which is where that decision is usually made."
              }
              action={
                <Button
                  variant="primary"
                  onClick={() => navigate({ party: "delivered" })}
                >
                  Show accounts delivered to on another&apos;s bill
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No customers match these filters"
              body="Widen the search or clear the filters to see the full book."
              action={
                <Button variant="primary" onClick={clearAll}>
                  Clear filters
                </Button>
              }
            />
          )
        )}
      </Card>

      {total ? (
        <div className="flex flex-wrap items-center gap-3 border-r border-b border-l border-line bg-surface px-4 py-3">
          <span className="text-[13px] text-muted">
            {/* The range, not just a page number: "26–50 of 1,075" says where
                you are, which "page 2" only does once you know how big a page
                is. */}
            {from + 1}&ndash;{Math.min(from + perPage, total)} of{" "}
            {total.toLocaleString("en-IN")}
          </span>

          <span className="flex items-center gap-2 text-[13px] text-muted">
            <label htmlFor="per-page">Show</label>
            <select
              id="per-page"
              value={perPage}
              onChange={(e) => {
                // Keep the first row of this page in view rather than jumping
                // to the top: a page size is a change of zoom, not of place.
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

      <SelectionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
      >
        {/*
          Reminders and WhatsApp are the calling book's work and both live on
          CRM screens, so they are offered where they can actually be done.
          Everything else in this bar — export, the account manager change,
          deactivation — is the same in both apps.
        */}
        {isCrm ? (
          <>
            <Button variant="dark" size="sm" onClick={() => setBulkRemind(true)}>
              Set reminder
            </Button>
            <Button
              variant="dark"
              size="sm"
              onClick={() => {
                const first = [...selected][0];
                router.push(`/crm/whatsapp?customer=${first}`);
              }}
            >
              Send WhatsApp
            </Button>
          </>
        ) : null}
        <Button
          variant="dark"
          size="sm"
          disabled={!isManager}
          title={isManager ? undefined : "Export is a manager action"}
          onClick={() => exportCsv(visible.filter((r) => selected.has(r.id)))}
        >
          Export
        </Button>
        <Button
          variant="dark"
          size="sm"
          disabled={!canReassign}
          title={
            canReassign
              ? undefined
              : "Changing an account manager is an accounts or admin action"
          }
          onClick={() => setChangingAm(true)}
        >
          Update account manager
        </Button>
        {/* A separate button because it is a separate permission — a manager
            holds this one and not the one above it. Folding the seat into that
            dialog would have hidden a control behind a dialog its holder
            cannot open. */}
        <Button
          variant="dark"
          size="sm"
          disabled={!canAssignSalesManager}
          title={
            canAssignSalesManager
              ? undefined
              : "Setting the sales manager is a manager or admin action"
          }
          onClick={() => setSmScope("selection")}
        >
          Set sales manager
        </Button>
        {/*
          Converting a batch asks for the distributors ONCE and records them
          against every shop in it — which is the ordinary case, because a row
          of shops on one route is served by one distributor and that is why
          they were filtered onto this screen together. Where it is not true,
          each shop's own record is where its arrangement is corrected.
        */}
        {canClassify && selectedAllConvertible ? (
          <Button
            variant="dark"
            size="sm"
            onClick={() => setConverting(selectedRows)}
          >
            Convert to third party
          </Button>
        ) : null}
        {canClassify && selectedAllThirdParty ? (
          <Button
            variant="dark"
            size="sm"
            onClick={async () => {
              await run(revertThirdParty([...selected]));
              setSelected(new Set());
              router.refresh();
            }}
          >
            No longer third party
          </Button>
        ) : null}
        {/* Which way round depends on what is selected. Offering both at once
            would put "deactivate" next to "bring back" over one tick list. */}
        {selectedAllDeactivated ? (
          <Button variant="dark" size="sm" onClick={() => setReactivating(true)}>
            Request reactivation
          </Button>
        ) : (
          <Button variant="dark" size="sm" onClick={() => setDeactivating(true)}>
            Request deactivation
          </Button>
        )}
      </SelectionBar>

      <ThirdPartyDialog
        // Keyed on the selection, so opening it on a different row starts
        // empty rather than holding what was chosen last time.
        key={converting?.map((r) => r.id).join(",") ?? "none"}
        open={Boolean(converting)}
        names={converting?.map((r) => r.name) ?? []}
        excludeCustomerId={converting?.length === 1 ? converting[0].id : undefined}
        onClose={() => setConverting(null)}
        onConfirm={async (distributors) => {
          if (!converting) return false;
          const result = await run(
            convertToThirdParty({
              customerIds: converting.map((r) => r.id),
              distributors: distributors.map((d) => ({
                distributorId: d.id,
                isPrimary: d.isPrimary,
                note: d.note.trim() || undefined,
              })),
            }),
          );
          if (result.ok) {
            setSelected(new Set());
            router.refresh();
          }
          return result.ok;
        }}
      />

      <CustomerForm
        open={addOpen}
        title="Add lead"
        people={backOfficePeople}
        kind="lead"
        canReassign={canReassign}
        amReasons={amReasons}
        onClose={() => setAddOpen(false)}
        onSubmit={async (values) => {
          const result = await run(createCustomer(values));
          if (result.ok) {
            setAddOpen(false);
            router.refresh();
          }
          return result.ok;
        }}
      />

      <CustomerForm
        open={Boolean(editing)}
        title={`Edit ${editing?.name ?? ""}`}
        people={backOfficePeople}
        kind={editing?.kind ?? "customer"}
        canReassign={canReassign}
        amReasons={amReasons}
        initial={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSubmit={async (values) => {
          if (!editing) return false;

          /*
           * Two saves, because two different things can be in this form and
           * only one of them is an ordinary edit.
           *
           * The ordinary fields go to `updateCustomer`. Moving an account
           * between managers goes to `updateAccountManagers`, which is the one
           * place that writes a history row, notifies both people and marks
           * the account so the nightly sheet sync stops restating the old
           * answer. Writing those columns here instead would be a second door
           * to the same fact, and the unaudited one always wins in the end.
           *
           * The managers go FIRST. If that call is refused — no permission, a
           * missing reason — nothing has been written yet, and the form comes
           * back with everything still in it rather than half saved.
           */
          // Against the ASSIGNED person the form opened with, not the owner:
          // comparing the owner would report "moved" on every save of a
          // customer whose sales AM is anybody but the importer.
          /*
           * The SAME function the field opened with. If the two disagreed,
           * opening a form and pressing Save would report a reassignment
           * nobody made — and on this book that would clear the account
           * holding the queue on every customer somebody edited.
           */
          const assignedBefore = openingSalesValue(
            editing.kind,
            editing,
            backOfficePeople,
          );
          const salesPicked = String(values.assignedId ?? "");
          const backOfficePicked = String(values.backOfficeAmId ?? "");
          /*
           * The sheet sentinel is not a value, it is "nothing was touched".
           * Treating it as a move would send a string no column can hold, and
           * would stamp the decision mark on an account nobody decided about.
           */
          const salesMoved =
            salesPicked !== SHEET_NAME_VALUE && salesPicked !== assignedBefore;
          const backOfficeMoved =
            backOfficePicked !== SHEET_NAME_VALUE &&
            backOfficePicked !== openingBackOfficeValue(editing, backOfficePeople);

          if (salesMoved || backOfficeMoved) {
            const backOfficeId = backOfficePicked;
            /*
             * Only the seat that MOVED is sent. This used to send both
             * whenever either changed, which stamps the decision mark — the
             * thing that stops the sheet restating the old answer — on a seat
             * nobody touched.
             *
             * This form asks for one reason, so the seat that moved carries
             * it. Where both moved it is the same answer twice, which is what
             * the person typed; the bulk dialog asks per seat because there
             * the two are usually different decisions.
             */
            const reasonCode = String(values.amReasonCode ?? "");
            const moved = await run(
              updateAccountManagers({
                customerIds: [editing.id],
                ...(salesMoved
                  ? salesPicked.startsWith("emp:")
                    ? {
                        salesEmployeeId: salesPicked.slice(4),
                        sales: { reasonCode },
                      }
                    : { salesAmId: salesPicked || null, sales: { reasonCode } }
                  : {}),
                ...(backOfficeMoved
                  ? {
                      backOffice: !backOfficeId
                        ? ({ kind: "none" } as const)
                        : backOfficeId.startsWith("emp:")
                          ? ({
                              kind: "employee",
                              employeeId: backOfficeId.slice(4),
                            } as const)
                          : ({ kind: "user", userId: backOfficeId } as const),
                      backOfficeReason: { reasonCode },
                    }
                  : {}),
              }),
            );
            if (!moved.ok) return false;
          }

          // The manager columns and the reason are never sent as ordinary
          // fields, whether or not they moved — `updateCustomer` has no
          // business writing them.
          const rest = Object.fromEntries(
            Object.entries(values).filter(
              ([k]) => !["assignedId", "backOfficeAmId", "amReasonCode"].includes(k),
            ),
          );
          const result = await run(updateCustomer(editing.id, rest));
          if (result.ok) {
            setEditing(null);
            router.refresh();
          }
          return result.ok;
        }}
      />

      <BulkReminderModal
        open={bulkRemind}
        count={selected.size}
        onClose={() => setBulkRemind(false)}
        onSubmit={async (dueDate, note) => {
          const result = await run(
            createRemindersBulk([...selected], dueDate, note),
          );
          if (result.ok) {
            setBulkRemind(false);
            setSelected(new Set());
            router.refresh();
          }
        }}
      />

      <ConfirmDialog
        open={deactivating}
        title={`Request deactivation for ${selected.size} customer${selected.size === 1 ? "" : "s"}?`}
        body="They stay visible until a manager approves it. The reason is kept on the customer record either way."
        confirmLabel="Request deactivation"
        destructive
        needsReason
        onClose={() => setDeactivating(false)}
        onConfirm={async (reason) => {
          const result = await run(requestDeactivation([...selected], reason));
          if (result.ok) {
            setSelected(new Set());
            router.refresh();
          }
        }}
      />

      <AccountManagerDialog
        // Keyed on the selection so it remounts with fresh state rather than
        // resetting in an effect — the React Compiler rule every modal here
        // already follows.
        key={`am-${[...selected].join(",")}`}
        open={changingAm}
        accounts={visible
          .filter((r) => selected.has(r.id))
          .map((r) => ({
            id: r.id,
            name: r.name,
            salesName: r.salesAmName,
            backOfficeName: r.backOfficeAmName,
          }))}
        salesPeople={team}
        backOfficePeople={backOfficePeople}
        reasons={amReasons}
        searchThreshold={amSearchThreshold}
        onClose={() => setChangingAm(false)}
        onSubmit={async (change) => {
          // The dialog decides which accounts go: its review step can untick
          // any of them, so the selection is where the list STARTS, not what
          // is sent.
          const result = await run(updateAccountManagers(change));
          if (result.ok) {
            setChangingAm(false);
            setSelected(new Set());
            router.refresh();
          }
        }}
      />

      {/*
        Rendered only when it is open, because the scope is decided at the
        moment of opening and the dialog reads it once. Mounting it with a
        placeholder scope would mean a component whose props describe a
        transfer nobody asked for.
      */}
      {smScope ? (
        <SalesManagerDialog
          // Keyed on what it is acting on, so it remounts with fresh state
          // rather than resetting in an effect — the React Compiler rule every
          // modal here already follows.
          key={`sm-${smScope}-${smScope === "selection" ? [...selected].join(",") : search.toString()}`}
          open
          scope={
            smScope === "selection"
              ? {
                  kind: "ids",
                  ids: [...selected],
                  accounts: visible
                    .filter((r) => selected.has(r.id))
                    .map((r) => ({
                      id: r.id,
                      name: r.name,
                      salesManagerName: r.salesManagerName,
                    })),
                }
              : {
                  kind: "filters",
                  /*
                   * Sent verbatim, and the server runs the SAME clause the
                   * list ran to draw this screen. Re-deriving "which
                   * customers" on the way in is how a bulk action comes to
                   * move a set nobody reviewed.
                   */
                  filters: {
                    query: query || undefined,
                    status: status || undefined,
                    salesAm: salesAm || undefined,
                    salesManager: salesManager || undefined,
                    backOfficeAm: backOfficeAm || undefined,
                  },
                  // The chips, which are already the filters said in words —
                  // one statement of what is on screen, not two that can drift.
                  describedAs: chips.map((c) => c.label),
                  // Everything the filters match, NOT the page. The whole
                  // point is the accounts nobody has scrolled to.
                  count: total,
                }
          }
          people={salesManagerPeople}
          reasons={amReasons}
          searchThreshold={amSearchThreshold}
          onClose={() => setSmScope(null)}
          onSubmit={async (change) => {
            const result = await run(
              assignSalesManager({
                scope:
                  change.ids !== undefined
                    ? { kind: "ids", customerIds: change.ids }
                    : {
                        kind: "filters",
                        filters: {
                          query: query || undefined,
                          status: status || undefined,
                          salesAm: salesAm || undefined,
                          salesManager: salesManager || undefined,
                          backOfficeAm: backOfficeAm || undefined,
                        },
                      },
                target: change.target,
                reasonCode: change.reasonCode,
                note: change.note,
                expectedCount: change.expectedCount,
              }),
            );
            if (result.ok) {
              setSmScope(null);
              setSelected(new Set());
              router.refresh();
            }
          }}
        />
      ) : null}

      <ConfirmDialog
        open={reactivating}
        title={`Ask to bring back ${selected.size} customer${selected.size === 1 ? "" : "s"}?`}
        body="They stay off every list until a manager approves it. The reason is what the manager decides on, so say what has changed."
        confirmLabel="Request reactivation"
        needsReason
        onClose={() => setReactivating(false)}
        onConfirm={async (reason) => {
          const result = await run(requestReactivation([...selected], reason));
          if (result.ok) {
            setSelected(new Set());
            router.refresh();
          }
        }}
      />
    </div>
  );
}

/** Common ways a lead reaches Mahek. Free text underneath — this is a shortcut. */
const LEAD_SOURCES = [
  "Walk-in",
  "Referral",
  "Exhibition",
  "Cold list",
  "Existing customer's contact",
  "Phone enquiry",
];

/**
 * The value the sales and back office fields carry when the person in that
 * seat has no MahekOne account.
 *
 * Most of them do not. Four of the busiest salespeople on this book — Prakash
 * Vasudev Prasad, Rahul Richhariya, Bharat Singh and Sanjay Kumar Samantaray
 * — are current employees who have never signed in, and three more entries
 * are not people at all ("Back Office Calling", "Marathwada", "South Zone").
 *
 * A `<select>` can only hold ids, so the sheet's answer needs one to be shown
 * as the value it is. It is never sent: it means "nothing was touched", and
 * the save path drops it rather than writing a string no column can hold.
 */
export const SHEET_NAME_VALUE = "__sheet__";

/**
 * Still here, or gone.
 *
 * NOT "has a login" — that was the wrong thing to mark. Everybody gets a
 * sign-in eventually and none of it changes who the customer's salesperson
 * is. What a person standing at this field needs to know is whether the name
 * in the seat still works here, because somebody leaving is the usual reason
 * they are standing there at all.
 *
 * It sits ON THE FIELD rather than inside the list. An `<option>` renders
 * text and nothing else, so a marker in a list can only ever be a character
 * at the size of the words beside it — which is how this began as an emoji.
 * Out here it is an element, so it is six pixels of colour instead.
 *
 * Only the current holder carries one. Everybody the list offers is current
 * staff, so a mark against each of them would say the same thing forty times.
 */
export function StaffDot({ gone }: { gone: boolean }) {
  return (
    <span
      aria-hidden
      title={gone ? "No longer on the staff list" : "On the staff list"}
      className={cx(
        "pointer-events-none absolute top-1/2 left-2.5 z-10 h-1.5 w-1.5 -translate-y-1/2 rounded-full",
        gone ? "bg-danger" : "bg-success",
      )}
    />
  );
}

/** Somebody on the list with this name, by either route. */
function findByName(
  people: Array<{ id: string; name: string }>,
  name: string | null | undefined,
) {
  const wanted = name?.trim().toLowerCase();
  if (!wanted) return undefined;
  return people.find((p) => p.name.trim().toLowerCase() === wanted);
}

/**
 * What the sales seat shows on open.
 *
 * THE SHEET'S NAME IS USUALLY SOMEBODY WE KNOW. Four of the busiest
 * salespeople here are current employees, so the name resolves to a real
 * entry on the list and that entry is what the field selects — one row, the
 * person's own name, nothing appended. Showing the sheet's answer as a
 * separate "from the sheet" line put the same person on the list twice, which
 * is a worse question than the one it answered.
 *
 * The sentinel is what is left for the answers that resolve to nobody:
 * "Back Office Calling", "Marathwada" and "South Zone" are real entries on
 * this book and are not people at all.
 *
 * Used for the field AND for the baseline the save compares against, so
 * opening a form and saving it writes nothing.
 */
export function openingSalesValue(
  kind: "lead" | "customer",
  initial: Partial<Row> | undefined,
  people: Array<{ id: string; name: string }>,
): string {
  /*
   * DECIDED reads `salesAmId` exactly as it stands — same three-way branch as
   * `ASSIGNED_TO_SQL`. Falling through to the owner here regardless of
   * `amDecidedAt`, as this used to, meant a form reopened on an account
   * somebody had just unassigned pre-selected the importer's account all over
   * again: the save that emptied the seat looked, on the very next open, like
   * it had never happened.
   */
  const account =
    (kind === "lead"
      ? initial?.ownerId
      : initial?.amDecidedAt
        ? initial?.salesAmId
        : (initial?.salesAmId ?? initial?.ownerId)) ?? "";
  const stated = initial?.salesAmName?.trim();
  if (!stated) return account;
  // The same person by two routes is one person: keep the account, which is
  // the half that can actually be given a calling queue.
  const accountName = people.find((p) => p.id === account)?.name?.trim();
  if (accountName && accountName === stated) return account;
  return findByName(people, stated)?.id ?? SHEET_NAME_VALUE;
}

/** The same rule for the back office seat. */
export function openingBackOfficeValue(
  initial: Partial<Row> | undefined,
  people: Array<{ id: string; name: string }>,
): string {
  if (initial?.backOfficeAmId) return initial.backOfficeAmId;
  const stated = initial?.backOfficeAmName?.trim();
  if (!stated) return "";
  return findByName(people, stated)?.id ?? SHEET_NAME_VALUE;
}

type CustomerFormProps = {
  open: boolean;
  title: string;
  /**
   * Everybody who can hold a seat: the accounts, plus the current HRMS
   * employees marked as having no login.
   *
   * ONE list for both seats. It was two — accounts for sales, accounts and
   * employees for back office — on the reasoning that sales drives the
   * calling queue so it must be somebody who signs in. That reasoning is
   * still true and is now said on the screen instead of enforced by omission,
   * because four of the busiest salespeople on this book are employees with
   * no login and the seat could not name them at all.
   */
  people: Array<{ id: string; name: string; role?: string }>;
  /** A new record is a lead. An existing one is whatever it already is. */
  kind: "lead" | "customer";
  /**
   * Whether this person may move an account between managers. Not the same as
   * `isManager` — it is accounts' and admin's, because whose book an account
   * is in decides whose targets it counts toward.
   */
  canReassign: boolean;
  /** `people.amChangeReasons`, asked for whenever a manager changes. */
  amReasons: string[];
  initial?: Partial<Row>;
  onClose: () => void;
  onSubmit: (values: Record<string, unknown>) => Promise<boolean>;
};

/** Keyed on the customer so editing one never leaks fields into the next. */
function CustomerForm(props: CustomerFormProps) {
  if (!props.open) return null;
  return <CustomerFormBody key={props.initial?.id ?? "new"} {...props} />;
}

function CustomerFormBody({
  open,
  title,
  people,
  kind,
  canReassign,
  amReasons,
  initial,
  onClose,
  onSubmit,
}: CustomerFormProps) {
  const isLead = kind === "lead";
  /* Set once, on the way in. See the Source field. */
  const isNew = !initial?.id;
  const [busy, setBusy] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>({
    name: initial?.name ?? "",
    contactPerson: initial?.contactPerson ?? "",
    phone: initial?.phone ?? "",
    city: initial?.city ?? "",
    /*
     * The ASSIGNED person, which for a customer is the sales AM and only
     * falls back to the owner where that is unset — `assignedUserId` in
     * access-control, and `ASSIGNED_TO_SQL` in every scoped query.
     *
     * This field read `ownerId` alone, and on this book that is one account
     * for all 1075 records: the modal showed the importer on every customer
     * while the list beside it showed the real manager. They were reading two
     * different columns and only one of them answers "whose book is this".
     */
    // The SALES list, which is accounts and employees both — the same list
    // the field offers, so what it opens showing is always something on it.
    assignedId: openingSalesValue(kind, initial, people),
    gstin: initial?.gstin ?? "",
    creditTermDays: String(initial?.creditTermDays ?? 30),
    route: initial?.route ?? "",
    leadSource: initial?.leadSource ?? "",
    /*
     * The same shape as the sales seat. NOT auto-matched to an employee of
     * the same name, tempting as that is: the field would then differ from
     * what is stored, an ordinary save would read as a change, and writing it
     * stamps `amDecidedAt` — which is what stops the nightly sheet sync
     * touching that column ever again. A display convenience must not quietly
     * freeze a column against the sheet.
     */
    backOfficeAmId: openingBackOfficeValue(initial, people),
    // Only sent when a manager actually changed — see below.
    amReasonCode: amReasons[0] ?? "",
  });

  const set =
    (k: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setValues((v) => ({ ...v, [k]: e.target.value }));

  /*
   * Whether either account manager actually moved, compared against what the
   * record held when the form opened. This is what decides whether a reason is
   * asked for and whether the audited action is called at all — saving a form
   * where somebody only fixed a spelling must not write a reassignment.
   */
  const amChanged =
    (values.assignedId !== SHEET_NAME_VALUE &&
      values.assignedId !== openingSalesValue(kind, initial, people)) ||
    (values.backOfficeAmId !== SHEET_NAME_VALUE &&
      values.backOfficeAmId !== openingBackOfficeValue(initial, people));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={560}
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
                await onSubmit(values);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Business name · required" className="col-span-2">
          <Input
            value={values.name ?? ""}
            onChange={set("name")}
            placeholder="As it appears on the bill"
          />
        </Field>
        <Field label="Contact person">
          <Input
            value={values.contactPerson ?? ""}
            onChange={set("contactPerson")}
          />
        </Field>
        <Field label="Telephone · required" hint="10 digits, no country code">
          <Input
            value={values.phone ?? ""}
            onChange={set("phone")}
            inputMode="numeric"
            maxLength={10}
          />
        </Field>
        <Field label="City · required">
          <Input value={values.city ?? ""} onChange={set("city")} />
        </Field>
        {/*
          The two account managers, named as the roles they are.

          An account answers to a SALES manager — its owner while it is still a
          lead, its sales account manager once it is a customer, which is the
          same job under two column names — and to a BACK OFFICE manager for
          dispatch, billing and paperwork. Both are offered here because this
          is the form somebody already has open when they discover the wrong
          name on an account.

          Changing one is not an ordinary field edit, though. It moves the
          account between books, so it carries a reason, writes a history row,
          notifies both people and marks the account so the nightly sheet sync
          stops restating the old answer. All of that lives in one action, and
          this form calls it rather than writing the columns itself — two doors
          to the same fact is how one of them ends up unaudited.
        */}
        <Field
          label={isLead ? "Lead owner" : "Account manager · sales"}
          hint={
            canReassign
              ? "Whose book this account is in."
              : "Only accounts or an admin can move an account."
          }
        >
          <span className="relative block">
            {values.assignedId ? (
              <StaffDot gone={values.assignedId === SHEET_NAME_VALUE} />
            ) : null}
            <Select
              value={values.assignedId ?? ""}
              onChange={set("assignedId")}
              disabled={!canReassign}
              className={cx("w-full", values.assignedId ? "pl-6" : "")}
            >
              {/* Whoever is in the seat but no longer on the staff list. Kept
                  selectable so the field can still show who it says. */}
              {values.assignedId === SHEET_NAME_VALUE ? (
                <option value={SHEET_NAME_VALUE}>{initial?.salesAmName}</option>
              ) : null}
              <option value="">Unassigned</option>
              {people.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </span>
          {values.assignedId === SHEET_NAME_VALUE ? (
            <span className="mt-1 block text-[12px] text-danger">
              No longer on the staff list. Pick who has taken the book over.
            </span>
          ) : null}
        </Field>
        <Field
          label="Account manager · back office"
          hint={
            canReassign
              ? "Dispatch, billing and paperwork for this account."
              : "Only accounts or an admin can move an account."
          }
        >
          <span className="relative block">
            {values.backOfficeAmId ? (
              <StaffDot gone={values.backOfficeAmId === SHEET_NAME_VALUE} />
            ) : null}
            <Select
              value={values.backOfficeAmId ?? ""}
              onChange={set("backOfficeAmId")}
              disabled={!canReassign}
              className={cx("w-full", values.backOfficeAmId ? "pl-6" : "")}
            >
              {values.backOfficeAmId === SHEET_NAME_VALUE ? (
                <option value={SHEET_NAME_VALUE}>
                  {initial?.backOfficeAmName}
                </option>
              ) : null}
              <option value="">Unassigned</option>
              {people.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </span>
          {values.backOfficeAmId === SHEET_NAME_VALUE ? (
            <span className="mt-1 block text-[12px] text-danger">
              No longer on the staff list. Pick who is doing the paperwork now.
            </span>
          ) : null}
        </Field>

        {/*
          Where a lead came from is READ ONLY. It is set once, when the record
          is created, and it is the only thing that explains a lead months
          later — a field somebody can quietly retype is not an origin, it is
          whatever the last person thought it should say.
        */}
        {isLead ? (
          isNew ? (
            <Field
              label="Source"
              hint="Where they came from. It is the only thing that explains a lead months later, which is also why it cannot be retyped afterwards."
              className="col-span-2"
            >
              <Input
                value={values.leadSource ?? ""}
                onChange={set("leadSource")}
                list="lead-sources"
                placeholder="Walk-in, referral, exhibition…"
              />
              <datalist id="lead-sources">
                {LEAD_SOURCES.map((source) => (
                  <option key={source} value={source} />
                ))}
              </datalist>
            </Field>
          ) : (
            <Field label="Source" className="col-span-2">
              <p className="text-[13px] text-body">
                {initial?.leadSource || (
                  <span className="text-muted">Not recorded</span>
                )}
              </p>
            </Field>
          )
        ) : null}

        <Field label="GSTIN">
          <Input value={values.gstin ?? ""} onChange={set("gstin")} />
        </Field>
        <Field label="Route">
          <Input value={values.route ?? ""} onChange={set("route")} />
        </Field>
        <Field label="Credit terms (days)">
          <Input
            type="number"
            value={values.creditTermDays ?? ""}
            onChange={set("creditTermDays")}
          />
        </Field>
        {/*
          The buying cycle is GONE from this form, not merely hidden.

          It is measured from the intervals between a customer's own orders and
          rebuilt by `recomputeAllBuyingCycles()` on every nightly pass, so a
          number typed here survives until that runs and is then silently
          replaced. A field that accepts a value and discards it overnight is
          worse than no field: somebody sets it, sees it take, and trusts a
          figure that is about to change back.
        */}

        {/*
          The reason, asked only when a manager actually changed.

          Not a field somebody fills in on every edit — a reason attached to a
          phone-number correction is noise in the history that the real moves
          then hide in. It appears when there is something to explain.
        */}
        {amChanged ? (
          <Field
            label="Why is the account manager changing · required"
            className="col-span-2"
          >
            <Select value={values.amReasonCode ?? ""} onChange={set("amReasonCode")}>
              {amReasons.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}

function BulkReminderModal({
  open,
  count,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onSubmit: (dueDate: string, note: string) => Promise<void>;
}) {
  const [dueDate, setDueDate] = React.useState(today());
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Set a reminder on ${count} customer${count === 1 ? "" : "s"}`}
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
                await onSubmit(dueDate, note);
              } finally {
                setBusy(false);
              }
            }}
          >
            Set reminders
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Due date · required">
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-[200px]"
          />
        </Field>
        <Field
          label="What is the reminder for · required"
          hint="Every selected customer gets this same note - write it so it still makes sense in a week."
        >
          <VoiceTextarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onDictate={setNote}
            className="h-20"
            placeholder="Follow up on the month-end order"
          />
        </Field>
      </div>
    </Modal>
  );
}
