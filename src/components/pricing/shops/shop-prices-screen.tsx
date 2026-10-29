"use client";

/* ---------------------------------------------------------------------------
 * WHAT A SHOP PAYS — product by product, and where each price comes from.
 *
 * Three sources, said in words on every row: a special price (an override,
 * with its end date), an agreed price somebody typed into the shop's own list
 * with no override behind it, or the book. Where the shop pays something other
 * than its book, the book's figure is beside it, so the gap is never a
 * calculation the reader has to do.
 *
 * "Why these prices" is the shop's chain in plain words, and "What changes
 * next" is the shop resolved again on the next day any list in that chain has a
 * revision dated — the same resolver every order form prices with, asked about
 * a later day.
 *
 * The question box asks a model about THIS screen's facts and nothing else.
 * It explains; it never writes a price.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { Badge, Button, Card, EmptyState, Td, Textarea, Th, Tr } from "@/components/ui/primitives";
import { longDate, money, stamp } from "@/lib/format";
import { askShopPricesAction } from "@/lib/actions/price-overrides";
import type { ShopPricesView } from "@/components/pricing/overrides/types";
import { ShopSearch } from "@/components/pricing/overrides/shop-search";
import { useRouter } from "next/navigation";

function gapPct(pay: number, book: number | null): number | null {
  if (book == null || book <= 0) return null;
  return Math.round(((pay - book) / book) * 1000) / 10;
}

export function ShopPricesScreen({ basePath, view }: { basePath: string; view: ShopPricesView }) {
  const special = view.rows.filter((r) => r.source !== "book").length;
  return (
    <div className="space-y-5">
      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-ink">{view.customer.name}</div>
            <div className="text-[13px] text-muted">
              {view.customer.city}
              {view.customer.region ? `, ${view.customer.region}` : ""} · {view.rows.length} products priced
              {special ? ` · ${special} not at its book price` : ""}
            </div>
          </div>
          <Link href={`${basePath}/shops`} className="text-[13px] text-brand hover:underline">
            Another shop
          </Link>
        </div>
      </Card>

      <Card className="px-5 py-4">
        <div className="mb-2 text-[11px] font-medium tracking-label text-muted uppercase">Why these prices</div>
        {view.chain.length === 0 ? (
          <p className="text-sm text-body">No price list names this shop, so nothing is priced for it. Put it on a book from the Lists tab.</p>
        ) : (
          <ol className="list-decimal space-y-1 pl-5 text-sm text-body">
            {view.chain.map((c) => (
              <li key={c.listId}>
                <Link href={`${basePath}/${c.listId}`} className="hover:underline">
                  {c.sentence}
                </Link>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card className="overflow-hidden">
        {view.rows.length === 0 ? (
          <EmptyState title="Nothing priced" body="No list in this shop's chain carries a rate." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th align="right">Pays</Th>
                  <Th>Where it comes from</Th>
                  <Th align="right">Book price</Th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((r) => {
                  const gap = gapPct(r.payIncl, r.bookIncl);
                  return (
                    <Tr key={r.productId}>
                      <Td>
                        {r.productName}
                        {r.slabs > 1 ? <div className="text-[12px] text-muted">{r.slabs} quantity slabs — the first shown</div> : null}
                      </Td>
                      <Td align="right">
                        {r.offered ? money(r.payIncl) : <span className="text-muted">not offered</span>}
                        <div className="text-[12px] text-muted">{money(r.payEx)} ex</div>
                      </Td>
                      <Td>
                        {r.source === "override" ? (
                          <>
                            <Badge tone="brand">Special price</Badge>{" "}
                            <span className="text-[13px] text-muted">
                              {r.override?.validTo ? `until ${longDate(r.override.validTo)}` : "no end date"}
                              {r.override?.minCansPerMonth ? ` · ${r.override.minCansPerMonth} cans/month` : ""}
                            </span>
                          </>
                        ) : r.source === "agreed" ? (
                          <>
                            <Badge tone="warn">Agreed, no end</Badge> <span className="text-[13px] text-muted">typed into {r.listName}</span>
                          </>
                        ) : (
                          <span className="text-body">{r.listName}</span>
                        )}
                      </Td>
                      <Td align="right">
                        {r.source === "book" ? (
                          <span className="text-muted">—</span>
                        ) : r.bookIncl == null ? (
                          <span className="text-muted">not on its book</span>
                        ) : (
                          <>
                            {money(r.bookIncl)}
                            {gap != null ? (
                              <div className={gap < 0 ? "text-[12px] text-danger" : "text-[12px] text-success"}>
                                {gap > 0 ? "+" : ""}
                                {gap}%
                              </div>
                            ) : null}
                          </>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="px-5 py-4">
          <div className="mb-2 text-[11px] font-medium tracking-label text-muted uppercase">What changes next</div>
          {!view.next ? (
            <p className="text-sm text-body">No list in this shop&apos;s chain has a revision dated for a later day.</p>
          ) : view.next.changes.length === 0 ? (
            <p className="text-sm text-body">A revision starts on {longDate(view.next.date)}, and none of this shop&apos;s prices move with it.</p>
          ) : (
            <>
              <p className="mb-2 text-sm text-body">On {longDate(view.next.date)}:</p>
              <ul className="space-y-1 text-sm">
                {view.next.changes.map((c) => (
                  <li key={c.productId} className="flex justify-between gap-3">
                    <span>{c.productName}</span>
                    <span className="tabular-nums">
                      {c.fromIncl == null ? "—" : money(c.fromIncl)} → {c.toIncl == null ? "off the list" : money(c.toIncl)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card className="px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium tracking-label text-muted uppercase">Special prices</span>
            <Link href={`${basePath}/overrides`} className="text-[13px] text-brand hover:underline">
              All special prices
            </Link>
          </div>
          {view.overrides.length === 0 ? (
            <p className="text-sm text-body">None live or waiting to start.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {view.overrides.map((o) => (
                <li key={o.id} className="flex justify-between gap-3">
                  <span>
                    {o.productName} <span className="text-muted">{money(o.rateInclGstPaise)}</span>
                  </span>
                  <span className="text-[13px] text-muted">
                    {o.state === "scheduled" ? `from ${longDate(o.validFrom)} ` : ""}
                    {o.validTo ? `until ${longDate(o.validTo)}` : "no end date"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <AskBox customerId={view.customer.id} ready={view.aiReady} answers={view.answers} />
    </div>
  );
}

function AskBox({ customerId, ready, answers }: { customerId: string; ready: boolean; answers: ShopPricesView["answers"] }) {
  const [question, setQuestion] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [latest, setLatest] = React.useState<{ question: string; answer: string; by: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      const r = await askShopPricesAction(customerId, q);
      if (r.ok) {
        setLatest({ question: q, ...r.data });
        setQuestion("");
      } else setError(r.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="px-5 py-4">
      <div className="mb-1 text-[11px] font-medium tracking-label text-muted uppercase">Ask about this shop&apos;s prices</div>
      <p className="mb-3 text-[13px] text-muted">Answered from the facts on this screen only. Advice — it never changes a price.</p>
      {!ready ? (
        <p className="text-sm text-body">AI is switched off for prices, or no key is set.</p>
      ) : (
        <>
          <Textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Why does this shop pay less for the 20 litre than the 5 litre?" />
          <div className="mt-2 flex justify-end">
            <Button variant="primary" disabled={busy || !question.trim()} onClick={() => void ask()}>
              {busy ? "Asking…" : "Ask"}
            </Button>
          </div>
        </>
      )}
      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
      {[...(latest ? [{ ...latest, at: null as string | null }] : []), ...answers.map((a) => ({ ...a, at: a.at as string | null }))].map((a, i) => (
        <div key={i} className="mt-3 rounded-[4px] border border-line bg-canvas px-3 py-2 text-sm">
          {a.question ? <div className="mb-1 font-medium text-ink">{a.question}</div> : null}
          <div className="whitespace-pre-line text-body">{a.answer}</div>
          <div className="mt-1 text-[12px] text-muted">
            {a.by}
            {a.at ? ` · ${stamp(a.at)}` : ""}
          </div>
        </div>
      ))}
    </Card>
  );
}

/** The Shop prices tab with no shop chosen yet. */
export function ShopPickScreen({ basePath, withOverrides }: { basePath: string; withOverrides: Array<{ id: string; name: string; count: number }> }) {
  const router = useRouter();
  return (
    <div className="space-y-5">
      <Card className="px-5 py-4">
        <div className="mb-2 text-[11px] font-medium tracking-label text-muted uppercase">Find a shop</div>
        <ShopSearch autoFocus onPick={(h) => router.push(`${basePath}/shops/${h.id}`)} />
      </Card>
      <Card className="px-5 py-4">
        <div className="mb-2 text-[11px] font-medium tracking-label text-muted uppercase">Shops with special prices</div>
        {withOverrides.length === 0 ? (
          <p className="text-sm text-body">No shop has a special price live or waiting to start.</p>
        ) : (
          <ul className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {withOverrides.map((s) => (
              <li key={s.id}>
                <Link href={`${basePath}/shops/${s.id}`} className="text-brand hover:underline">
                  {s.name}
                </Link>{" "}
                <span className="text-muted">{s.count}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
