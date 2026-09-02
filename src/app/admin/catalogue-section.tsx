"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Callout,
  EmptyState,
  Field,
  Input,
  Select,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { describeQuantity } from "@/lib/catalogue";
import {
  addAlias,
  chooseCanonicalId,
  createCategory,
  moveCategory,
  nameHeldRow,
  removeAlias,
  renameLevel,
  runCatalogueImport,
  setLevelActive,
  setSkuActive,
  updateSku,
} from "@/lib/actions/catalogue";
import { pinnedCell, pinnedHead } from "@/components/ui/pinned";
import type { CatalogueData } from "./catalogue-data";

/* ---------------------------------------------------------------------------
 * The Catalogue section.
 *
 * Four levels, and the console shows all four because they answer different
 * questions. "What can be ordered" is the SKU list. "What do we make" is the
 * formulation list. The two in between are how one liquid reaches a customer
 * under three different names.
 *
 * Everything here reads the database. The console holds no copy of the
 * catalogue, exactly as it holds no copy of the configuration — the document
 * this was seeded from is a starting point, and the tables are what is true.
 * ------------------------------------------------------------------------- */

export const CATALOGUE_TABS = [
  { slug: "skus", label: "All SKUs" },
  { slug: "goods", label: "Finished goods" },
  { slug: "brands", label: "Brands & formulations" },
  { slug: "categories", label: "Categories" },
  { slug: "duplicates", label: "Duplicates" },
  { slug: "exceptions", label: "Held & excluded" },
  { slug: "import", label: "Import" },
] as const;

export const CATALOGUE_SUBTITLE =
  "Formulation, brand, finished good and SKU. An order line attaches to a SKU and to nothing else.";

/** Paise → "₹46.00", and an em dash where there is no number at all. */
function money(paise: number | null | undefined): string {
  if (paise == null) return "—";
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function kg(grams: number | null): string {
  if (grams == null) return "—";
  return `${Number((grams / 1000).toFixed(2))} kg`;
}

function litres(ml: number | null): string {
  if (ml == null) return "—";
  return `${Number((ml / 1000).toFixed(2))} L`;
}

/**
 * Runs an action, says what it said, and re-reads the server data.
 *
 * `skipRefresh` is for an action that changed nothing — a dry run reports what
 * WOULD happen, and re-reading would throw the report away to show the same
 * numbers back.
 */
function useAction(refresh: () => void) {
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  return {
    busy,
    run: async <T,>(
      fn: () => Promise<{ ok: boolean; message?: string; error?: string; data?: T }>,
      opts: { skipRefresh?: boolean } = {},
    ) => {
      setBusy(true);
      try {
        const result = await fn();
        if (result.ok) {
          if (result.message) toast.push(result.message);
          if (!opts.skipRefresh) refresh();
        } else {
          toast.push(result.error ?? "That did not work.");
        }
        return result;
      } finally {
        setBusy(false);
      }
    },
  };
}

export function CatalogueSection({
  tab,
  data,
  canWrite,
  refresh,
}: {
  tab: number;
  data: CatalogueData;
  canWrite: boolean;
  refresh: () => void;
}) {
  const slug = CATALOGUE_TABS[Math.min(tab, CATALOGUE_TABS.length - 1)].slug;

  return (
    <div className="mt-5">
      <Summary data={data} />
      {data.summary.unresolved > 0 && slug !== "duplicates" ? (
        <Callout tone="warn">
          <span className="text-sm text-ink">
            {data.summary.unresolved} SKU names carry more than one legacy Product ID. Until one is
            chosen per name they cannot be ordered — an order line references the name, so the wrong
            choice silently reassigns history.
          </span>
        </Callout>
      ) : null}
      {data.priceSource === "unset" ? (
        <Callout tone="brand">
          <span className="text-sm text-ink">
            Order value is not computed from the catalogue: no price source is confirmed yet. Orders
            are worth what the telecaller typed. Set{" "}
            <span className="font-medium">Where a line&rsquo;s price comes from</span> in CRM →
            Products once that is decided.
          </span>
        </Callout>
      ) : null}

      {slug === "skus" ? <SkuTab data={data} canWrite={canWrite} refresh={refresh} /> : null}
      {slug === "goods" ? <GoodsTab data={data} canWrite={canWrite} refresh={refresh} /> : null}
      {slug === "brands" ? <BrandsTab data={data} canWrite={canWrite} refresh={refresh} /> : null}
      {slug === "categories" ? (
        <CategoriesTab data={data} canWrite={canWrite} refresh={refresh} />
      ) : null}
      {slug === "duplicates" ? <DuplicatesTab data={data} canWrite={canWrite} refresh={refresh} /> : null}
      {slug === "exceptions" ? <ExceptionsTab data={data} canWrite={canWrite} refresh={refresh} /> : null}
      {slug === "import" ? <ImportTab data={data} canWrite={canWrite} refresh={refresh} /> : null}
    </div>
  );
}

function Summary({ data }: { data: CatalogueData }) {
  const s = data.summary;
  const cells: Array<[string, string, string?]> = [
    ["Formulations", String(s.formulations)],
    ["Brand lines", String(s.brands)],
    ["Finished goods", String(s.goods)],
    ["SKUs", String(s.skus)],
    ["Orderable", `${s.orderable}`, s.orderable < s.skus ? `${s.skus - s.orderable} not` : undefined],
    ["Priced", `${s.priced}`, s.priced === 0 ? "no price source yet" : undefined],
  ];
  return (
    <div className="mb-4 grid grid-cols-6 gap-px overflow-hidden rounded-[4px] border border-line bg-line">
      {cells.map(([label, value, note]) => (
        <div key={label} className="bg-surface px-3.5 py-2.5">
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
          <div className="mt-0.5 text-[19px] leading-6 font-semibold text-ink">{value}</div>
          {note ? <div className="text-[11px] text-muted">{note}</div> : null}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- all SKUs */

function SkuTab({
  data,
  canWrite,
  refresh,
}: {
  data: CatalogueData;
  canWrite: boolean;
  refresh: () => void;
}) {
  const [query, setQuery] = React.useState(data.filters.query ?? "");
  const [openId, setOpenId] = React.useState<string | null>(null);

  // Filtering is done on the server, so the page reloads with the address as
  // the filter — a filtered list is a screen somebody can send to somebody else.
  function apply(next: Partial<{ q: string; formulation: string; status: string }>) {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(next)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    params.delete("page");
    window.location.search = params.toString();
  }

  const open = data.skus.find((s) => s.id === openId) ?? null;


  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Search" className="w-72">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") apply({ q: query });
            }}
            placeholder="Name, raw name or legacy ID"
          />
        </Field>
        <Field label="Formulation" className="w-56">
          <Select
            value={data.filters.formulationId ?? ""}
            onChange={(e) => apply({ formulation: e.target.value })}
          >
            <option value="">All formulations</option>
            {data.hierarchy.formulations.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status" className="w-52">
          <Select
            value={data.filters.status ?? "all"}
            onChange={(e) => apply({ status: e.target.value })}
          >
            <option value="all">Everything</option>
            <option value="ok">Orderable</option>
            <option value="needs_canonical_id">Needs a canonical ID</option>
            <option value="inactive">Retired</option>
          </Select>
        </Field>
        <Button variant="secondary" onClick={() => apply({ q: query })}>
          Apply
        </Button>
        <span className="flex-1" />
        <span className="pb-1.5 text-[13px] text-muted">
          {data.total} matching · showing {data.skus.length}
        </span>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto" style={{ ["--rowh" as string]: "44px" }}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th className={pinnedHead("left")}>SKU</Th>
                <Th>Formulation</Th>
                <Th>Brand</Th>
                <Th>Packing</Th>
                <Th align="right">Can</Th>
                <Th align="right">Cans/box</Th>
                <Th align="right">Packing cost</Th>
                <Th align="right">Weight</Th>
                <Th align="right">Price</Th>
                <Th align="right">Ordered</Th>
                <Th>Legacy</Th>
                <Th className={pinnedHead("right")} align="right">
                  {""}
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.skus.map((s, i) => (
                <Tr key={s.id}>
                  <Td className={pinnedCell("left", i, openId === s.id)}>
                    <span className="block max-w-[380px] truncate font-medium text-ink">{s.name}</span>
                    {!s.active || s.status !== "ok" ? (
                      <span className="text-[11px] text-warn-ink">
                        {s.status === "needs_canonical_id" ? "needs a canonical ID" : "retired"}
                      </span>
                    ) : null}
                  </Td>
                  <Td>{s.formulation ?? "—"}</Td>
                  <Td>{s.brand ?? "—"}</Td>
                  <Td>{s.packing ?? "—"}</Td>
                  <Td align="right">{litres(s.millilitresPerCan)}</Td>
                  <Td align="right">{s.cansPerBox > 1 ? s.cansPerBox : "loose"}</Td>
                  <Td align="right">{money(s.packingCostPaise)}</Td>
                  <Td align="right">
                    {kg(s.weightGrams)}
                    <span className="ml-1 text-[11px] text-muted">/{s.weightBasis}</span>
                  </Td>
                  <Td align="right">
                    {s.sellingPricePaise == null ? (
                      <span className="text-muted" title="No price source is confirmed yet">
                        —
                      </span>
                    ) : (
                      money(s.sellingPricePaise)
                    )}
                  </Td>
                  <Td align="right">{s.timesOrdered || "—"}</Td>
                  <Td>{s.externalCode ?? ((s.externalIds ?? []).join(", ") || "—")}</Td>
                  <Td className={pinnedCell("right", i, openId === s.id)} align="right">
                    <Button variant="ghost" onClick={() => setOpenId(s.id === openId ? null : s.id)}>
                      {openId === s.id ? "Close" : "Open"}
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
          {data.skus.length === 0 ? (
            <EmptyState
              title="No SKU matches that"
              body="Try the formulation name, part of the pack size, or a legacy Product ID."
            />
          ) : null}
        </div>
      </Card>

      {data.pages > 1 ? (
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="secondary"
            disabled={data.page <= 1}
            onClick={() => {
              const p = new URLSearchParams(window.location.search);
              p.set("page", String(data.page - 1));
              window.location.search = p.toString();
            }}
          >
            Previous
          </Button>
          <span className="text-[13px] text-muted">
            Page {data.page} of {data.pages}
          </span>
          <Button
            variant="secondary"
            disabled={data.page >= data.pages}
            onClick={() => {
              const p = new URLSearchParams(window.location.search);
              p.set("page", String(data.page + 1));
              window.location.search = p.toString();
            }}
          >
            Next
          </Button>
        </div>
      ) : null}

      {/* A modal, not a panel under the table: on a fifty-row page an inline
          detail opens a screen and a half below the button that opened it,
          which reads as the button doing nothing. */}
      <SkuDetail
        key={open?.id ?? "none"}
        sku={open}
        goods={data.hierarchy.goods}
        canWrite={canWrite}
        refresh={refresh}
        onClose={() => setOpenId(null)}
      />
    </>
  );
}

/* --------------------------------------------------------- the SKU detail */

type SkuDetailProps = {
  sku: CatalogueData["skus"][number] | null;
  goods: CatalogueData["hierarchy"]["goods"];
  canWrite: boolean;
  refresh: () => void;
  onClose: () => void;
};

/**
 * Mounts fresh each time it opens, so the boxes never carry the last SKU's
 * numbers for a frame — the same reason ConfirmDialog is split this way.
 */
function SkuDetail(props: SkuDetailProps) {
  if (!props.sku) return null;
  return <SkuDetailBody {...props} sku={props.sku} />;
}

function SkuDetailBody({
  sku,
  goods,
  canWrite,
  refresh,
  onClose,
}: SkuDetailProps & { sku: NonNullable<SkuDetailProps["sku"]> }) {
  // Keyed by the caller, so opening a different SKU remounts with its own
  // initial state rather than resetting this one in an effect.
  const [price, setPrice] = React.useState(
    sku.sellingPricePaise == null ? "" : String(sku.sellingPricePaise / 100),
  );
  const [packingCost, setPackingCost] = React.useState(
    sku.packingCostPaise == null ? "" : String(sku.packingCostPaise / 100),
  );
  const [weight, setWeight] = React.useState(
    sku.weightGrams == null ? "" : String(sku.weightGrams / 1000),
  );
  const [cansPerBox, setCansPerBox] = React.useState(String(sku.cansPerBox));
  const [goodId, setGoodId] = React.useState("");
  const [alias, setAlias] = React.useState("");
  const { busy, run } = useAction(refresh);

  const perBox = Number(cansPerBox) || 1;
  const sample = { millilitresPerCan: sku.millilitresPerCan, cansPerBox: perBox };

  return (
    <Modal
      open
      onClose={onClose}
      width={860}
      title={
        <span className="block">
          <span className="block truncate">{sku.name}</span>
          <span className="mt-0.5 block text-[13px] font-normal text-muted">
            {[sku.formulation, sku.brand, sku.finishedGood].filter(Boolean).join(" › ")}
          </span>
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={!canWrite || busy}
            title={canWrite ? undefined : "Configuration is changed by a manager."}
            onClick={() =>
              run(() =>
                updateSku(sku.id, {
                  sellingPricePaise: price === "" ? null : Math.round(Number(price) * 100),
                  packingCostPaise: packingCost === "" ? null : Math.round(Number(packingCost) * 100),
                  weightGrams: weight === "" ? null : Math.round(Number(weight) * 1000),
                  cansPerBox: Number(cansPerBox) || 1,
                  weightBasis: (Number(cansPerBox) || 1) > 1 ? "box" : "can",
                  ...(goodId ? { finishedGoodId: goodId } : {}),
                }),
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div>
        <div className="grid grid-cols-3 gap-x-6 gap-y-3">
          <Fact label="Raw name in the source" value={sku.rawName ?? "—"} />
          <Fact
            label="Canonical name"
            value={sku.name}
            hint="The join key legacy orders and bills match on. It is not editable — a rename would detach every line that carried the old spelling. Add an alias instead."
          />
          <Fact
            label="Legacy Product ID"
            value={sku.externalCode ?? ((sku.externalIds ?? []).join(", ") || "—")}
            hint="Reference only. Not sequential, not a count, and not our primary key."
          />
        </div>

        <div className="mt-4 grid grid-cols-4 gap-3">
          <Field
            label="Cans per box"
            hint={sku.millilitresPerCan ? describeQuantity(12, sample) : "for 12 cans"}
          >
            <Input
              type="number"
              min={1}
              value={cansPerBox}
              disabled={!canWrite}
              onChange={(e) => setCansPerBox(e.target.value)}
            />
          </Field>
          <Field label="Packing cost (₹)" hint="The empty box or drum. Not a selling price.">
            <Input
              type="number"
              step="0.01"
              min={0}
              value={packingCost}
              disabled={!canWrite}
              placeholder={perBox > 1 ? "" : "loose — no box"}
              onChange={(e) => setPackingCost(e.target.value)}
            />
          </Field>
          <Field
            label={`Weight (kg per ${sku.weightBasis})`}
            hint="Transport, never pricing."
          >
            <Input
              type="number"
              step="0.01"
              min={0}
              value={weight}
              disabled={!canWrite}
              onChange={(e) => setWeight(e.target.value)}
            />
          </Field>
          <Field
            label="Selling price (₹ per can)"
            hint="Blank until a price source is confirmed. A blank price is not a free product."
          >
            <Input
              type="number"
              step="0.01"
              min={0}
              value={price}
              disabled={!canWrite}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>
        </div>

        <div className="mt-3 flex items-end gap-3">
          <Field label="Move to another finished good" className="w-96">
            <Select value={goodId} disabled={!canWrite} onChange={(e) => setGoodId(e.target.value)}>
              <option value="">Leave under {sku.finishedGood ?? "—"}</option>
              {goods.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} — {g.brand}
                </option>
              ))}
            </Select>
          </Field>
          <span className="pb-2 text-[13px] text-muted">
            Its brand and formulation follow the finished good.
          </span>
        </div>

        {/* Save lives in the modal footer, where a form's commit belongs.
            Retiring does not: it is a different decision from editing the
            row, and putting the two side by side invites the wrong one. */}
        <div className="mt-4 flex items-center gap-3 border-t border-divider pt-3">
          <Button
            variant="secondary"
            disabled={!canWrite || busy}
            title={
              sku.timesOrdered
                ? `${sku.timesOrdered} order lines name this SKU. Retiring keeps them readable.`
                : undefined
            }
            onClick={() => run(() => setSkuActive(sku.id, !sku.active))}
          >
            {sku.active ? "Retire from the order form" : "Put back on the order form"}
          </Button>
          <span className="flex-1" />
          <span className="text-right text-[13px] text-muted">
            {sku.timesOrdered
              ? `${sku.timesOrdered} order ${sku.timesOrdered === 1 ? "line" : "lines"} name it`
              : "Never ordered"}
            {sku.millilitresPerCan
              ? ` · one box is ${litres((sku.millilitresPerCan ?? 0) * perBox)}`
              : ""}
          </span>
        </div>

        <div className="mt-4 border-t border-divider pt-3">
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Names that also resolve here
          </div>
          <p className="mt-1 text-[13px] text-muted">
            An alias is read when an old order or a legacy file names this product differently. It is
            never offered on an order form.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {sku.aliases.length === 0 ? (
              <span className="text-[13px] text-muted">None.</span>
            ) : (
              sku.aliases.map((a) => (
                <span
                  key={a}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 py-1 text-[13px] text-body"
                >
                  {a}
                </span>
              ))
            )}
          </div>
          <div className="mt-2 flex items-end gap-2">
            <Field label="Add an alias" className="w-96">
              <Input
                value={alias}
                disabled={!canWrite}
                placeholder="A spelling a customer or a legacy file still uses"
                onChange={(e) => setAlias(e.target.value)}
              />
            </Field>
            <Button
              variant="secondary"
              disabled={!canWrite || busy || alias.trim().length < 2}
              onClick={async () => {
                const r = await run(() => addAlias(sku.id, alias));
                if (r.ok) setAlias("");
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
      <div className="mt-0.5 text-sm break-words text-ink">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] leading-4 text-muted">{hint}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------- finished goods */

function GoodsTab({
  data,
  canWrite,
  refresh,
}: {
  data: CatalogueData;
  canWrite: boolean;
  refresh: () => void;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Finished goods"
        hint="Brand plus pack size — what most people mean by 'a product'. A finished good is not orderable on its own; its SKUs are."
      />
      <div className="overflow-x-auto" style={{ ["--rowh" as string]: "40px" }}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th className={pinnedHead("left")}>Finished good</Th>
              <Th>Brand</Th>
              <Th>Formulation</Th>
              <Th align="right">Size</Th>
              <Th align="right">SKUs</Th>
              <Th className={pinnedHead("right")} align="right">
                {""}
              </Th>
            </tr>
          </thead>
          <tbody>
            {data.hierarchy.goods.map((g, i) => (
              <LevelRow
                key={g.id}
                index={i}
                level="good"
                id={g.id}
                name={g.name}
                active={g.active}
                canWrite={canWrite}
                refresh={refresh}
                cells={
                  <>
                    <Td>{g.brand ?? "—"}</Td>
                    <Td>{g.formulation ?? "—"}</Td>
                    <Td align="right">{litres(g.millilitres)}</Td>
                    <Td align="right">{g.skus}</Td>
                  </>
                }
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* --------------------------------------------------- brands, formulations */

function BrandsTab({
  data,
  canWrite,
  refresh,
}: {
  data: CatalogueData;
  canWrite: boolean;
  refresh: () => void;
}) {
  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Brand lines"
          hint="What the customer actually asks for. One liquid can carry several — which is why product search matches the brand and the formulation as well as the SKU name."
        />
        <div className="overflow-x-auto" style={{ ["--rowh" as string]: "40px" }}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th className={pinnedHead("left")}>Brand line</Th>
                <Th>Formulation underneath</Th>
                <Th align="right">Finished goods</Th>
                <Th align="right">SKUs</Th>
                <Th className={pinnedHead("right")} align="right">
                  {""}
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.hierarchy.brands.map((b, i) => (
                <LevelRow
                  key={b.id}
                  index={i}
                  level="brand"
                  id={b.id}
                  name={b.name}
                  active={b.active}
                  canWrite={canWrite}
                  refresh={refresh}
                  cells={
                    <>
                      <Td>{b.formulation ?? "—"}</Td>
                      <Td align="right">{b.goods}</Td>
                      <Td align="right">{b.skus}</Td>
                    </>
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-4 overflow-hidden">
        <CardHeader
          title="Base formulations"
          hint="The actual liquid. Never customer-facing — but a telecaller who was told 'M5x4' has to find the Nano SKUs, so search reads these too."
        />
        <div className="overflow-x-auto" style={{ ["--rowh" as string]: "40px" }}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th className={pinnedHead("left")}>Formulation</Th>
                <Th align="right">Brand lines</Th>
                <Th align="right">SKUs</Th>
                <Th className={pinnedHead("right")} align="right">
                  {""}
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.hierarchy.formulations.map((f, i) => (
                <LevelRow
                  key={f.id}
                  index={i}
                  level="formulation"
                  id={f.id}
                  name={f.name}
                  active={f.active}
                  canWrite={canWrite}
                  refresh={refresh}
                  cells={
                    <>
                      <Td align="right">{f.brands}</Td>
                      <Td align="right">{f.skus}</Td>
                    </>
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/** One renamable, retirable row of any of the three upper levels. */
function LevelRow({
  index,
  level,
  id,
  name,
  active,
  cells,
  canWrite,
  refresh,
}: {
  index: number;
  level: "formulation" | "brand" | "good";
  id: string;
  name: string;
  active: boolean;
  cells: React.ReactNode;
  canWrite: boolean;
  refresh: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(name);
  const { busy, run } = useAction(refresh);

  return (
    <Tr>
      <Td className={pinnedCell("left", index)}>
        {editing ? (
          <Input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter") {
                const r = await run(() => renameLevel(level, id, draft));
                if (r.ok) setEditing(false);
              }
            }}
          />
        ) : (
          <span className={cx("font-medium", active ? "text-ink" : "text-muted line-through")}>
            {name}
          </span>
        )}
      </Td>
      {cells}
      <Td className={pinnedCell("right", index)} align="right">
        <span className="flex items-center justify-end gap-1">
          {editing ? (
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={async () => {
                  const r = await run(() => renameLevel(level, id, draft));
                  if (r.ok) setEditing(false);
                }}
              >
                Save
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                disabled={!canWrite}
                title={canWrite ? undefined : "Configuration is changed by a manager."}
                onClick={() => {
                  setDraft(name);
                  setEditing(true);
                }}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                disabled={!canWrite || busy}
                title={
                  canWrite
                    ? "Retiring this leaves the SKUs underneath working — retire those separately."
                    : "Configuration is changed by a manager."
                }
                onClick={() => run(() => setLevelActive(level, id, !active))}
              >
                {active ? "Retire" : "Restore"}
              </Button>
            </>
          )}
        </span>
      </Td>
    </Tr>
  );
}

/* ------------------------------------------------------------- categories */

function CategoriesTab({
  data,
  canWrite,
  refresh,
}: {
  data: CatalogueData;
  canWrite: boolean;
  refresh: () => void;
}) {
  const [adding, setAdding] = React.useState(false);
  // The residual sorts last by convention, not by a position in this list —
  // it never takes part in "move up" / "move down".
  const orderable = data.categories.filter((c) => !c.isResidual);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Mix categories"
        hint="What a sales target's product mix is measured against — rows, not a fixed list in a screen, so a new one can be added the day it becomes strategic. The residual catches every formulation nobody has classified yet, and always sorts last."
        action={
          <Button
            variant="secondary"
            disabled={!canWrite}
            title={canWrite ? undefined : "Configuration is changed by a manager."}
            onClick={() => setAdding(true)}
          >
            Add category
          </Button>
        }
      />
      <div className="overflow-x-auto" style={{ ["--rowh" as string]: "40px" }}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th className={pinnedHead("left")}>Category</Th>
              <Th align="right">Formulations classified</Th>
              <Th align="right">Order</Th>
              <Th className={pinnedHead("right")} align="right">
                {""}
              </Th>
            </tr>
          </thead>
          <tbody>
            {data.categories.map((c, i) => {
              const position = orderable.findIndex((r) => r.id === c.id);
              return (
                <CategoryRow
                  key={c.id}
                  index={i}
                  category={c}
                  isFirst={position <= 0}
                  isLast={position === orderable.length - 1}
                  canWrite={canWrite}
                  refresh={refresh}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      {adding ? <AddCategoryModal onClose={() => setAdding(false)} refresh={refresh} /> : null}
    </Card>
  );
}

/** One mix category — renamable and reorderable, retirable unless it is the residual. */
function CategoryRow({
  index,
  category,
  isFirst,
  isLast,
  canWrite,
  refresh,
}: {
  index: number;
  category: CatalogueData["categories"][number];
  isFirst: boolean;
  isLast: boolean;
  canWrite: boolean;
  refresh: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(category.name);
  const { busy, run } = useAction(refresh);

  return (
    <Tr>
      <Td className={pinnedCell("left", index)}>
        {editing ? (
          <Input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter") {
                const r = await run(() => renameLevel("category", category.id, draft));
                if (r.ok) setEditing(false);
              }
            }}
          />
        ) : (
          <span className="flex items-center gap-2">
            <span
              className={cx(
                "font-medium",
                category.active ? "text-ink" : "text-muted line-through",
              )}
            >
              {category.name}
            </span>
            {category.isResidual ? <Badge tone="neutral">Residual</Badge> : null}
          </span>
        )}
      </Td>
      <Td align="right">{category.formulations}</Td>
      <Td align="right">
        {category.isResidual ? (
          <span className="text-[13px] text-muted">sorts last</span>
        ) : (
          <span className="inline-flex gap-0.5">
            <Button
              variant="ghost"
              disabled={!canWrite || busy || isFirst}
              title={isFirst ? "Already first." : undefined}
              onClick={() => run(() => moveCategory(category.id, "up"))}
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              disabled={!canWrite || busy || isLast}
              title={isLast ? "Already last." : undefined}
              onClick={() => run(() => moveCategory(category.id, "down"))}
            >
              ↓
            </Button>
          </span>
        )}
      </Td>
      <Td className={pinnedCell("right", index)} align="right">
        <span className="flex items-center justify-end gap-1">
          {editing ? (
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={async () => {
                  const r = await run(() => renameLevel("category", category.id, draft));
                  if (r.ok) setEditing(false);
                }}
              >
                Save
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                disabled={!canWrite}
                title={canWrite ? undefined : "Configuration is changed by a manager."}
                onClick={() => {
                  setDraft(category.name);
                  setEditing(true);
                }}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                disabled={!canWrite || busy || (category.isResidual && category.active)}
                title={
                  category.isResidual && category.active
                    ? "The residual catches everything unclassified — it cannot be retired."
                    : canWrite
                      ? undefined
                      : "Configuration is changed by a manager."
                }
                onClick={() => run(() => setLevelActive("category", category.id, !category.active))}
              >
                {category.active ? "Retire" : "Restore"}
              </Button>
            </>
          )}
        </span>
      </Td>
    </Tr>
  );
}

function AddCategoryModal({ onClose, refresh }: { onClose: () => void; refresh: () => void }) {
  const [name, setName] = React.useState("");
  const { busy, run } = useAction(refresh);

  const save = async () => {
    const r = await run(() => createCategory(name));
    if (r.ok) onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={420}
      title="Add category"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || name.trim().length < 2} onClick={save}>
            Add
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input
          value={name}
          autoFocus
          placeholder="e.g. Epoxy"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim().length >= 2) save();
          }}
        />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------- duplicates */

function DuplicatesTab({
  data,
  canWrite,
  refresh,
}: {
  data: CatalogueData;
  canWrite: boolean;
  refresh: () => void;
}) {
  const { busy, run } = useAction(refresh);
  const [picked, setPicked] = React.useState<Record<string, number>>({});

  if (data.duplicates.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Every SKU name resolves to one legacy ID"
          body="Nothing is waiting. If a future import brings in another name carried by two Product IDs, it will land here rather than picking one."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={`${data.duplicates.length} names carry more than one legacy Product ID`}
        hint="Order lines reference the name, not the ID, so one ID has to be named canonical. The import will not choose: picking wrong silently reassigns whatever history the losing ID carried. The others become aliases and keep resolving."
      />
      <div className="overflow-x-auto" style={{ ["--rowh" as string]: "52px" }}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th className={pinnedHead("left")}>SKU name</Th>
              <Th>Formulation</Th>
              <Th>Packing</Th>
              <Th>Candidate IDs</Th>
              <Th className={pinnedHead("right")} align="right">
                {""}
              </Th>
            </tr>
          </thead>
          <tbody>
            {data.duplicates.map((d, i) => (
              <Tr key={d.id}>
                <Td className={pinnedCell("left", i)}>
                  <span className="font-medium text-ink">{d.name}</span>
                </Td>
                <Td>{d.formulation ?? "—"}</Td>
                <Td>{d.packing ?? "—"}</Td>
                <Td>
                  <span className="flex flex-wrap gap-1.5">
                    {(d.externalIds ?? []).map((x) => (
                      <button
                        key={x}
                        disabled={!canWrite}
                        onClick={() => setPicked((p) => ({ ...p, [d.id]: x }))}
                        className={cx(
                          "cursor-pointer rounded-full border px-2.5 py-1 text-[13px]",
                          picked[d.id] === x
                            ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                            : "border-line bg-surface text-body hover:border-brand",
                        )}
                      >
                        #{x}
                      </button>
                    ))}
                  </span>
                </Td>
                <Td className={pinnedCell("right", i)} align="right">
                  <Button
                    variant="secondary"
                    disabled={!canWrite || busy || !picked[d.id]}
                    title={
                      !canWrite
                        ? "Configuration is changed by a manager."
                        : picked[d.id]
                          ? `Make #${picked[d.id]} canonical`
                          : "Pick which ID is the real one first"
                    }
                    onClick={() => run(() => chooseCanonicalId(d.id, picked[d.id]))}
                  >
                    Make canonical
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------- held and excluded */

function ExceptionsTab({
  data,
  canWrite,
  refresh,
}: {
  data: CatalogueData;
  canWrite: boolean;
  refresh: () => void;
}) {
  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Legacy rows that are not SKUs"
          hint="Kept where somebody will see them. A row dropped on the floor at import time is a row nobody can account for later."
        />
        <div className="overflow-x-auto" style={{ ["--rowh" as string]: "44px" }}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th className={pinnedHead("left")}>Legacy ID</Th>
                <Th>What it is</Th>
                <Th>Why it is not a SKU</Th>
                <Th>State</Th>
              </tr>
            </thead>
            <tbody>
              {data.exceptions.map((e, i) => (
                <Tr key={e.id}>
                  <Td className={pinnedCell("left", i)}>#{e.externalId}</Td>
                  <Td>{e.label ?? "—"}</Td>
                  <Td>{e.reason}</Td>
                  <Td>
                    {e.resolvedAt ? (
                      <Badge tone="success">Named — {e.resolvedProduct}</Badge>
                    ) : e.kind === "excluded" ? (
                      <Badge tone="neutral">Excluded on purpose</Badge>
                    ) : (
                      <Badge tone="warn">Held — needs a name</Badge>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <NameHeldRow data={data} canWrite={canWrite} refresh={refresh} />

      <Card className="mt-4 overflow-hidden">
        <CardHeader
          title="Aliases"
          hint="Names that resolve to a SKU without being its name — the losing side of a duplicate, and spellings seen in the wild. Read on the way in, never offered on an order form."
        />
        <div className="overflow-x-auto" style={{ ["--rowh" as string]: "40px" }}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th className={pinnedHead("left")}>Alias</Th>
                <Th>Resolves to</Th>
                <Th>Why</Th>
                <Th className={pinnedHead("right")} align="right">
                  {""}
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.aliases.map((a, i) => (
                <AliasRow key={a.id} alias={a} index={i} canWrite={canWrite} refresh={refresh} />
              ))}
            </tbody>
          </table>
          {data.aliases.length === 0 ? (
            <EmptyState
              title="No aliases yet"
              body="Resolving a duplicated name creates them, and a SKU's own screen can add one for a spelling a customer still uses."
            />
          ) : null}
        </div>
      </Card>
    </>
  );
}

function AliasRow({
  alias,
  index,
  canWrite,
  refresh,
}: {
  alias: CatalogueData["aliases"][number];
  index: number;
  canWrite: boolean;
  refresh: () => void;
}) {
  const { busy, run } = useAction(refresh);
  return (
    <Tr>
      <Td className={pinnedCell("left", index)}>{alias.name}</Td>
      <Td>{alias.product ?? "—"}</Td>
      <Td>{alias.reason ?? "—"}</Td>
      <Td className={pinnedCell("right", index)} align="right">
        <Button
          variant="ghost"
          disabled={!canWrite || busy}
          title={
            canWrite
              ? "A legacy row carrying this name will stop resolving."
              : "Configuration is changed by a manager."
          }
          onClick={() => run(() => removeAlias(alias.id))}
        >
          Remove
        </Button>
      </Td>
    </Tr>
  );
}

/** The form that turns a held row into a SKU by giving it a name. */
function NameHeldRow({
  data,
  canWrite,
  refresh,
}: {
  data: CatalogueData;
  canWrite: boolean;
  refresh: () => void;
}) {
  const held = data.exceptions.filter((e) => e.kind === "held" && !e.resolvedAt);
  const [exceptionId, setExceptionId] = React.useState("");
  const [name, setName] = React.useState("");
  const [goodId, setGoodId] = React.useState("");
  const [packing, setPacking] = React.useState("Loose");
  const [cansPerBox, setCansPerBox] = React.useState("1");
  const [ml, setMl] = React.useState("1000");
  const { busy, run } = useAction(refresh);

  if (held.length === 0) return null;

  return (
    <Card className="mt-4">
      <CardHeader
        title="Name a held row"
        hint="A held row has a packing configuration and no sellable name, so there is nothing a telecaller could put on an order. Naming it is the only way it becomes a SKU — the import will not invent one."
      />
      <div className="grid grid-cols-3 gap-3 px-5 py-4">
        <Field label="Held row">
          <Select value={exceptionId} disabled={!canWrite} onChange={(e) => setExceptionId(e.target.value)}>
            <option value="">Choose one</option>
            {held.map((h) => (
              <option key={h.id} value={h.id}>
                #{h.externalId} — {h.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Sellable name" className="col-span-2">
          <Input
            value={name}
            disabled={!canWrite}
            placeholder="e.g. Mahek Epoxy Thinner (FD) - 1 Liter (16 Can/Box)"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Finished good">
          <Select value={goodId} disabled={!canWrite} onChange={(e) => setGoodId(e.target.value)}>
            <option value="">Choose one</option>
            {data.hierarchy.goods.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} — {g.brand}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Packing">
          <Input value={packing} disabled={!canWrite} onChange={(e) => setPacking(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cans per box">
            <Input
              type="number"
              min={1}
              value={cansPerBox}
              disabled={!canWrite}
              onChange={(e) => setCansPerBox(e.target.value)}
            />
          </Field>
          <Field label="Millilitres per can">
            <Input
              type="number"
              min={1}
              value={ml}
              disabled={!canWrite}
              onChange={(e) => setMl(e.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-divider px-5 py-3">
        <Button
          variant="primary"
          disabled={!canWrite || busy || !exceptionId || !goodId || name.trim().length < 3}
          onClick={async () => {
            const r = await run(() =>
              nameHeldRow(exceptionId, {
                name,
                finishedGoodId: goodId,
                packing,
                cansPerBox: Number(cansPerBox) || 1,
                millilitresPerCan: Number(ml) || 1000,
              }),
            );
            if (r.ok) {
              setExceptionId("");
              setName("");
            }
          }}
        >
          Create the SKU
        </Button>
        <span className="text-[13px] text-muted">
          It becomes orderable immediately, and the held row records what it became.
        </span>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------- import */

function ImportTab({
  data,
  canWrite,
  refresh,
}: {
  data: CatalogueData;
  canWrite: boolean;
  refresh: () => void;
}) {
  const [report, setReport] = React.useState<CatalogueData["lastReport"]>(null);
  const { busy, run } = useAction(refresh);

  async function go(dryRun: boolean) {
    // A dry run wrote nothing, so there is nothing to re-read — and refreshing
    // would discard the report, which is the entire point of running one.
    const r = await run(() => runCatalogueImport(dryRun), { skipRefresh: dryRun });
    if (r.ok && r.data) setReport(r.data as NonNullable<CatalogueData["lastReport"]>);
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Import the product master"
          hint="Matches on the canonical SKU name, never on a legacy ID — the IDs are not sequential, not a count, and not what legacy orders reference. Re-running updates what changed and inserts nothing twice."
        />
        <div className="px-5 py-4">
          <ul className="flex flex-col gap-1.5 text-[13px] leading-5 text-body">
            <li>· A name carried by several legacy IDs is held, not guessed at. Those land in Duplicates.</li>
            <li>· A legacy row with no sellable name is held. Naming it is a person&rsquo;s decision.</li>
            <li>· Packaging material is excluded outright — an empty drum is not a product.</li>
            <li>· No price is imported, because the source document carries none.</li>
            <li>· A canonical ID somebody has already chosen is never reset by a re-run.</li>
          </ul>
          <div className="mt-4 flex items-center gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => go(true)}>
              Dry run
            </Button>
            <Button
              variant="primary"
              disabled={!canWrite || busy}
              title={canWrite ? undefined : "Configuration is changed by a manager."}
              onClick={() => go(false)}
            >
              Run the import
            </Button>
            <span className="text-[13px] text-muted">
              A dry run reports exactly what a real run would change and writes nothing.
            </span>
          </div>
        </div>
      </Card>

      {report ? <ImportReportCard report={report} /> : null}

      {data.discrepancies.length ? (
        <Card className="mt-4">
          <CardHeader
            title="Where the source document contradicts itself"
            hint="Reported rather than reconciled. A count that does not add up is a question for whoever maintains the document, not something an import should decide on its own."
          />
          <div className="flex flex-col gap-1.5 px-5 py-4">
            {data.discrepancies.map((d) => (
              <div key={d} className="text-sm text-ink">
                {d}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </>
  );
}

function ImportReportCard({ report }: { report: NonNullable<CatalogueData["lastReport"]> }) {
  const shown = report.changes.slice(0, 40);
  return (
    <Card className="mt-4 overflow-hidden">
      <CardHeader
        title={report.applied ? "What the import changed" : "What a real run would change"}
        hint={`${report.created} created · ${report.updated} updated · ${report.unchanged} unchanged`}
      />
      {report.changes.length === 0 ? (
        <EmptyState
          title="Nothing to do"
          body="The catalogue already matches the document exactly. That is what a second run is supposed to say."
        />
      ) : (
        <div className="max-h-96 overflow-y-auto" style={{ ["--rowh" as string]: "34px" }}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Action</Th>
                <Th>Level</Th>
                <Th>Name</Th>
                <Th>Fields</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c, i) => (
                <Tr key={`${c.level}-${c.name}-${i}`}>
                  <Td>
                    <Badge tone={c.action === "created" ? "success" : "neutral"}>{c.action}</Badge>
                  </Td>
                  <Td>{c.level}</Td>
                  <Td>{c.name}</Td>
                  <Td>{c.fields?.join(", ") ?? "—"}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
          {report.changes.length > shown.length ? (
            <div className="px-3 py-2 text-[13px] text-muted">
              … and {report.changes.length - shown.length} more.
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
