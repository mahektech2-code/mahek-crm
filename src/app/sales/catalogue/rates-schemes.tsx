"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { addScheme, endPriceListRate, setPriceListRate, withdrawScheme } from "@/lib/actions/sales";
import type { PriceListRow, SchemeRow } from "@/lib/services/sales-service";
import { money } from "@/lib/format";
import { SalesIcon } from "../icons";
import { Banner, Button, Cell, Empty, HeadCell, Pill, Row, Table } from "../parts";

type ProductOption = { id: string; name: string };

/**
 * A working starting point, not a blank brace.
 *
 * The handset's scheme engine (`mbos-app/src/engines/schemes.ts`) wants five
 * fields split across two JSON columns — `when`, `level`, `priority` and
 * `stackable` inside `eligibility`, the benefit shape on its own — and typing
 * that from memory is how a manager sends a scheme the engine silently never
 * matches. A product id has to be swapped in either way, so a template that
 * already parses is strictly better than an empty object that also does.
 */
const ELIGIBILITY_TEMPLATE = `{
  "level": "line",
  "priority": 0,
  "stackable": false,
  "when": { "field": "skuId", "op": "eq", "value": "PRODUCT_ID" }
}`;
const BENEFIT_TEMPLATE = `{
  "kind": "free_quantity",
  "perCans": 10,
  "freeCans": 1
}`;

/**
 * What a customer pays, and what they are offered on top of it.
 *
 * Two tables rather than a tab each, because they answer the same question —
 * "what does an order actually cost this customer" — and a manager checking
 * a rate is exactly who also wants to know whether a scheme applies to it.
 */
export function RatesAndSchemes({
  rates,
  schemes,
  priceTags,
  products,
  todayIso,
}: {
  rates: PriceListRow[];
  schemes: SchemeRow[];
  priceTags: string[];
  products: ProductOption[];
  /** The business date, read on the server — never `new Date()` at render. */
  todayIso: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const current = rates.filter((r) => !r.validTo || r.validTo >= todayIso);
  const past = rates.filter((r) => r.validTo && r.validTo < todayIso);

  const [tag, setTag] = React.useState("");
  const [productId, setProductId] = React.useState("");
  const [rupees, setRupees] = React.useState("");
  const [validFrom, setValidFrom] = React.useState("");

  async function addRate() {
    const ratePaise = Math.round(parseFloat(rupees) * 100);
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await setPriceListRate({
        customerPriceTag: tag,
        productId,
        ratePaise,
        validFrom: validFrom || undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setTag("");
    setProductId("");
    setRupees("");
    setValidFrom("");
    toast.push(result.message ?? "Saved.");
    router.refresh();
  }

  async function endRate(id: string) {
    setBusy(true);
    let result;
    try {
      result = await endPriceListRate(id);
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.push(result.message ?? "Withdrawn.");
    router.refresh();
  }

  return (
    <div className="mt-8">
      {error ? <Banner tone="danger" title="That did not save" body={error} /> : null}

      <h2 className="mb-1 text-[15px] font-semibold text-ink">Rates</h2>
      <p className="mb-3 max-w-[720px] text-[13px] text-muted">
        Kept by price tag — DEALER, DISTRIBUTOR, whatever the Sales Party tab tags an account as —
        not by customer, since every account on a tag pays the same. A new rate does not overwrite
        the old one: it dates the old one out and adds itself beside it, so an order priced last
        month stays explained.
      </p>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-[6px] border border-line bg-surface px-4 py-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Price tag
          </span>
          <input
            list="price-tags"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="DEALER"
            className="h-8.5 w-[180px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
          <datalist id="price-tags">
            {priceTags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Product
          </span>
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            className="h-8.5 w-[280px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          >
            <option value="">Pick a product…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Rate, per can (₹)
          </span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={rupees}
            onChange={(e) => setRupees(e.target.value)}
            placeholder="1250.00"
            className="h-8.5 w-[130px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            In force from
          </span>
          <input
            type="date"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
            title="Today, if left blank"
            className="h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <Button
          tone="primary"
          disabled={busy || !tag.trim() || !productId || !rupees}
          title={!tag.trim() || !productId || !rupees ? "A rate needs a tag, a product and an amount." : undefined}
          onClick={() => void addRate()}
        >
          {busy ? "Saving…" : "Set rate"}
        </Button>
      </div>

      {current.length === 0 ? (
        <Empty
          title="No rate has ever been set"
          body="Until one is, mbos_price_list ships empty to every handset and the order form has nothing to price against. This screen fills exactly that table."
        />
      ) : (
        <Table
          minWidth={900}
          head={
            <>
              <HeadCell width={140}>Tag</HeadCell>
              <HeadCell width={280}>Product</HeadCell>
              <HeadCell align="right" width={130}>
                Rate
              </HeadCell>
              <HeadCell width={140}>In force from</HeadCell>
              <HeadCell align="right" width={90} />
            </>
          }
        >
          {current.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell>
                <Pill>{r.customerPriceTag}</Pill>
              </Cell>
              <Cell truncate={280}>{r.productName}</Cell>
              <Cell align="right">{money(r.ratePaise)}</Cell>
              <Cell className="text-muted">{r.validFrom ?? "—"}</Cell>
              <Cell align="right">
                <button
                  onClick={() => void endRate(r.id)}
                  disabled={busy}
                  aria-label={`Withdraw the ${r.customerPriceTag} rate for ${r.productName}`}
                  title="Date this rate out, without deleting it"
                  className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-[3px] text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-40"
                >
                  <SalesIcon name="close" size={14} />
                </button>
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      {past.length ? (
        <p className="mt-2 text-[12px] text-muted">
          {past.length} superseded {past.length === 1 ? "rate is" : "rates are"} kept, not shown —
          they still explain what an order was worth on the day it was priced.
        </p>
      ) : null}

      <h2 className="mt-8 mb-1 text-[15px] font-semibold text-ink">Schemes</h2>
      <p className="mb-3 max-w-[720px] text-[13px] text-muted">
        Live promotions, as data — nothing here interprets what &ldquo;eligibility&rdquo; or
        &ldquo;benefit&rdquo; mean, the same way the handset does not. That is what lets one be
        added for a festival without a release.
      </p>

      <SchemeForm />

      {schemes.filter((s) => s.active).length === 0 ? (
        <Empty title="No scheme is running" body="mbos_schemes ships empty until one is added above." />
      ) : (
        <Table
          minWidth={900}
          head={
            <>
              <HeadCell width={220}>Name</HeadCell>
              <HeadCell>Description</HeadCell>
              <HeadCell width={200}>Window</HeadCell>
              <HeadCell align="right" width={90} />
            </>
          }
        >
          {schemes
            .filter((s) => s.active)
            .map((s, i) => (
              <Row key={s.id} striped={i % 2 === 1}>
                <Cell className="font-medium text-ink" truncate={220}>
                  {s.name}
                </Cell>
                <Cell truncate={420} className="text-muted">
                  {s.description ?? "—"}
                </Cell>
                <Cell className="text-muted">
                  {s.validFrom ?? "always"} – {s.validTo ?? "open"}
                </Cell>
                <Cell align="right">
                  <WithdrawSchemeButton id={s.id} name={s.name} />
                </Cell>
              </Row>
            ))}
        </Table>
      )}
    </div>
  );
}

/** A row on its own so one row's pending state does not disable every other. */
function WithdrawSchemeButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);

  async function run() {
    setBusy(true);
    const result = await withdrawScheme(id);
    setBusy(false);
    if (!result.ok) {
      toast.push(result.error);
      return;
    }
    toast.push(result.message ?? "Withdrawn.");
    router.refresh();
  }

  return (
    <button
      onClick={() => void run()}
      disabled={busy}
      aria-label={`Withdraw ${name}`}
      title="Take this scheme off every handset"
      className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-[3px] text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-40"
    >
      <SalesIcon name="close" size={14} />
    </button>
  );
}

/**
 * `eligibility` and `benefit` as JSON, typed by hand.
 *
 * A rule-builder is the obvious next step once a shape of deal repeats often
 * enough to name — "buy N get M free", "X% off above a slab" — but that
 * shape does not exist yet, and guessing it would be exactly the kind of
 * half-built abstraction this codebase avoids. JSON is what the engine reads
 * either way; this is the same data typed instead of clicked.
 */
function SchemeForm() {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [eligibility, setEligibility] = React.useState(ELIGIBILITY_TEMPLATE);
  const [benefit, setBenefit] = React.useState(BENEFIT_TEMPLATE);
  const [validFrom, setValidFrom] = React.useState("");
  const [validTo, setValidTo] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function add() {
    let e: Record<string, unknown>;
    let b: Record<string, unknown>;
    try {
      e = JSON.parse(eligibility || "{}");
      b = JSON.parse(benefit || "{}");
    } catch {
      setError("Eligibility and benefit have to be valid JSON — the handset's scheme engine reads them exactly as typed.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await addScheme({
      name,
      description: description || undefined,
      eligibility: e,
      benefit: b,
      validFrom: validFrom || undefined,
      validTo: validTo || undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setName("");
    setDescription("");
    setEligibility(ELIGIBILITY_TEMPLATE);
    setBenefit(BENEFIT_TEMPLATE);
    setValidFrom("");
    setValidTo("");
    toast.push(result.message ?? "Added.");
    router.refresh();
  }

  return (
    <div className="mb-4 rounded-[6px] border border-line bg-surface px-4 py-3">
      {error ? <p className="mb-2 text-[13px] text-danger">{error}</p> : null}
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Name
          </span>
          <input
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            placeholder="Diwali 2026"
            className="h-8.5 w-[220px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Description
          </span>
          <input
            value={description}
            onChange={(ev) => setDescription(ev.target.value)}
            placeholder="Buy 10 cans, get 1 free"
            className="h-8.5 w-[280px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            From
          </span>
          <input
            type="date"
            value={validFrom}
            onChange={(ev) => setValidFrom(ev.target.value)}
            className="h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            To
          </span>
          <input
            type="date"
            value={validTo}
            onChange={(ev) => setValidTo(ev.target.value)}
            className="h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Eligibility (JSON)
          </span>
          <textarea
            value={eligibility}
            onChange={(ev) => setEligibility(ev.target.value)}
            rows={5}
            title="who and what the scheme applies to — level, priority, stackable, and the predicate itself under `when`"
            className="w-[340px] rounded-[4px] border border-line bg-surface px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Benefit (JSON)
          </span>
          <textarea
            value={benefit}
            onChange={(ev) => setBenefit(ev.target.value)}
            rows={5}
            title="what the customer gets: free_quantity, percent_discount or flat_discount"
            className="w-[340px] rounded-[4px] border border-line bg-surface px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-brand"
          />
        </label>
        <Button tone="primary" disabled={busy || !name.trim()} onClick={() => void add()}>
          {busy ? "Saving…" : "Add scheme"}
        </Button>
      </div>
    </div>
  );
}
