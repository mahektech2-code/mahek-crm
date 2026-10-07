"use client";

import * as React from "react";
import { Input, cx } from "@/components/ui/primitives";
import { shortDate } from "@/lib/format";
import { CALLER_ROLE_LABEL } from "@/lib/call-reasons";
import type { CallContextSnapshot } from "@/lib/call-detail";

/* ---------------------------------------------------------------------------
 * WHAT THE ERP ALREADY KNOWS, put in front of the telecaller mid-call.
 *
 * Three small readers over `/api/call-context`, all READ-ONLY: the customer's
 * ERP orders with their transport details, an availability figure for one
 * product, and who earlier calls on this account were from. Each one fails
 * into a sentence and nothing else — the ERP being slow or empty must never
 * stand between somebody and logging the call, so nothing here is required and
 * nothing here blocks a save.
 *
 * What the call KEEPS of any of this is taken by the server at save, from the
 * order number or SKU these write into the form. The browser never sends the
 * figures back.
 * ------------------------------------------------------------------------- */

type Load<T> = { state: "loading" } | { state: "failed" } | { state: "ready"; data: T };

function useCallContext<T>(url: string | null, pick: (body: Record<string, unknown>) => T): Load<T> {
  const [result, setResult] = React.useState<{ url: string; load: Load<T> } | null>(null);
  React.useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad"))))
      .then((body: Record<string, unknown>) => {
        if (body.failed) throw new Error("failed");
        setResult({ url, load: { state: "ready", data: pick(body) } });
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setResult({ url, load: { state: "failed" } });
      });
    return () => controller.abort();
    // `pick` is a stable reader supplied by each caller and never changes the
    // request; leaving it out is what keeps one fetch per URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  /* A result for a DIFFERENT url is a stale answer, read as still loading
     rather than cleared by an effect. */
  if (!url) return { state: "loading" };
  return result && result.url === url ? result.load : { state: "loading" };
}

/* ---------------------------------------------------------------- delivery */

type Order = NonNullable<CallContextSnapshot["delivery"]> & { orderDate: string | null; lines: number };

export function DeliveryOrders({
  customerId,
  selected,
  onPick,
}: {
  customerId: string;
  selected: string;
  onPick: (order: Order | null) => void;
}) {
  const load = useCallContext<Order[]>(
    `/api/call-context?kind=delivery&customerId=${encodeURIComponent(customerId)}`,
    (b) => (b.orders as Order[]) ?? [],
  );

  return (
    <div className="mb-3.5 rounded-[4px] border border-line bg-canvas p-3">
      <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        Their orders, from the ERP
      </span>
      {load.state === "loading" ? (
        <p className="mt-1.5 text-[13px] text-muted">Reading their orders…</p>
      ) : load.state === "failed" ? (
        <p className="mt-1.5 text-[13px] text-muted">
          The ERP could not be read just now. Type the order or invoice number below — the call
          can be logged without it.
        </p>
      ) : load.data.length === 0 ? (
        <p className="mt-1.5 text-[13px] text-muted">
          No ERP order is recorded against this account. Type whatever they quoted below.
        </p>
      ) : (
        <>
          <p className="mt-1 text-[11px] text-muted">
            Tap the one they mean. This is read-only — nothing here changes the order.
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {load.data.map((o) => {
              const on = selected === String(o.orderNo);
              return (
                <button
                  key={o.orderNo}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onPick(on ? null : o)}
                  className={cx(
                    "cursor-pointer rounded-[4px] border px-2.5 py-2 text-left text-[13px]",
                    on
                      ? "border-brand bg-brand-soft"
                      : "border-line bg-surface hover:border-brand",
                  )}
                >
                  <span className="font-medium text-ink">
                    Order {o.orderNo}
                    {o.billNo ? ` · bill ${o.billNo}` : ""}
                  </span>
                  <span className="text-muted">
                    {o.orderDate ? ` · ${shortDate(o.orderDate)}` : ""}
                  </span>
                  <span className="block text-body">
                    {[
                      o.transporter ? `Transporter ${o.transporter}` : "No transporter recorded",
                      o.lrNo ? `LR ${o.lrNo}` : null,
                      o.dispatchedOn
                        ? `Dispatched ${shortDate(o.dispatchedOn)}`
                        : o.plannedDispatch
                          ? `Planned to leave ${shortDate(o.plannedDispatch)}`
                          : "Not planned for dispatch yet",
                      o.stage,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            The ERP holds no expected delivery date, so none is shown — do not promise one from
            here.
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- stock */

type StockProduct = { id: string; name: string };
type Stock =
  | { sku: string; unit: "cans" | "boxes"; total: number; byGodown: Array<{ godown: string; stock: number }> }
  | { unavailable: true };

export function StockCheck({
  customerId,
  fallbackProducts,
  requiredQuantity,
  skuId,
  onPick,
}: {
  customerId: string;
  /** What the panel already holds, used where catalogue search is switched off. */
  fallbackProducts: StockProduct[];
  /** What they said they need, in their words — compared only where it is a plain number. */
  requiredQuantity: string;
  skuId: string;
  onPick: (product: StockProduct | null) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [found, setFound] = React.useState<{ q: string; items: StockProduct[] } | null>(null);

  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const controller = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/product-search?q=${encodeURIComponent(q)}&customerId=${encodeURIComponent(customerId)}`, {
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : { products: [] }))
        .then((d: { products?: StockProduct[] }) => setFound({ q, items: d.products ?? [] }))
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query, customerId]);

  const q = query.trim().toLowerCase();
  const shown =
    q.length < 2
      ? []
      : (found && found.q.toLowerCase() === q && found.items.length
          ? found.items
          : fallbackProducts.filter((p) => p.name.toLowerCase().includes(q))
        ).slice(0, 6);

  const load = useCallContext<Stock>(
    skuId
      ? `/api/call-context?kind=stock&customerId=${encodeURIComponent(customerId)}&skuId=${encodeURIComponent(skuId)}`
      : null,
    (b) => b.stock as Stock,
  );

  const asked = Number(requiredQuantity.replace(/,/g, "").trim());

  return (
    <div className="mb-3.5 rounded-[4px] border border-line bg-canvas p-3">
      <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        Check stock
      </span>
      <p className="mt-1 text-[11px] text-muted">
        An indication from the ERP&apos;s stock ledgers. Nothing is reserved and no order is
        created — confirm with the godown before promising it.
      </p>
      <div className="mt-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={skuId ? "Search to check another product" : "Search the product they want"}
        />
      </div>
      {shown.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {shown.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onPick(p);
                setQuery("");
              }}
              className="cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 py-1 text-left text-[13px] text-body hover:border-brand"
            >
              {p.name}
            </button>
          ))}
        </div>
      ) : null}

      {skuId ? (
        <div className="mt-2.5 text-[13px]">
          {load.state === "loading" ? (
            <span className="text-muted">Reading the stock ledgers…</span>
          ) : load.state === "failed" || "unavailable" in load.data ? (
            <span className="text-muted">
              The stock could not be read just now. The call can still be logged.
            </span>
          ) : (
            <>
              <div className="font-medium text-ink">
                {load.data.sku}: {load.data.total} {load.data.unit} available
              </div>
              {load.data.byGodown.length ? (
                <div className="mt-0.5 text-body">
                  {load.data.byGodown.map((g) => `${g.godown} ${g.stock}`).join(" · ")}
                </div>
              ) : (
                <div className="mt-0.5 text-body">None in any godown.</div>
              )}
              {Number.isFinite(asked) && asked > 0 ? (
                <div
                  className={cx(
                    "mt-0.5",
                    load.data.total >= asked ? "text-success" : "text-danger",
                  )}
                >
                  {load.data.total >= asked
                    ? `Covers the ${asked} they asked for.`
                    : `Less than the ${asked} they asked for.`}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- callers */

type Suggestion = {
  role: string | null;
  name: string | null;
  source: "record" | "earlier_calls";
  calls: number;
};

export function CallerSuggestions({
  customerId,
  onPick,
}: {
  customerId: string;
  onPick: (s: { role: string | null; name: string | null }) => void;
}) {
  const load = useCallContext<Suggestion[]>(
    `/api/call-context?kind=callers&customerId=${encodeURIComponent(customerId)}`,
    (b) => (b.suggestions as Suggestion[]) ?? [],
  );
  if (load.state !== "ready" || !load.data.length) return null;
  return (
    <div className="mt-2">
      <span className="text-[11px] text-muted">Might be — tap to use, or ignore:</span>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {load.data.map((s, i) => (
          <button
            key={`${s.role}-${s.name}-${i}`}
            type="button"
            onClick={() => onPick({ role: s.role, name: s.name })}
            className="cursor-pointer rounded-full border border-line bg-surface px-2.5 py-1 text-[13px] text-body hover:border-brand"
          >
            {[s.name, s.role ? (CALLER_ROLE_LABEL[s.role] ?? s.role) : null]
              .filter(Boolean)
              .join(" · ")}
            <span className="text-muted">
              {s.source === "record"
                ? " · on the account"
                : ` · rang ${s.calls} time${s.calls === 1 ? "" : "s"} before`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
