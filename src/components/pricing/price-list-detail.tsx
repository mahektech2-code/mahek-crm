"use client";

/* ---------------------------------------------------------------------------
 * ONE PRICE LIST, WHOLE.
 *
 * The rates in the shape the office prints them — families down, pack sizes
 * across — plus the four things a figure means nothing without: who the list
 * applies to, what discounts ride on it, where it came from, and which version
 * of it this is.
 *
 * THE GRID IS THE POINT. A flat list of two hundred rows is a table nobody
 * reads; the printed sheet is a grid because a person compares a 5 litre can
 * against a 20 litre one across a row, and the screen that replaces it has to
 * do the same. The Table tab is still there for the questions a grid cannot
 * answer — per litre, slabs, what was matched from a PDF — and both are the
 * same rates read two ways rather than two reads.
 *
 * A DASH AND AN EMPTY CELL ARE DIFFERENT FACTS. `offered` off is the printed
 * sheet's dash: listed, and not for sale on this list. No rate at all is
 * nobody having priced it. Drawing them alike is how a SKU quietly goes
 * unpriced for a month.
 *
 * MONEY IS PAISE and the stored rate is ex-GST; the big figure is the
 * inclusive one because that is what the shop is told, with the ex-GST figure
 * under it because that is what the order sheet bills.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  SortableTh,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { ConfirmDialog, RowMenu, Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useRouter } from "next/navigation";
import type { PriceListDetail as Detail, PricingApp, PricingOptions, RateRow, ScopeView } from "@/lib/price-list-views";
import {
  FREIGHT_TERM_HINT,
  LIST_STATUS_LABEL,
  LIST_STATUS_TONE,
  SCOPE_KIND_LABEL,
  listSummary,
} from "@/lib/price-list-labels";
import { removeDiscountTerm, removeScope } from "@/lib/actions/price-lists";
import { longDate, money, shortDate } from "@/lib/format";
import { nextSort, type SortValue } from "@/lib/sort-param";
import { derivationSentence } from "@/components/pricing/derivation";
import { ListFormModal } from "@/components/pricing/modals/list-form-modal";
import { RateModal } from "@/components/pricing/modals/rate-modal";
import { BulkRatesModal } from "@/components/pricing/modals/bulk-rates-modal";
import { ScopeModal } from "@/components/pricing/modals/scope-modal";
import { DiscountTermModal } from "@/components/pricing/modals/discount-term-modal";
import { PublishModal } from "@/components/pricing/modals/publish-modal";
import { WithdrawModal } from "@/components/pricing/modals/withdraw-modal";
import { NewVersionModal } from "@/components/pricing/modals/new-version-modal";
import { BulkReviseModal } from "@/components/pricing/modals/bulk-revise-modal";
import { DerivedListModal } from "@/components/pricing/modals/derived-list-modal";
import { CompareModal } from "@/components/pricing/modals/compare-modal";
import { DuplicateModal } from "@/components/pricing/modals/duplicate-modal";
import { PriceListEditor, type EditorOpen } from "@/components/pricing/editor/price-list-editor";
import { MenuButton } from "@/components/pricing/menu-button";
import { Icon } from "@/components/pricing/icons";

const MANAGE_TITLE = "Only somebody who manages price lists can do this.";

export function PriceListDetailScreen({
  app,
  basePath,
  canManage,
  todayIso,
  detail,
  options,
}: {
  app: PricingApp;
  basePath: string;
  canManage: boolean;
  todayIso: string;
  detail: Detail;
  options: PricingOptions;
}) {
  const router = useRouter();
  const { run } = useToast();
  const list = detail.list;
  const draft = list.status === "draft";
  const published = list.status === "published";

  const [view, setView] = React.useState<"grid" | "table">("grid");
  const [showIncl, setShowIncl] = React.useState(true);
  const [sort, setSort] = React.useState<SortValue>({ column: "product", direction: "asc" });

  const [editing, setEditing] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState(false);
  const [versioning, setVersioning] = React.useState(false);
  const [revising, setRevising] = React.useState(false);
  const [deriving, setDeriving] = React.useState(false);
  const [comparing, setComparing] = React.useState(false);
  const [pasting, setPasting] = React.useState(false);
  const [rateOpen, setRateOpen] = React.useState<{ rate: RateRow | null; productId: string | null } | null>(null);
  const [scopeOpen, setScopeOpen] = React.useState<{ scope: ScopeView | null } | null>(null);
  const [scopeToRemove, setScopeToRemove] = React.useState<ScopeView | null>(null);
  const [termOpen, setTermOpen] = React.useState<{ id: string | null } | null>(null);
  const [termToRemove, setTermToRemove] = React.useState<string | null>(null);
  const [editor, setEditor] = React.useState<EditorOpen | null>(null);
  const [duplicating, setDuplicating] = React.useState(false);

  const term = termOpen ? detail.discountTerms.find((t) => t.id === termOpen.id) ?? null : null;

  const sortedRates = React.useMemo(() => {
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...detail.rates].sort((a, b) => direction * compareRates(a, b, sort.column));
  }, [detail.rates, sort]);

  async function dropScope(scope: ScopeView) {
    const r = await run(removeScope(scope.id));
    if (r.ok) {
      setScopeToRemove(null);
      router.refresh();
    }
  }

  async function dropTerm(id: string) {
    const r = await run(removeDiscountTerm(id));
    if (r.ok) {
      setTermToRemove(null);
      router.refresh();
    }
  }

  return (
    <div>
      {/* ------------------------------------------------------------ head */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[22px] leading-tight font-semibold text-ink">{list.name}</h1>
            <Badge tone={LIST_STATUS_TONE[list.status]}>{LIST_STATUS_LABEL[list.status]}</Badge>
            <span className="text-[13px] text-muted">Version {list.version}</span>
          </div>
          <p className="mt-1 text-[13px] text-muted">{listSummary(list)}</p>
          <p className="mt-0.5 text-[13px] text-muted">
            In force from {longDate(list.effectiveFrom)}
            {list.expiresOn ? ` · ${list.expired ? "expired" : "expires"} ${longDate(list.expiresOn)}` : " · open ended"}
          </p>
          <p className="mt-0.5 text-[13px] text-muted">{FREIGHT_TERM_HINT[list.freightTerm]}</p>
          {detail.parent && list.derivation ? (
            <p className="mt-1 text-[13px] text-body">
              Derived from{" "}
              <Link href={`${basePath}/${detail.parent.id}`} className="text-brand hover:underline">
                {detail.parent.name}
              </Link>
              : {derivationSentence(list.derivation)}
            </p>
          ) : null}
          {list.supersedesId ? (
            <p className="mt-0.5 text-[13px] text-muted">
              Supersedes{" "}
              <Link href={`${basePath}/${list.supersedesId}`} className="text-brand hover:underline">
                the version before it
              </Link>
              .
            </p>
          ) : null}
          {list.supersededById ? (
            <p className="mt-0.5 text-[13px] text-muted">
              Superseded by{" "}
              <Link href={`${basePath}/${list.supersededById}`} className="text-brand hover:underline">
                a newer version
              </Link>
              .
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <MenuButton
            label="PDF & export"
            width={300}
            items={[
              { key: "open", label: "Open the PDF", description: "In Mahek's own layout, drawn from these rates.", icon: <Icon name="pdf" />, onSelect: () => window.open(`/api/price-lists/${list.id}/pdf`, "_blank", "noopener") },
              { key: "download", label: "Download the PDF", icon: <Icon name="upload" />, onSelect: () => window.location.assign(`/api/price-lists/${list.id}/pdf?download=1`) },
              { key: "csv", label: "Export as a spreadsheet", description: "One row per price; reads back into the editor.", icon: <Icon name="table" />, onSelect: () => window.location.assign(`/api/price-lists/export?format=csv&ids=${list.id}`) },
              { key: "print", label: "Print", icon: <Icon name="doc" />, onSelect: () => router.push(`${basePath}/${list.id}/print`) },
              ...(detail.document?.attachmentId
                ? [{ key: "source", label: "The document it came from", description: detail.document.filename, icon: <Icon name="doc" />, divider: true, onSelect: () => window.open(`/api/attachments/${detail.document!.attachmentId}`, "_blank", "noopener") }]
                : []),
            ]}
          />
          <Button variant="secondary" onClick={() => setComparing(true)}>
            Compare
          </Button>
          {canManage ? (
            <>
              <Button variant="secondary" onClick={() => setDuplicating(true)}>
                Duplicate
              </Button>
              <Button variant="secondary" onClick={() => setEditor({ kind: "edit", listId: list.id })}>
                {draft ? "Open in the editor" : "New version in the editor"}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(true)} title="Name, reference, dates and terms, without opening the editor">
                Edit details
              </Button>
              <RowMenu
                items={[
                  {
                    label: "New version",
                    onSelect: () => setVersioning(true),
                  },
                  {
                    label: "Revise every price",
                    onSelect: () => setRevising(true),
                    disabled: !detail.rates.length,
                    title: detail.rates.length ? undefined : "There are no prices on this list to revise.",
                  },
                  {
                    label: "Derive a list from this one",
                    onSelect: () => setDeriving(true),
                    disabled: !detail.rates.length,
                    title: detail.rates.length ? undefined : "A derived list needs prices to derive from.",
                  },
                  {
                    label: "Withdraw",
                    onSelect: () => setWithdrawing(true),
                    destructive: true,
                    disabled: !published,
                    title: published ? undefined : "Only a list in force can be withdrawn.",
                  },
                ]}
              />
              {draft ? (
                <Button variant="primary" onClick={() => setPublishing(true)}>
                  Publish
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {list.status === "withdrawn" ? (
        <Callout tone="danger">
          This list was withdrawn and prices nothing.
          {list.withdrawReason ? ` The reason given: ${list.withdrawReason}` : " No reason was recorded."}
        </Callout>
      ) : null}
      {list.status === "superseded" ? (
        <Callout tone="warn">
          A newer version has taken over from this one. It is kept because orders
          were taken against it.
        </Callout>
      ) : null}
      {published && list.expired ? (
        <Callout tone="warn">
          This list passed its validity on {longDate(list.expiresOn ?? todayIso)} and is
          still the one shops are priced from. Publish a new version, or extend it.
        </Callout>
      ) : null}
      {draft ? (
        <Callout tone="brand">
          A draft prices nothing. Check the rates and who it applies to, then publish it.
        </Callout>
      ) : null}

      {/* ----------------------------------------------------------- rates */}
      <Card className="mb-4">
        <CardHeader
          title="Rates"
          hint={`${detail.rates.length} price${detail.rates.length === 1 ? "" : "s"}`}
          action={
            <div className="flex items-center gap-2.5">
              <Button variant="ghost" size="sm" onClick={() => setShowIncl((v) => !v)}>
                {showIncl ? "Showing GST inclusive" : "Showing ex-GST"}
              </Button>
              {canManage ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPasting(true)}
                    disabled={!draft}
                    title={draft ? undefined : "Rates can be pasted into a draft. Publish a new version to change a list in force."}
                  >
                    Paste rates
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setRateOpen({ rate: null, productId: null })}>
                    Add rate
                  </Button>
                </>
              ) : null}
            </div>
          }
        />
        <Tabs<"grid" | "table">
          className="px-5"
          value={view}
          onChange={setView}
          tabs={[
            { key: "grid", label: "Grid" },
            { key: "table", label: "Table", count: detail.rates.length },
          ]}
        />
        {detail.rates.length === 0 ? (
          <EmptyState
            title="No prices on this list yet"
            body="Add them one at a time, or paste a column out of the spreadsheet the office already keeps."
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setRateOpen({ rate: null, productId: null })}>
                  Add the first price
                </Button>
              ) : undefined
            }
          />
        ) : view === "grid" ? (
          <div className="overflow-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th className="min-w-[240px]">Product</Th>
                  {detail.grid.columns.map((c) => (
                    <Th key={c.key} align="right">
                      {c.label}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.grid.rows.map((row) => (
                  <Tr key={row.familyKey}>
                    <Td className="max-w-[320px] truncate font-medium text-ink" title={row.family}>
                      {row.family}
                    </Td>
                    {row.cells.map((cell) => (
                      <Td key={cell.column.key} align="right" className="p-0">
                        <button
                          type="button"
                          onClick={() =>
                            setRateOpen({ rate: cell.rate, productId: cell.rate?.productId ?? null })
                          }
                          className={cx(
                            "block h-full w-full cursor-pointer px-3 py-1.5 text-right hover:bg-canvas",
                          )}
                          title={
                            cell.rate
                              ? cell.rate.offered
                                ? cell.rate.productName
                                : `${cell.rate.productName} — listed, not for sale on this list`
                              : "Nothing priced here yet"
                          }
                        >
                          {cell.rate ? (
                            cell.rate.offered ? (
                              <>
                                <span className="block text-sm font-medium text-ink">
                                  {money(showIncl ? cell.rate.rateInclGstPaise : cell.rate.rateExGstPaise)}
                                </span>
                                <span className="block text-[11px] text-muted">
                                  {showIncl
                                    ? `${money(cell.rate.rateExGstPaise)} ex`
                                    : `${money(cell.rate.rateInclGstPaise)} incl`}
                                </span>
                              </>
                            ) : (
                              <span className="block text-sm text-muted">—</span>
                            )
                          ) : (
                            <span className="block text-sm text-line-strong">·</span>
                          )}
                        </button>
                      </Td>
                    ))}
                  </Tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-divider px-5 py-2.5 text-[13px] text-muted">
              A dash is a pack we list and do not sell on this list. A dot is a pack
              nobody has priced.
              {app === "crm"
                ? " Quote the big figure — it is the one the shop is told, GST included."
                : ""}
            </p>
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full border-collapse" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <SortableTh
                    active={sort.column === "product"}
                    direction={sort.direction}
                    onSort={() => setSort((c) => nextSort(c, "product"))}
                  >
                    Product
                  </SortableTh>
                  <Th>Pack</Th>
                  <SortableTh
                    align="right"
                    active={sort.column === "ex"}
                    direction={sort.direction}
                    onSort={() => setSort((c) => nextSort(c, "ex"))}
                  >
                    Ex GST
                  </SortableTh>
                  <SortableTh
                    align="right"
                    active={sort.column === "incl"}
                    direction={sort.direction}
                    onSort={() => setSort((c) => nextSort(c, "incl"))}
                  >
                    Inclusive
                  </SortableTh>
                  <SortableTh
                    align="right"
                    active={sort.column === "perLitre"}
                    direction={sort.direction}
                    onSort={() => setSort((c) => nextSort(c, "perLitre"))}
                  >
                    Per litre
                  </SortableTh>
                  <Th>Slab</Th>
                  <Th>Offered</Th>
                </tr>
              </thead>
              <tbody>
                {sortedRates.map((rate) => (
                  <Tr
                    key={rate.id}
                    className="cursor-pointer hover:bg-canvas"
                    onClick={() => setRateOpen({ rate, productId: rate.productId })}
                  >
                    <Td className="max-w-[320px] truncate" title={rate.productName}>
                      {rate.productName}
                    </Td>
                    <Td className="text-muted">{rate.packing ?? "—"}</Td>
                    <Td align="right">{money(rate.rateExGstPaise)}</Td>
                    <Td align="right">{money(rate.rateInclGstPaise)}</Td>
                    <Td align="right">{rate.perLitrePaise == null ? "—" : money(rate.perLitrePaise)}</Td>
                    <Td className="text-muted">
                      {rate.minCans == null && rate.maxCans == null
                        ? "Flat"
                        : `${rate.minCans ?? 1}–${rate.maxCans ?? "∞"} cans`}
                    </Td>
                    <Td>
                      {rate.offered ? (
                        <Badge tone="success">Yes</Badge>
                      ) : (
                        <Badge tone="muted">Listed, not sold</Badge>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ---------------------------------------------------------- scopes */}
      <Card className="mb-4">
        <CardHeader
          title="Who it applies to"
          hint={`${detail.scopes.length} rule${detail.scopes.length === 1 ? "" : "s"}`}
          action={
            canManage ? (
              <Button variant="secondary" size="sm" onClick={() => setScopeOpen({ scope: null })}>
                Add
              </Button>
            ) : null
          }
        />
        {detail.scopes.length === 0 ? (
          <div className="px-5 py-4">
            <Callout tone="warn" className="mb-0">
              No shop is priced from this list yet. Until somebody is named — a
              state, a city, a salesman or everybody — it prices nothing.
            </Callout>
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full border-collapse" style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <Th>Named by</Th>
                  <Th>Which one</Th>
                  <Th>Under</Th>
                  <Th>Freight</Th>
                  <Th align="right">Priority</Th>
                  <Th>Valid</Th>
                  <Th align="right">Shops</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {detail.scopes.map((scope) => (
                  <Tr key={scope.id}>
                    <Td>{SCOPE_KIND_LABEL[scope.scopeKind]}</Td>
                    <Td className="max-w-[240px] truncate" title={scope.scopeLabel ?? scope.scopeValue}>
                      {scope.scopeKind === "everybody" ? "Everybody" : (scope.scopeLabel ?? scope.scopeValue)}
                    </Td>
                    <Td className="text-muted">{scope.parentLabel ?? "—"}</Td>
                    <Td className="text-muted">
                      {scope.freightTermMatch === "any"
                        ? "Whatever the list says"
                        : scope.freightTermMatch === "to_pay"
                          ? "To Pay only"
                          : "Paid only"}
                    </Td>
                    <Td align="right">{scope.priority}</Td>
                    <Td className="text-muted">
                      {scope.validFrom || scope.validTo
                        ? `${scope.validFrom ? shortDate(scope.validFrom) : "—"} → ${scope.validTo ? shortDate(scope.validTo) : "—"}`
                        : "Always"}
                    </Td>
                    <Td align="right">{scope.customersMatched}</Td>
                    <Td align="right">
                      <RowMenu
                        items={[
                          {
                            label: "Edit",
                            onSelect: () => setScopeOpen({ scope }),
                            disabled: !canManage,
                            title: canManage ? undefined : MANAGE_TITLE,
                          },
                          {
                            label: "Remove",
                            onSelect: () => setScopeToRemove(scope),
                            destructive: true,
                            disabled: !canManage,
                            title: canManage ? undefined : MANAGE_TITLE,
                          },
                        ]}
                      />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* -------------------------------------------------- discount terms */}
      <Card className="mb-4">
        <CardHeader
          title="Discounts on this list"
          hint="Printed under the prices. Not what anybody may knock off on their own."
          action={
            canManage ? (
              <Button variant="secondary" size="sm" onClick={() => setTermOpen({ id: null })}>
                Add
              </Button>
            ) : null
          }
        />
        {detail.discountTerms.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-muted">None recorded on this list.</p>
        ) : (
          <ul className="px-5 py-2">
            {detail.discountTerms.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 border-b border-divider py-2.5 last:border-0">
                <div className="min-w-0">
                  <div className="text-sm text-ink">{t.sentence}</div>
                  {t.rawText ? <div className="text-[13px] text-muted">As printed: {t.rawText}</div> : null}
                </div>
                {canManage ? (
                  <RowMenu
                    items={[
                      { label: "Edit", onSelect: () => setTermOpen({ id: t.id }) },
                      { label: "Remove", onSelect: () => setTermToRemove(t.id), destructive: true },
                    ]}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ------------------------------------------------- source document */}
      {detail.document ? (
        <Card className="mb-4">
          <CardHeader title="Where it came from" />
          <div className="px-5 py-4 text-sm text-body">
            <div className="flex flex-wrap items-center gap-2.5">
              <Link href={`${basePath}/documents/${detail.document.id}`} className="text-brand hover:underline">
                {detail.document.filename}
              </Link>
              {detail.document.confidence != null ? (
                <Badge tone={detail.document.confidence >= 80 ? "success" : "warn"}>
                  {detail.document.confidence}% confident
                </Badge>
              ) : null}
              {detail.document.attachmentId ? (
                <a
                  href={`/api/attachments/${detail.document.attachmentId}`}
                  className="text-[13px] text-brand hover:underline"
                >
                  Open the file
                </a>
              ) : null}
            </div>
            <p className="mt-1 text-[13px] text-muted">
              {detail.document.rowCount} row{detail.document.rowCount === 1 ? "" : "s"} read ·{" "}
              {detail.document.matchedCount} matched · {detail.document.heldCount} held
              {detail.document.uploadedByName ? ` · uploaded by ${detail.document.uploadedByName}` : ""}
            </p>
          </div>
        </Card>
      ) : null}

      {/* -------------------------------------------------------- versions */}
      {detail.versions.length > 1 ? (
        <Card className="mb-4">
          <CardHeader title="Versions" />
          <ul className="px-5 py-2">
            {detail.versions.map((v) => (
              <li key={v.id} className="flex items-center gap-3 border-b border-divider py-2.5 last:border-0">
                <span className="w-16 shrink-0 text-[13px] text-muted">v{v.version}</span>
                {v.id === list.id ? (
                  <span className="text-sm font-medium text-ink">{v.name}</span>
                ) : (
                  <Link href={`${basePath}/${v.id}`} className="text-sm text-brand hover:underline">
                    {v.name}
                  </Link>
                )}
                <Badge tone={LIST_STATUS_TONE[v.status]}>{LIST_STATUS_LABEL[v.status]}</Badge>
                <span className="text-[13px] text-muted">
                  {longDate(v.effectiveFrom)}
                  {v.effectiveTo ? ` → ${longDate(v.effectiveTo)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* --------------------------------------------------- derived lists */}
      {detail.children.length ? (
        <Card className="mb-4">
          <CardHeader title="Lists built on this one" />
          <ul className="px-5 py-2">
            {detail.children.map((child) => (
              <li key={child.id} className="flex items-center gap-3 border-b border-divider py-2.5 last:border-0">
                <Link href={`${basePath}/${child.id}`} className="text-sm text-brand hover:underline">
                  {child.name}
                </Link>
                <Badge tone={LIST_STATUS_TONE[child.status]}>{LIST_STATUS_LABEL[child.status]}</Badge>
                <span className="text-[13px] text-muted">
                  {child.derivation ? derivationSentence(child.derivation) : "No rule recorded"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* --------------------------------------------------- notes & terms */}
      {list.termsText || list.notes || list.signatory ? (
        <Card className="mb-4">
          <CardHeader title="Terms and notes" />
          <div className="space-y-4 px-5 py-4">
            {list.termsText ? (
              <div>
                <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">
                  Terms & conditions
                </div>
                <div className="max-w-[720px] text-[13px] whitespace-pre-wrap text-body">{list.termsText}</div>
              </div>
            ) : null}
            {list.signatory ? (
              <div>
                <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">Signed</div>
                <div className="text-sm text-body">{list.signatory}</div>
              </div>
            ) : null}
            {list.notes ? (
              <div>
                <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">
                  Notes — for the office, never printed
                </div>
                <div className="max-w-[720px] text-[13px] whitespace-pre-wrap text-body">{list.notes}</div>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <p className="text-[13px] text-muted">
        {list.createdByName ? `Created by ${list.createdByName}. ` : ""}
        {list.publishedByName && list.publishedAt
          ? `Published by ${list.publishedByName} on ${longDate(list.publishedAt)}.`
          : ""}
      </p>

      {/* ---------------------------------------------------------- modals */}
      <ListFormModal
        open={editing}
        onClose={() => setEditing(false)}
        list={list}
        options={options}
        todayIso={todayIso}
        basePath={basePath}
      />
      {rateOpen ? (
        <RateModal
          open
          onClose={() => setRateOpen(null)}
          priceListId={list.id}
          gstBp={list.gstBp}
          products={options.products}
          rate={rateOpen.rate}
          presetProductId={rateOpen.productId}
          readOnly={!canManage}
        />
      ) : null}
      <BulkRatesModal
        open={pasting}
        onClose={() => setPasting(false)}
        priceListId={list.id}
        gstBp={list.gstBp}
        products={options.products}
      />
      {scopeOpen ? (
        <ScopeModal
          open
          onClose={() => setScopeOpen(null)}
          priceListId={list.id}
          scope={scopeOpen.scope}
          options={options}
        />
      ) : null}
      {termOpen ? (
        <DiscountTermModal open onClose={() => setTermOpen(null)} priceListId={list.id} term={term} />
      ) : null}
      <PublishModal open={publishing} onClose={() => setPublishing(false)} detail={detail} options={options} />
      <WithdrawModal
        open={withdrawing}
        onClose={() => setWithdrawing(false)}
        listId={list.id}
        listName={list.name}
      />
      <NewVersionModal
        open={versioning}
        onClose={() => setVersioning(false)}
        listId={list.id}
        listName={list.name}
        refNo={list.refNo}
        version={list.version}
        todayIso={todayIso}
        basePath={basePath}
      />
      <BulkReviseModal
        open={revising}
        onClose={() => setRevising(false)}
        detail={detail}
        todayIso={todayIso}
        basePath={basePath}
      />
      <DerivedListModal
        open={deriving}
        onClose={() => setDeriving(false)}
        detail={detail}
        todayIso={todayIso}
        basePath={basePath}
      />
      <CompareModal
        open={comparing}
        onClose={() => setComparing(false)}
        listId={list.id}
        listName={list.name}
        options={options}
      />
      <ConfirmDialog
        open={scopeToRemove !== null}
        title="Take this rule off the list?"
        body={
          scopeToRemove
            ? `${scopeToRemove.customersMatched} shop${scopeToRemove.customersMatched === 1 ? "" : "s"} are priced from this list through it. They fall back to whatever else names them.`
            : ""
        }
        confirmLabel="Remove it"
        destructive
        onConfirm={() => (scopeToRemove ? dropScope(scopeToRemove) : undefined)}
        onClose={() => setScopeToRemove(null)}
      />
      <ConfirmDialog
        open={termToRemove !== null}
        title="Remove this discount?"
        body="It stops being printed under the prices and stops being offered."
        confirmLabel="Remove it"
        destructive
        onConfirm={() => (termToRemove ? dropTerm(termToRemove) : undefined)}
        onClose={() => setTermToRemove(null)}
      />
      <PriceListEditor open={editor} onClose={() => setEditor(null)} app={app} basePath={basePath} options={options} todayIso={todayIso} />
      {duplicating ? (
        <DuplicateModal
          list={{ id: list.id, name: list.name, refNo: list.refNo, rateCount: detail.rates.length, scopeCount: detail.scopes.length }}
          takenNames={options.lists.map((l) => l.name)}
          todayIso={todayIso}
          basePath={basePath}
          onClose={() => setDuplicating(false)}
          onOpenInEditor={() => {
            setDuplicating(false);
            setEditor({ kind: "new", source: "copy", fromListId: list.id });
          }}
        />
      ) : null}
    </div>
  );
}

function compareRates(a: RateRow, b: RateRow, column: string): number {
  switch (column) {
    case "ex":
      return a.rateExGstPaise - b.rateExGstPaise;
    case "incl":
      return a.rateInclGstPaise - b.rateInclGstPaise;
    case "perLitre":
      return (a.perLitrePaise ?? 0) - (b.perLitrePaise ?? 0);
    case "product":
    default:
      return a.productName.localeCompare(b.productName);
  }
}
