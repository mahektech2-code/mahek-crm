"use client";

/* ---------------------------------------------------------------------------
 * EVERY PRICE LIST MAHEK HAS, and what each one is doing.
 *
 * One screen rendered in two apps — the Sales Dashboard and the CRM — like the
 * customer list and the outstanding ledger beside it, because two reads of
 * "what are our price lists" is how two screens come to disagree about one.
 * What differs is only where the links lead.
 *
 * THE COLUMN THAT MATTERS MOST IS "APPLIES TO". A published list with nothing
 * in it prices nobody and looks exactly like one that is working — the whole
 * failure mode of this module — so `scopeSummary` is on the row rather than
 * behind a click, and a list naming nobody says so in words.
 *
 * EXPIRED IS DRAWN, NOT COMPUTED HERE. `expiresOn` and `expired` come off the
 * service, which knows the configured default validity; a screen working out
 * its own would be a second answer, and it would have to read the clock during
 * render, which the React Compiler rules here forbid. `todayIso` arrives as a
 * prop for the same reason.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  MetricStrip,
  PageHeader,
  SortableTh,
  Td,
  Th,
  Tr,
} from "@/components/ui/primitives";
import { ConfirmDialog, FilterPills, RowMenu } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import type { PriceListSummary, PricingApp, PricingCounts, PricingOptions } from "@/lib/price-list-views";
import type { PriceListStatus } from "@/db/schema";
import { FREIGHT_TERM_LABEL, LIST_STATUS_LABEL, LIST_STATUS_TONE } from "@/lib/price-list-labels";
import { deleteDraftPriceList } from "@/lib/actions/price-lists";
import { longDate, shortDate } from "@/lib/format";
import { nextSort, type SortValue } from "@/lib/sort-param";
import { ListFormModal } from "@/components/pricing/modals/list-form-modal";
import { CompareModal } from "@/components/pricing/modals/compare-modal";
import { NewVersionModal } from "@/components/pricing/modals/new-version-modal";
import { WithdrawModal } from "@/components/pricing/modals/withdraw-modal";
import { ResolutionPreviewModal } from "@/components/pricing/modals/resolution-preview-modal";

type StatusFilter = "all" | PriceListStatus;

export function PriceListsScreen({
  app,
  basePath,
  canManage,
  todayIso,
  lists,
  counts,
  options,
}: {
  app: PricingApp;
  basePath: string;
  canManage: boolean;
  todayIso: string;
  lists: PriceListSummary[];
  counts: PricingCounts;
  options: PricingOptions;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortValue>({ column: "effective", direction: "desc" });

  const [creating, setCreating] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [comparing, setComparing] = React.useState<PriceListSummary | null>(null);
  const [versioning, setVersioning] = React.useState<PriceListSummary | null>(null);
  const [withdrawing, setWithdrawing] = React.useState<PriceListSummary | null>(null);
  const [deleting, setDeleting] = React.useState<PriceListSummary | null>(null);

  const counted = React.useMemo(() => {
    const by: Record<string, number> = {};
    for (const l of lists) by[l.status] = (by[l.status] ?? 0) + 1;
    return by;
  }, [lists]);

  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = lists.filter((l) => {
      if (status !== "all" && l.status !== status) return false;
      if (!q) return true;
      return (
        l.name.toLowerCase().includes(q) ||
        (l.refNo ?? "").toLowerCase().includes(q) ||
        l.scopeSummary.toLowerCase().includes(q)
      );
    });
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => direction * compare(a, b, sort.column));
  }, [lists, status, query, sort]);

  function toggle(column: string) {
    setSort((current) => nextSort(current, column));
  }

  async function removeDraft(list: PriceListSummary) {
    const r = await run(deleteDraftPriceList(list.id));
    if (r.ok) {
      setDeleting(null);
      router.refresh();
    }
  }

  return (
    <div>
      <PageHeader
        title="Price lists"
        subtitle={
          app === "crm"
            ? "What each shop pays, so a figure quoted on a call is one somebody can stand behind."
            : "What each shop pays, where it came from, and who it applies to."
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setPreviewing(true)}>
              Which list applies?
            </Button>
            {canManage ? (
              <>
                <Link href={`${basePath}/documents?import=1`}>
                  <Button variant="secondary">Import a price list</Button>
                </Link>
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New list
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="mb-4">
        <MetricStrip
          metrics={[
            { label: "In force", value: String(counts.published) },
            { label: "Drafts", value: String(counts.drafts) },
            {
              label: "Files waiting",
              value: String(counts.documentsWaiting),
              tone: counts.documentsWaiting ? "danger" : "ink",
            },
            {
              label: "Price requests",
              value: String(counts.requestsPending),
              tone: counts.requestsPending ? "danger" : "ink",
            },
            {
              label: "Shops with no price",
              value: counts.unresolvedCustomers == null ? "—" : String(counts.unresolvedCustomers),
              sub: counts.unresolvedCustomers == null ? "Not worked out yet" : undefined,
              tone: counts.unresolvedCustomers ? "danger" : "ink",
            },
          ]}
        />
      </div>

      <PricingSubNav basePath={basePath} current="lists" />

      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <FilterPills<StatusFilter>
          value={status}
          onChange={setStatus}
          options={[
            { key: "all", label: "All", count: lists.length },
            { key: "published", label: "Published", count: counted.published ?? 0 },
            { key: "draft", label: "Draft", count: counted.draft ?? 0 },
            { key: "superseded", label: "Superseded", count: counted.superseded ?? 0 },
            { key: "withdrawn", label: "Withdrawn", count: counted.withdrawn ?? 0 },
          ]}
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, reference or who it applies to"
          className="w-[320px]"
        />
      </div>

      <Card className="overflow-auto">
        {lists.length === 0 ? (
          <EmptyState
            title="No price lists yet"
            body="A list usually starts as the PDF the office already sends out. Import one and the products, the pack sizes and the terms are read off it — or start an empty list and type the rates in."
            action={
              canManage ? (
                <>
                  <Link href={`${basePath}/documents?import=1`}>
                    <Button variant="primary">Import a price list</Button>
                  </Link>
                  <Button variant="secondary" onClick={() => setCreating(true)}>
                    Start an empty list
                  </Button>
                </>
              ) : undefined
            }
          />
        ) : shown.length === 0 ? (
          <EmptyState title="Nothing matches" body="No list here answers to that name, reference or scope." />
        ) : (
          <table className="w-full border-collapse" style={{ minWidth: 1180 }}>
            <thead>
              <tr>
                <SortableTh active={sort.column === "name"} direction={sort.direction} onSort={() => toggle("name")}>
                  Name
                </SortableTh>
                <SortableTh active={sort.column === "ref"} direction={sort.direction} onSort={() => toggle("ref")}>
                  Ref
                </SortableTh>
                <Th align="right">Version</Th>
                <SortableTh active={sort.column === "status"} direction={sort.direction} onSort={() => toggle("status")}>
                  Status
                </SortableTh>
                <SortableTh
                  active={sort.column === "effective"}
                  direction={sort.direction}
                  onSort={() => toggle("effective")}
                >
                  Effective
                </SortableTh>
                <SortableTh
                  active={sort.column === "expires"}
                  direction={sort.direction}
                  onSort={() => toggle("expires")}
                >
                  Expires
                </SortableTh>
                <Th>Freight</Th>
                <Th>Applies to</Th>
                <SortableTh
                  align="right"
                  active={sort.column === "rates"}
                  direction={sort.direction}
                  onSort={() => toggle("rates")}
                >
                  Rates
                </SortableTh>
                <SortableTh
                  active={sort.column === "updated"}
                  direction={sort.direction}
                  onSort={() => toggle("updated")}
                >
                  Updated
                </SortableTh>
                <Th />
              </tr>
            </thead>
            <tbody>
              {shown.map((list) => (
                <Tr key={list.id}>
                  <Td className="max-w-[280px] truncate">
                    <Link href={`${basePath}/${list.id}`} className="font-medium text-ink hover:text-brand hover:underline">
                      {list.name}
                    </Link>
                  </Td>
                  <Td className="text-muted">{list.refNo ?? "—"}</Td>
                  <Td align="right">v{list.version}</Td>
                  <Td>
                    <Badge tone={LIST_STATUS_TONE[list.status]}>{LIST_STATUS_LABEL[list.status]}</Badge>
                  </Td>
                  <Td>{shortDate(list.effectiveFrom)}</Td>
                  <Td>
                    {list.expiresOn ? (
                      list.expired ? (
                        <Badge tone="muted" title={`Expired on ${longDate(list.expiresOn)}`}>
                          expired
                        </Badge>
                      ) : (
                        shortDate(list.expiresOn)
                      )
                    ) : (
                      <span className="text-muted">Open ended</span>
                    )}
                  </Td>
                  <Td className="text-muted">{FREIGHT_TERM_LABEL[list.freightTerm]}</Td>
                  <Td className="max-w-[260px] truncate" title={list.scopeSummary}>
                    {list.scopeCount ? (
                      list.scopeSummary
                    ) : (
                      <span className="text-warn-ink">Nobody — it prices no shop</span>
                    )}
                  </Td>
                  <Td align="right">{list.rateCount}</Td>
                  <Td className="text-muted">{shortDate(list.updatedAt)}</Td>
                  <Td align="right">
                    <RowMenu
                      items={[
                        { label: "Open", onSelect: () => router.push(`${basePath}/${list.id}`) },
                        { label: "Compare with…", onSelect: () => setComparing(list) },
                        {
                          label: "New version",
                          onSelect: () => setVersioning(list),
                          disabled: !canManage,
                          title: canManage ? undefined : "Only somebody who manages price lists can do this.",
                        },
                        {
                          label: "Withdraw",
                          onSelect: () => setWithdrawing(list),
                          destructive: true,
                          disabled: !canManage || list.status !== "published",
                          title: !canManage
                            ? "Only somebody who manages price lists can do this."
                            : list.status !== "published"
                              ? "Only a list in force can be withdrawn."
                              : undefined,
                        },
                        {
                          label: "Delete",
                          onSelect: () => setDeleting(list),
                          destructive: true,
                          disabled: !canManage || list.status !== "draft",
                          title: !canManage
                            ? "Only somebody who manages price lists can do this."
                            : list.status !== "draft"
                              ? "A published list is withdrawn, never deleted — orders were taken against it."
                              : undefined,
                        },
                      ]}
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <ListFormModal
        open={creating}
        onClose={() => setCreating(false)}
        list={null}
        options={options}
        todayIso={todayIso}
        basePath={basePath}
      />
      <ResolutionPreviewModal open={previewing} onClose={() => setPreviewing(false)} basePath={basePath} />
      {comparing ? (
        <CompareModal
          open
          onClose={() => setComparing(null)}
          listId={comparing.id}
          listName={comparing.name}
          options={options}
        />
      ) : null}
      {versioning ? (
        <NewVersionModal
          open
          onClose={() => setVersioning(null)}
          listId={versioning.id}
          listName={versioning.name}
          refNo={versioning.refNo}
          version={versioning.version}
          todayIso={todayIso}
          basePath={basePath}
        />
      ) : null}
      {withdrawing ? (
        <WithdrawModal
          open
          onClose={() => setWithdrawing(null)}
          listId={withdrawing.id}
          listName={withdrawing.name}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? ""}?`}
        body="A draft has never priced anything, so this really does delete it — the rates, the scopes and the discount terms go with it."
        confirmLabel="Delete the draft"
        destructive
        onConfirm={() => (deleting ? removeDraft(deleting) : undefined)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function compare(a: PriceListSummary, b: PriceListSummary, column: string): number {
  switch (column) {
    case "name":
      return a.name.localeCompare(b.name);
    case "ref":
      return (a.refNo ?? "").localeCompare(b.refNo ?? "");
    case "status":
      return a.status.localeCompare(b.status);
    case "expires":
      return (a.expiresOn ?? "").localeCompare(b.expiresOn ?? "");
    case "rates":
      return a.rateCount - b.rateCount;
    case "updated":
      return a.updatedAt.localeCompare(b.updatedAt);
    case "effective":
    default:
      return a.effectiveFrom.localeCompare(b.effectiveFrom);
  }
}
