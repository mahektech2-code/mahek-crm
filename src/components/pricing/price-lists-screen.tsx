"use client";

/* ---------------------------------------------------------------------------
 * EVERY PRICE LIST MAHEK HAS, and what each one is doing.
 *
 * One screen rendered in four apps. The CRM and the Sales Dashboard READ it —
 * a telecaller quoting a price and a sales manager checking one — and the
 * Accounts desk and the Founder Dashboard also make, change and retire lists
 * from it. What differs is `canManage`, decided by the door (see
 * `priceListDoorCanManage`), and where the links lead.
 *
 * THE COLUMN THAT MATTERS MOST IS "APPLIES TO". A published list with nothing
 * in it prices nobody and looks exactly like one that is working — the whole
 * failure mode of this module — so it is on the row rather than behind a
 * click, and a list naming nobody says so in words.
 *
 * EVERYTHING THAT CHANGES A LIST HAS A BULK FORM. Lists arrive a month at a
 * time, thirty at once, so creating (the import workbench), exporting (CSV or
 * one PDF of many), publishing drafts and deleting drafts all work on a
 * selection as well as on one row.
 *
 * EXPIRED IS DRAWN, NOT COMPUTED HERE. `expiresOn` and `expired` come off the
 * service; `todayIso` arrives as a prop because a component may not read the
 * clock during render.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  MetricStrip,
  PageHeader,
  Select,
  SortableTh,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { ConfirmDialog, FilterPills, RowMenu, SelectionBar, type MenuItem } from "@/components/ui/overlays";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { MenuButton } from "@/components/pricing/menu-button";
import type { PriceListSummary, PricingApp, PricingCounts, PricingOptions } from "@/lib/price-list-views";
import type { PriceFreightTerm } from "@/db/schema";
import { FREIGHT_TERM_LABEL, LIST_STATUS_LABEL, LIST_STATUS_TONE } from "@/lib/price-list-labels";
import { deleteDraftPriceList } from "@/lib/actions/price-lists";
import { deleteDraftPriceLists, publishDraftPriceLists, type BulkOutcome } from "@/lib/actions/price-sheets";
import { longDate, shortDate } from "@/lib/format";
import { nextSort, type SortValue } from "@/lib/sort-param";
import { ListFormModal } from "@/components/pricing/modals/list-form-modal";
import { CompareModal } from "@/components/pricing/modals/compare-modal";
import { NewVersionModal } from "@/components/pricing/modals/new-version-modal";
import { WithdrawModal } from "@/components/pricing/modals/withdraw-modal";
import { ResolutionPreviewModal } from "@/components/pricing/modals/resolution-preview-modal";
import { DuplicateModal } from "@/components/pricing/modals/duplicate-modal";
import { ImportModal } from "@/components/pricing/modals/import-modal";
import { PriceListEditor, type EditorOpen } from "@/components/pricing/editor/price-list-editor";
import { derivationSentence } from "@/components/pricing/derivation";
import { Icon } from "@/components/pricing/icons";

type StatusFilter = "all" | "published" | "draft" | "superseded" | "withdrawn" | "attention";

/** Days between two ISO dates, with no clock read. */
function daysBetween(fromIso: string, toIso: string): number {
  const [a, b] = [fromIso, toIso].map((d) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))));
  return Math.round((b - a) / 86_400_000);
}

const EXPIRING_DAYS = 7;

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
  const search = useSearchParams();
  const { run } = useToast();
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [freight, setFreight] = React.useState<"all" | PriceFreightTerm>("all");
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<"table" | "cards">("table");
  const [sort, setSort] = React.useState<SortValue>({ column: "effective", direction: "desc" });
  const [ticked, setTicked] = React.useState<Set<string>>(new Set());

  const [creating, setCreating] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [importing, setImporting] = React.useState(canManage && search.get("import") === "1");
  const [importKey, setImportKey] = React.useState(0);
  const [editor, setEditor] = React.useState<EditorOpen | null>(null);
  const [duplicating, setDuplicating] = React.useState<PriceListSummary | null>(null);
  const [comparing, setComparing] = React.useState<PriceListSummary | null>(null);
  const [versioning, setVersioning] = React.useState<PriceListSummary | null>(null);
  const [withdrawing, setWithdrawing] = React.useState<PriceListSummary | null>(null);
  const [deleting, setDeleting] = React.useState<PriceListSummary | null>(null);
  const [bulk, setBulk] = React.useState<"publish" | "delete" | null>(null);
  const [outcomes, setOutcomes] = React.useState<{ title: string; rows: BulkOutcome[] } | null>(null);

  const expiringSoon = React.useCallback(
    (l: PriceListSummary) => l.status === "published" && !l.expired && !!l.expiresOn && daysBetween(todayIso, l.expiresOn) <= EXPIRING_DAYS,
    [todayIso],
  );
  const needsAttention = React.useCallback(
    (l: PriceListSummary) => l.expired || expiringSoon(l) || (l.status === "published" && !l.scopeCount) || (l.status === "draft" && !l.rateCount),
    [expiringSoon],
  );

  const counted = React.useMemo(() => {
    const by: Record<string, number> = {};
    for (const l of lists) {
      by[l.status] = (by[l.status] ?? 0) + 1;
      if (needsAttention(l)) by.attention = (by.attention ?? 0) + 1;
    }
    return by;
  }, [lists, needsAttention]);

  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = lists.filter((l) => {
      if (status === "attention" ? !needsAttention(l) : status !== "all" && l.status !== status) return false;
      if (freight !== "all" && l.freightTerm !== freight) return false;
      if (!q) return true;
      return l.name.toLowerCase().includes(q) || (l.refNo ?? "").toLowerCase().includes(q) || l.scopeSummary.toLowerCase().includes(q);
    });
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => direction * compare(a, b, sort.column));
  }, [lists, status, freight, query, sort, needsAttention]);

  const tickedLists = lists.filter((l) => ticked.has(l.id));
  const tickedDrafts = tickedLists.filter((l) => l.status === "draft");
  const allTicked = shown.length > 0 && shown.every((l) => ticked.has(l.id));

  function toggle(column: string) {
    setSort((current) => nextSort(current, column));
  }

  function tick(id: string) {
    setTicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function exportIds(ids: string[], format: "csv" | "pdf") {
    if (!ids.length) return;
    const a = document.createElement("a");
    a.href = `/api/price-lists/export?format=${format}&ids=${encodeURIComponent(ids.join(","))}`;
    a.click();
  }

  async function removeDraft(list: PriceListSummary) {
    const r = await run(deleteDraftPriceList(list.id));
    if (r.ok) {
      setDeleting(null);
      router.refresh();
    }
  }

  async function runBulk(kind: "publish" | "delete") {
    const ids = tickedDrafts.map((l) => l.id);
    setBulk(null);
    const r = await run(kind === "publish" ? publishDraftPriceLists(ids) : deleteDraftPriceLists(ids));
    if (r.ok) {
      setOutcomes({ title: kind === "publish" ? "Publishing the drafts" : "Deleting the drafts", rows: r.data.outcomes });
      setTicked(new Set());
      router.refresh();
    }
  }

  function openImport() {
    setImportKey((k) => k + 1);
    setImporting(true);
  }

  const menuFor = (list: PriceListSummary): MenuItem[] => [
    { label: "Open", onSelect: () => router.push(`${basePath}/${list.id}`) },
    ...(canManage
      ? [
          { label: list.status === "draft" ? "Edit in the editor" : "New version in the editor", onSelect: () => setEditor({ kind: "edit", listId: list.id }) },
          { label: "Duplicate…", onSelect: () => setDuplicating(list) },
          { label: "Derive a new list from this…", onSelect: () => setEditor({ kind: "new", source: "derive", fromListId: list.id }) },
        ]
      : []),
    { label: "Download PDF", onSelect: () => window.location.assign(`/api/price-lists/${list.id}/pdf?download=1`) },
    { label: "Open PDF in a tab", onSelect: () => window.open(`/api/price-lists/${list.id}/pdf`, "_blank", "noopener") },
    { label: "Export CSV", onSelect: () => exportIds([list.id], "csv") },
    { label: "Print", onSelect: () => router.push(`${basePath}/${list.id}/print`) },
    { label: "Compare with…", onSelect: () => setComparing(list) },
    ...(canManage
      ? [
          { label: "Quick new version (dates only)", onSelect: () => setVersioning(list) },
          {
            label: "Withdraw",
            onSelect: () => setWithdrawing(list),
            destructive: true,
            disabled: list.status !== "published",
            title: list.status !== "published" ? "Only a list in force can be withdrawn." : undefined,
          },
          {
            label: "Delete",
            onSelect: () => setDeleting(list),
            destructive: true,
            disabled: list.status !== "draft",
            title: list.status !== "draft" ? "A published list is withdrawn, never deleted — orders were taken against it." : undefined,
          },
        ]
      : []),
  ];

  return (
    <div>
      <PageHeader
        title="Price lists"
        subtitle={
          canManage
            ? "Make, import, publish and retire Mahek's price lists — and say who each one prices."
            : app === "crm"
              ? "What each shop pays, so a figure quoted on a call is one somebody can stand behind."
              : "What each shop pays, where it came from, and who it applies to."
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setPreviewing(true)}>
              Which list applies?
            </Button>
            <MenuButton
              label="Export"
              width={310}
              items={[
                {
                  key: "csv",
                  label: `Spreadsheet of the ${shown.length} shown`,
                  description: "One CSV, one row per price. Reads straight back into the editor.",
                  icon: <Icon name="table" />,
                  disabled: !shown.length,
                  onSelect: () => exportIds(shown.map((l) => l.id), "csv"),
                },
                {
                  key: "pdf",
                  label: `PDF of the ${shown.length} shown`,
                  description: "Every list in Mahek's own layout, one after another, in one file.",
                  icon: <Icon name="pdf" />,
                  disabled: !shown.length,
                  onSelect: () => exportIds(shown.map((l) => l.id), "pdf"),
                },
              ]}
            />
            {canManage ? (
              <MenuButton
                label="Create price list"
                variant="primary"
                width={360}
                items={[
                  {
                    key: "import",
                    label: "Import PDFs",
                    description: "One file or a folder of thirty. Read in parallel, checked and approved in one place.",
                    icon: <Icon name="upload" />,
                    onSelect: openImport,
                  },
                  {
                    key: "blank",
                    label: "Build from scratch",
                    description: "The editor: pick product lines, type prices into the grid, preview the PDF.",
                    icon: <Icon name="grid" />,
                    divider: true,
                    onSelect: () => setEditor({ kind: "new", source: "blank" }),
                  },
                  {
                    key: "catalogue",
                    label: "From every active product",
                    description: "The whole catalogue laid out as a grid, waiting for prices.",
                    icon: <Icon name="list" />,
                    onSelect: () => setEditor({ kind: "new", source: "catalogue" }),
                  },
                  {
                    key: "copy",
                    label: "Copy an existing list",
                    description: "Every price, clause and discount — then change what has moved.",
                    icon: <Icon name="copy" />,
                    onSelect: () => setEditor({ kind: "new", source: "copy" }),
                  },
                  {
                    key: "derive",
                    label: "Derive from a list by a rule",
                    description: "+₹12 a litre, +4%, +₹200 a can. How Odisha Paid comes from Odisha To Pay.",
                    icon: <Icon name="derive" />,
                    onSelect: () => setEditor({ kind: "new", source: "derive" }),
                  },
                  {
                    key: "csv",
                    label: "From a spreadsheet",
                    description: "A CSV with a product and a price per row.",
                    icon: <Icon name="table" />,
                    onSelect: () => setEditor({ kind: "new", source: "csv" }),
                  },
                  {
                    key: "empty",
                    label: "Empty draft, details only",
                    description: "Name and dates now; rates later on the list's own page.",
                    icon: <Icon name="doc" />,
                    divider: true,
                    onSelect: () => setCreating(true),
                  },
                ]}
              />
            ) : null}
          </>
        }
      />

      <div className="mb-4">
        <MetricStrip
          metrics={[
            { label: "In force", value: String(counts.published) },
            { label: "Drafts", value: String(counts.drafts) },
            { label: "Expiring in a week", value: String(lists.filter(expiringSoon).length), tone: lists.some(expiringSoon) ? "danger" : "ink" },
            { label: "Files waiting", value: String(counts.documentsWaiting), tone: counts.documentsWaiting ? "danger" : "ink" },
            { label: "Price requests", value: String(counts.requestsPending), tone: counts.requestsPending ? "danger" : "ink" },
          ]}
        />
      </div>

      <PricingSubNav basePath={basePath} current="lists" />

      {!canManage ? (
        <div className="mb-3.5 flex items-center gap-2 rounded-[6px] border border-line bg-canvas px-3 py-2 text-[13px] text-muted">
          <Icon name="lock" />
          <span>Read-only here. Every list can be opened, compared, printed and exported; the Accounts desk and the Founder Dashboard make and change them.</span>
        </div>
      ) : null}

      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <FilterPills<StatusFilter>
          value={status}
          onChange={setStatus}
          options={[
            { key: "all", label: "All", count: lists.length },
            { key: "published", label: "In force", count: counted.published ?? 0 },
            { key: "draft", label: "Drafts", count: counted.draft ?? 0 },
            { key: "attention", label: "Needs attention", count: counted.attention ?? 0 },
            { key: "superseded", label: "Superseded", count: counted.superseded ?? 0 },
            { key: "withdrawn", label: "Withdrawn", count: counted.withdrawn ?? 0 },
          ]}
        />
        <div className="ml-auto flex flex-none items-center gap-2">
          <Select value={freight} onChange={(e) => setFreight(e.target.value as typeof freight)}>
            <option value="all">Any transport term</option>
            <option value="paid">{FREIGHT_TERM_LABEL.paid}</option>
            <option value="to_pay">{FREIGHT_TERM_LABEL.to_pay}</option>
            <option value="not_stated">{FREIGHT_TERM_LABEL.not_stated}</option>
          </Select>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, ref or who it prices" className="w-[240px]" />
          <div className="flex overflow-hidden rounded-[4px] border border-line">
            {(["table", "cards"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                title={v === "table" ? "Table" : "Cards"}
                aria-pressed={view === v}
                className={cx("flex h-8.5 w-9 cursor-pointer items-center justify-center", view === v ? "bg-brand-soft text-brand" : "bg-surface text-muted hover:bg-canvas")}
              >
                <Icon name={v === "table" ? "list" : "grid"} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {lists.length === 0 ? (
        <Card>
          <EmptyState
            title="No price lists yet"
            body={
              canManage
                ? "A list usually starts as the PDF the office already sends out — import a folder of them and each is read, checked and approved in one place. Or build one here and its PDF is drawn for you."
                : "None has been issued yet. The Accounts desk publishes them, and they appear here the moment they do."
            }
            action={
              canManage ? (
                <>
                  <Button variant="primary" onClick={openImport}>
                    Import PDFs
                  </Button>
                  <Button variant="secondary" onClick={() => setEditor({ kind: "new", source: "blank" })}>
                    Build one
                  </Button>
                </>
              ) : undefined
            }
          />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState title="Nothing matches" body="No list here answers to that filter, name, reference or scope." />
        </Card>
      ) : view === "cards" ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((list) => (
            <ListCard
              key={list.id}
              list={list}
              basePath={basePath}
              ticked={ticked.has(list.id)}
              onTick={() => tick(list.id)}
              expiring={expiringSoon(list)}
              todayIso={todayIso}
              menu={menuFor(list)}
            />
          ))}
        </div>
      ) : (
        <Card className="overflow-auto">
          <table className="w-full border-collapse" style={{ minWidth: 1180 }}>
            <thead>
              <tr>
                <Th className="w-9">
                  <input
                    type="checkbox"
                    aria-label="Tick every list shown"
                    className="h-[15px] w-[15px] accent-[#6835FB]"
                    checked={allTicked}
                    onChange={() => setTicked(allTicked ? new Set() : new Set(shown.map((l) => l.id)))}
                  />
                </Th>
                <SortableTh active={sort.column === "name"} direction={sort.direction} onSort={() => toggle("name")}>
                  List
                </SortableTh>
                <SortableTh active={sort.column === "status"} direction={sort.direction} onSort={() => toggle("status")}>
                  Status
                </SortableTh>
                <SortableTh active={sort.column === "effective"} direction={sort.direction} onSort={() => toggle("effective")}>
                  In force
                </SortableTh>
                <Th>Transport</Th>
                <Th>Applies to</Th>
                <SortableTh align="right" active={sort.column === "rates"} direction={sort.direction} onSort={() => toggle("rates")}>
                  Prices
                </SortableTh>
                <SortableTh active={sort.column === "updated"} direction={sort.direction} onSort={() => toggle("updated")}>
                  Updated
                </SortableTh>
                <Th />
              </tr>
            </thead>
            <tbody>
              {shown.map((list) => (
                <Tr key={list.id}>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Tick ${list.name}`}
                      className="h-[15px] w-[15px] accent-[#6835FB]"
                      checked={ticked.has(list.id)}
                      onChange={() => tick(list.id)}
                    />
                  </Td>
                  <Td className="max-w-[340px]">
                    <Link href={`${basePath}/${list.id}`} className="block truncate font-medium text-ink hover:text-brand hover:underline" title={list.name}>
                      {list.name}
                    </Link>
                    <div className="truncate text-[12px] text-muted">
                      {[
                        list.refNo ? `Ref ${list.refNo}` : null,
                        `v${list.version}`,
                        list.parentListName && list.derivation ? `from ${list.parentListName}, ${derivationSentence(list.derivation)}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge tone={LIST_STATUS_TONE[list.status]}>{LIST_STATUS_LABEL[list.status]}</Badge>
                      {list.expired ? (
                        <Badge tone="danger" title={`Expired on ${longDate(list.expiresOn)}`}>
                          expired
                        </Badge>
                      ) : expiringSoon(list) ? (
                        <Badge tone="warn">expires in {daysBetween(todayIso, list.expiresOn!)}d</Badge>
                      ) : null}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {shortDate(list.effectiveFrom)}
                    <span className="text-muted"> → {list.expiresOn ? shortDate(list.expiresOn) : "open"}</span>
                  </Td>
                  <Td className="text-muted">{FREIGHT_TERM_LABEL[list.freightTerm]}</Td>
                  <Td className="max-w-[240px] truncate" title={list.scopeSummary}>
                    {list.scopeCount ? list.scopeSummary : <span className="text-warn-ink">Nobody — prices no shop</span>}
                  </Td>
                  <Td align="right">{list.rateCount || <span className="text-warn-ink">0</span>}</Td>
                  <Td className="text-muted">{shortDate(list.updatedAt)}</Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-1">
                      <a
                        href={`/api/price-lists/${list.id}/pdf`}
                        target="_blank"
                        rel="noreferrer"
                        title="Open the PDF"
                        className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-canvas hover:text-ink"
                      >
                        <Icon name="pdf" />
                      </a>
                      {canManage ? (
                        <button
                          type="button"
                          title={list.status === "draft" ? "Edit in the editor" : "New version in the editor"}
                          onClick={() => setEditor({ kind: "edit", listId: list.id })}
                          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted hover:bg-canvas hover:text-ink"
                        >
                          <Icon name="edit" />
                        </button>
                      ) : null}
                      <RowMenu items={menuFor(list)} />
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <SelectionBar count={ticked.size} onClear={() => setTicked(new Set())}>
        <button type="button" className="cursor-pointer text-[13px] hover:underline" onClick={() => exportIds([...ticked], "csv")}>
          Export CSV
        </button>
        <button type="button" className="cursor-pointer text-[13px] hover:underline" onClick={() => exportIds([...ticked], "pdf")}>
          Export PDF
        </button>
        {canManage && tickedDrafts.length ? (
          <>
            <button type="button" className="cursor-pointer text-[13px] font-medium hover:underline" onClick={() => setBulk("publish")}>
              Publish {tickedDrafts.length} draft{tickedDrafts.length === 1 ? "" : "s"}
            </button>
            <button type="button" className="cursor-pointer text-[13px] text-[#ffb4b4] hover:underline" onClick={() => setBulk("delete")}>
              Delete {tickedDrafts.length} draft{tickedDrafts.length === 1 ? "" : "s"}
            </button>
          </>
        ) : null}
      </SelectionBar>

      <ListFormModal open={creating} onClose={() => setCreating(false)} list={null} options={options} todayIso={todayIso} basePath={basePath} />
      <ResolutionPreviewModal open={previewing} onClose={() => setPreviewing(false)} basePath={basePath} />
      <ImportModal open={importing} openKey={importKey} basePath={basePath} todayIso={todayIso} onClose={() => setImporting(false)} />
      <PriceListEditor open={editor} onClose={() => setEditor(null)} app={app} basePath={basePath} options={options} todayIso={todayIso} />
      {duplicating ? (
        <DuplicateModal
          list={duplicating}
          takenNames={lists.map((l) => l.name)}
          todayIso={todayIso}
          basePath={basePath}
          onClose={() => setDuplicating(null)}
          onOpenInEditor={() => {
            const id = duplicating.id;
            setDuplicating(null);
            setEditor({ kind: "new", source: "copy", fromListId: id });
          }}
        />
      ) : null}
      {comparing ? <CompareModal open onClose={() => setComparing(null)} listId={comparing.id} listName={comparing.name} options={options} /> : null}
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
      {withdrawing ? <WithdrawModal open onClose={() => setWithdrawing(null)} listId={withdrawing.id} listName={withdrawing.name} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? ""}?`}
        body="A draft has never priced anything, so this really does delete it — the rates, the scopes and the discount terms go with it."
        confirmLabel="Delete the draft"
        destructive
        onConfirm={() => (deleting ? removeDraft(deleting) : undefined)}
        onClose={() => setDeleting(null)}
      />
      <ConfirmDialog
        open={bulk !== null}
        title={bulk === "publish" ? `Publish ${tickedDrafts.length} draft${tickedDrafts.length === 1 ? "" : "s"}?` : `Delete ${tickedDrafts.length} draft${tickedDrafts.length === 1 ? "" : "s"}?`}
        body={
          bulk === "publish"
            ? `Each goes into force through the same checks as publishing it alone: ${tickedDrafts.map((l) => l.name).join(", ")}. Anything else ticked is left alone.`
            : `A draft has never priced anything, so these really are deleted: ${tickedDrafts.map((l) => l.name).join(", ")}. Published lists that are ticked are left alone.`
        }
        confirmLabel={bulk === "publish" ? "Publish them" : "Delete them"}
        destructive={bulk === "delete"}
        onConfirm={() => (bulk ? runBulk(bulk) : undefined)}
        onClose={() => setBulk(null)}
      />
      {outcomes ? (
        <Modal
          open
          onClose={() => setOutcomes(null)}
          title={outcomes.title}
          width={560}
          footer={
            <Button variant="primary" onClick={() => setOutcomes(null)}>
              Done
            </Button>
          }
        >
          <ul className="divide-y divide-divider">
            {outcomes.rows.map((o) => (
              <li key={o.id} className="flex items-start gap-3 py-2">
                <Badge tone={o.ok ? "success" : "danger"}>{o.ok ? "Done" : "Not done"}</Badge>
                <span className="text-[13px]">
                  <span className="font-medium text-ink">{o.name}</span>
                  <span className="text-muted"> — {o.message}</span>
                </span>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </div>
  );
}

function ListCard({
  list,
  basePath,
  ticked,
  onTick,
  expiring,
  todayIso,
  menu,
}: {
  list: PriceListSummary;
  basePath: string;
  ticked: boolean;
  onTick: () => void;
  expiring: boolean;
  todayIso: string;
  menu: MenuItem[];
}) {
  return (
    <div className={cx("flex flex-col rounded-[8px] border bg-surface p-4", ticked ? "border-brand" : "border-line")}>
      <div className="flex items-start gap-2">
        <input type="checkbox" aria-label={`Tick ${list.name}`} className="mt-1 h-[15px] w-[15px] accent-[#6835FB]" checked={ticked} onChange={onTick} />
        <div className="min-w-0 flex-1">
          <Link href={`${basePath}/${list.id}`} className="block truncate text-[15px] font-semibold text-ink hover:text-brand" title={list.name}>
            {list.name}
          </Link>
          <div className="text-[12px] text-muted">{[list.refNo ? `Ref ${list.refNo}` : null, `v${list.version}`].filter(Boolean).join(" · ")}</div>
        </div>
        <RowMenu items={menu} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        <Badge tone={LIST_STATUS_TONE[list.status]}>{LIST_STATUS_LABEL[list.status]}</Badge>
        {list.expired ? <Badge tone="danger">expired</Badge> : expiring ? <Badge tone="warn">expires in {daysBetween(todayIso, list.expiresOn!)}d</Badge> : null}
        <Badge tone="muted">{FREIGHT_TERM_LABEL[list.freightTerm]}</Badge>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-y-1.5 text-[12.5px]">
        <dt className="text-muted">In force</dt>
        <dd className="text-right text-body">
          {shortDate(list.effectiveFrom)} → {list.expiresOn ? shortDate(list.expiresOn) : "open"}
        </dd>
        <dt className="text-muted">Prices</dt>
        <dd className="text-right text-body">{list.rateCount}</dd>
        <dt className="text-muted">Applies to</dt>
        <dd className={cx("truncate text-right", list.scopeCount ? "text-body" : "text-warn-ink")} title={list.scopeSummary}>
          {list.scopeCount ? list.scopeSummary : "Nobody"}
        </dd>
      </dl>
      <div className="mt-auto flex gap-2 pt-3">
        <Link href={`${basePath}/${list.id}`} className="flex-1">
          <Button size="sm" variant="secondary" className="w-full">
            Open
          </Button>
        </Link>
        <a href={`/api/price-lists/${list.id}/pdf`} target="_blank" rel="noreferrer" className="flex-1">
          <Button size="sm" variant="ghost" className="w-full">
            PDF
          </Button>
        </a>
      </div>
      <div className="mt-2 text-[11px] text-muted">Updated {shortDate(list.updatedAt)}</div>
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
