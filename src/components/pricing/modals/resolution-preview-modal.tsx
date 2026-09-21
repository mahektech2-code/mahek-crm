"use client";

/* ---------------------------------------------------------------------------
 * "WHICH LIST APPLIES TO THIS SHOP?" — asked the way somebody actually asks it.
 *
 * Type a shop's name and read the answer, with the chain of reasons under it.
 * This is deliberately open to everybody who can READ a price list rather than
 * to whoever may manage one: the person who needs it is the telecaller with a
 * customer on the phone arguing about a figure, and a price nobody can explain
 * is a price the customer wins.
 *
 * "NO LIST APPLIES" IS AN ANSWER AND IT IS SHOWN WITH ITS CHAIN. A shop that
 * nothing prices is the single most useful thing this screen can find, and an
 * empty panel would read as the search having failed.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { Modal } from "@/components/ui/modal";
import { Badge, Button, Callout, Input, Td, Th, Tr, cx } from "@/components/ui/primitives";
import type { CustomerHit, CustomerPricing } from "@/lib/price-list-views";
import { LIST_STATUS_LABEL, LIST_STATUS_TONE, listSummary } from "@/lib/price-list-labels";
import { ResolutionChain } from "@/components/pricing/resolution-chain";
import { money } from "@/lib/format";

export function ResolutionPreviewModal(props: {
  open: boolean;
  onClose: () => void;
  basePath: string;
}) {
  if (!props.open) return null;
  return <PreviewBody {...props} />;
}

function PreviewBody({ onClose, basePath }: { open: boolean; onClose: () => void; basePath: string }) {
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<{ q: string; rows: CustomerHit[] } | null>(null);
  const [picked, setPicked] = React.useState<CustomerHit | null>(null);
  const [pricing, setPricing] = React.useState<{ id: string; value: CustomerPricing | null } | null>(null);

  React.useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/price-lists/customers/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const data = (await res.json()) as { customers?: CustomerHit[] };
        setHits({ q, rows: data.customers ?? [] });
      } catch {
        /* An abort is the next keystroke. */
      }
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  React.useEffect(() => {
    if (!picked) return;
    const id = picked.id;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/price-lists/customers/${id}/pricing`, { signal: controller.signal });
        setPricing({ id, value: res.ok ? ((await res.json()) as CustomerPricing) : null });
      } catch (e) {
        if ((e as Error)?.name !== "AbortError") setPricing({ id, value: null });
      }
    })();
    return () => controller.abort();
  }, [picked]);

  const q = query.trim();
  const rows = hits && hits.q === q ? hits.rows : null;
  const answer = picked && pricing?.id === picked.id ? pricing.value : null;
  const loading = picked !== null && pricing?.id !== picked.id;

  return (
    <Modal
      open
      onClose={onClose}
      width={720}
      title="Which list applies?"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-3.5">
        <Input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPicked(null);
          }}
          placeholder="Search for a shop"
        />

        {q && !picked ? (
          <div className="max-h-[200px] overflow-y-auto rounded-[4px] border border-line">
            {rows === null ? (
              <p className="px-3 py-2 text-[13px] text-muted">Searching…</p>
            ) : rows.length ? (
              rows.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setPicked(h)}
                  className="block w-full cursor-pointer border-b border-divider px-3 py-1.5 text-left last:border-0 hover:bg-canvas"
                >
                  <span className="block text-sm text-ink">{h.name}</span>
                  <span className="block text-[12px] text-muted">
                    {[h.city, h.region].filter(Boolean).join(" · ")}
                  </span>
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-[13px] text-muted">No shop matches that.</p>
            )}
          </div>
        ) : null}

        {loading ? <p className="text-[13px] text-muted">Working out which list applies…</p> : null}

        {picked && !loading && !answer ? (
          <Callout tone="danger">That shop could not be read.</Callout>
        ) : null}

        {answer ? (
          <div className="space-y-3.5">
            <div>
              <div className="text-base font-semibold text-ink">{answer.customer.name}</div>
              <div className="text-[13px] text-muted">
                {[answer.customer.city, answer.customer.region, answer.customer.salesmanName]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>

            {answer.list ? (
              <div className="rounded-[4px] border border-line p-3.5">
                <div className="flex items-baseline gap-2">
                  <Link
                    href={`${basePath}/${answer.list.id}`}
                    className="text-sm font-medium text-brand hover:underline"
                  >
                    {answer.list.name}
                  </Link>
                  <Badge tone={LIST_STATUS_TONE[answer.list.status]}>
                    {LIST_STATUS_LABEL[answer.list.status]}
                  </Badge>
                </div>
                <div className="mt-0.5 text-[13px] text-muted">{listSummary(answer.list)}</div>
              </div>
            ) : (
              <Callout tone="warn">
                No list applies to this shop, so nothing prices it. The chain
                below says where it fell through.
              </Callout>
            )}

            <div>
              <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">Why</div>
              <ResolutionChain resolution={answer.resolution} />
            </div>

            {answer.rates.length ? (
              <div>
                <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
                  What they pay
                </div>
                <div className="max-h-[220px] overflow-auto rounded-[4px] border border-line">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <Th>Product</Th>
                        <Th align="right">Ex GST</Th>
                        <Th align="right">Inclusive</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {answer.rates.map((r) => (
                        <Tr key={r.id}>
                          <Td className={cx("max-w-[320px] truncate", r.offered ? null : "text-muted")} title={r.productName}>
                            {r.productName}
                          </Td>
                          <Td align="right">{r.offered ? money(r.rateExGstPaise) : "—"}</Td>
                          <Td align="right">{r.offered ? money(r.rateInclGstPaise) : "—"}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
