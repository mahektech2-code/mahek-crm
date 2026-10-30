"use client";

/* ---------------------------------------------------------------------------
 * OVERRIDES — every special price, with the days it holds.
 *
 * A special price used to be a rate typed into a shop's agreed list that lasted
 * until somebody remembered it. Each one here carries its start, its end and,
 * where it was agreed against a volume, that volume beside what the shop
 * actually bought last month — so "is this still earning its discount" is a
 * column, not a memory.
 *
 * The gap to the book is the column read first, in percent beside the rupees:
 * ₹100 off a 2,300 can and off a 300 can are different conversations.
 *
 * The CRM door draws no write control at all (`canManage` false); every action
 * re-checks the Price Desk on the server regardless.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Card, EmptyState, Field, Input, MoneyInput, Select, Td, Textarea, Th, Tr } from "@/components/ui/primitives";
import { FilterPills, Modal, RowMenu } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { longDate, money, parseRupees } from "@/lib/format";
import { daysUntil, OVERRIDE_STATE_LABEL } from "@/lib/engines/price-overrides";
import { addDays } from "@/lib/business-date";
import { cancelOverride, createOverride, endOverride, extendOverride } from "@/lib/actions/price-overrides";
import type { OverrideView } from "@/lib/price-book-views";
import type { CustomerHit, CustomerPricing } from "@/lib/price-list-views";
import { ShopSearch } from "./shop-search";

type Tab = "live" | "scheduled" | "ending" | "below" | "ended";

const STATE_TONE: Record<OverrideView["state"], "success" | "brand" | "muted" | "danger"> = {
  live: "success",
  scheduled: "brand",
  ended: "muted",
  cancelled: "danger",
};

function belowCondition(o: OverrideView): boolean {
  return o.state === "live" && o.minCansPerMonth != null && (o.lastMonthCans ?? 0) < o.minCansPerMonth;
}

export function OverridesScreen({
  basePath,
  canManage,
  todayIso,
  endingDays,
  overrides,
  askers,
}: {
  basePath: string;
  canManage: boolean;
  todayIso: string;
  /** `pricing.overrides.reminderDays` — what "ending soon" means. */
  endingDays: number;
  overrides: OverrideView[];
  /** Who asked for the request behind an override, by request id. */
  askers: Record<string, string>;
}) {
  const router = useRouter();
  const { run, push } = useToast();
  const [tab, setTab] = React.useState<Tab>("live");
  const [creating, setCreating] = React.useState(false);
  const [ending, setEnding] = React.useState<OverrideView | null>(null);
  const [extending, setExtending] = React.useState<OverrideView | null>(null);
  const [cancelling, setCancelling] = React.useState<OverrideView | null>(null);

  const isEnding = (o: OverrideView) => o.state === "live" && o.validTo != null && daysUntil(todayIso, o.validTo) <= endingDays;
  const byTab: Record<Tab, OverrideView[]> = {
    live: overrides.filter((o) => o.state === "live"),
    scheduled: overrides.filter((o) => o.state === "scheduled"),
    ending: overrides.filter(isEnding),
    below: overrides.filter(belowCondition),
    ended: overrides.filter((o) => o.state === "ended" || o.state === "cancelled"),
  };
  const rows = byTab[tab];

  async function done<T extends { ok: boolean; message?: string; error?: string; warnings?: string[] }>(p: Promise<T>): Promise<T> {
    const r = await run(p);
    if (r.ok) {
      for (const w of r.warnings ?? []) push(w);
      router.refresh();
    }
    return r;
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterPills
          value={tab}
          onChange={setTab}
          options={[
            { key: "live", label: "Live", count: byTab.live.length },
            { key: "scheduled", label: "Starts later", count: byTab.scheduled.length },
            { key: "ending", label: "Ending soon", count: byTab.ending.length },
            { key: "below", label: "Below condition", count: byTab.below.length },
            { key: "ended", label: "Ended & cancelled", count: byTab.ended.length },
          ]}
        />
        {canManage ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            New override
          </Button>
        ) : null}
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={
              tab === "live"
                ? "No special price is live"
                : tab === "scheduled"
                  ? "Nothing starts later"
                  : tab === "ending"
                    ? `Nothing ends in the next ${endingDays} days`
                    : tab === "below"
                      ? "Every shop is meeting its volume"
                      : "Nothing has ended or been cancelled lately"
            }
            body="A special price is made here, or by approving a request on the Requests tab."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] border-collapse text-sm">
              <thead>
                <tr>
                  <Th>Shop</Th>
                  <Th>Product</Th>
                  <Th align="right">Special price</Th>
                  <Th align="right">Book price</Th>
                  <Th>From → until</Th>
                  <Th>Condition</Th>
                  <Th>State</Th>
                  <Th>Asked by</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const gap =
                    o.bookExGstPaise && o.bookExGstPaise > 0
                      ? Math.round(((o.rateExGstPaise - o.bookExGstPaise) / o.bookExGstPaise) * 1000) / 10
                      : null;
                  const open = o.state === "live" || o.state === "scheduled";
                  const items = canManage && open
                    ? [
                        { label: "Extend", onSelect: () => setExtending(o) },
                        ...(o.state === "live" ? [{ label: "End", onSelect: () => setEnding(o) }] : []),
                        { label: "Cancel", destructive: true, onSelect: () => setCancelling(o) },
                      ]
                    : [];
                  return (
                    <Tr key={o.id}>
                      <Td>
                        <Link href={`${basePath}/shops/${o.customerId}`} className="text-brand hover:underline">
                          {o.customerName}
                        </Link>
                      </Td>
                      <Td>{o.productName}</Td>
                      <Td align="right">
                        {money(o.rateInclGstPaise)}
                        <div className="text-[12px] text-muted">{money(o.rateExGstPaise)} ex</div>
                      </Td>
                      <Td align="right">
                        {o.bookExGstPaise == null ? (
                          <span className="text-muted">not on its book</span>
                        ) : (
                          <>
                            {money(o.bookExGstPaise)} ex
                            {gap != null ? (
                              <div className={gap < 0 ? "text-[12px] text-danger" : "text-[12px] text-success"}>
                                {gap > 0 ? "+" : ""}
                                {gap}%
                              </div>
                            ) : null}
                          </>
                        )}
                      </Td>
                      <Td>
                        {longDate(o.validFrom)} → {o.validTo ? longDate(o.validTo) : <span className="text-muted">no end</span>}
                        {isEnding(o) ? <div className="text-[12px] text-warn-ink">ends in {daysUntil(todayIso, o.validTo!)} days</div> : null}
                      </Td>
                      <Td>
                        {o.minCansPerMonth == null ? (
                          <span className="text-muted">none</span>
                        ) : (
                          <>
                            {o.minCansPerMonth} cans/month
                            <div className={belowCondition(o) ? "text-[12px] text-danger" : "text-[12px] text-muted"}>
                              last month {o.lastMonthCans ?? 0}
                            </div>
                          </>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={STATE_TONE[o.state]}>{OVERRIDE_STATE_LABEL[o.state]}</Badge>
                      </Td>
                      <Td>
                        {o.requestId ? (askers[o.requestId] ?? "—") : <span className="text-muted">set by {o.createdByName ?? "—"}</span>}
                        {o.note ? (
                          <span className="block max-w-[200px] truncate text-[12px] text-muted" title={o.note}>
                            {o.note}
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right">{items.length ? <RowMenu items={items} /> : null}</Td>
                    </Tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating ? <NewOverrideModal todayIso={todayIso} onClose={() => setCreating(false)} onSave={(p) => done(p)} /> : null}
      {ending ? (
        <EndModal key={ending.id} o={ending} todayIso={todayIso} onClose={() => setEnding(null)} onSave={(d, reason) => done(endOverride(ending.id, d, reason))} />
      ) : null}
      {extending ? (
        <ExtendModal key={extending.id} o={extending} todayIso={todayIso} onClose={() => setExtending(null)} onSave={(d) => done(extendOverride(extending.id, d))} />
      ) : null}
      {cancelling ? (
        <CancelModal key={cancelling.id} o={cancelling} onClose={() => setCancelling(null)} onSave={(reason) => done(cancelOverride(cancelling.id, reason))} />
      ) : null}
    </>
  );
}

type Saver = (p: ReturnType<typeof createOverride>) => Promise<{ ok: boolean; fieldErrors?: Array<{ field: string; message: string }> }>;

function DateInput({ value, onChange, min }: { value: string; onChange: (v: string) => void; min?: string }) {
  return (
    <input
      type="date"
      value={value}
      min={min}
      onChange={(e) => onChange(e.target.value)}
      className="h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
    />
  );
}

function NewOverrideModal({ todayIso, onClose, onSave }: { todayIso: string; onClose: () => void; onSave: Saver }) {
  const [shop, setShop] = React.useState<CustomerHit | null>(null);
  const [pricing, setPricing] = React.useState<{ id: string; value: CustomerPricing | null } | null>(null);
  const [productId, setProductId] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [from, setFrom] = React.useState(todayIso);
  const [until, setUntil] = React.useState(addDays(todayIso, 90));
  const [noEnd, setNoEnd] = React.useState(false);
  const [minCans, setMinCans] = React.useState("");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!shop) return;
    const id = shop.id;
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
  }, [shop]);

  const loaded = shop && pricing?.id === shop.id ? pricing.value : null;
  const products = (loaded?.rates ?? []).filter((r) => r.offered && (r.minCans ?? 0) === 0);
  const picked = products.find((r) => r.productId === productId) ?? null;
  const incl = parseRupees(price);
  const gap = picked && incl ? Math.round(((incl - picked.rateInclGstPaise) / picked.rateInclGstPaise) * 1000) / 10 : null;

  async function save() {
    setError(null);
    if (!shop) return setError("Choose the shop.");
    if (!productId) return setError("Choose the product.");
    if (!incl || incl <= 0) return setError("Type the special price, GST inclusive.");
    const min = minCans.trim() ? Number(minCans) : null;
    setBusy(true);
    try {
      const r = await onSave(
        createOverride({
          customerId: shop.id,
          productId,
          rateInclGstPaise: incl,
          validFrom: from,
          validTo: noEnd ? null : until,
          minCansPerMonth: min,
          note,
        }),
      );
      if (r.ok) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New special price"
      width={600}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {shop ? (
          <div className="flex items-center justify-between rounded-[4px] border border-line bg-canvas px-3 py-2 text-sm">
            <span>
              <strong>{shop.name}</strong> <span className="text-muted">{shop.city}</span>
            </span>
            <button type="button" className="cursor-pointer text-[13px] text-brand hover:underline" onClick={() => { setShop(null); setProductId(""); }}>
              Change
            </button>
          </div>
        ) : (
          <Field label="Shop">
            <ShopSearch autoFocus onPick={setShop} />
          </Field>
        )}

        {shop ? (
          loaded == null && pricing?.id !== shop.id ? (
            <p className="text-[13px] text-muted">Reading what this shop pays…</p>
          ) : products.length === 0 ? (
            <Callout tone="warn">
              <span className="text-[13px] text-body">No list prices this shop yet, so there is nothing to give a special price against. Put it on a book first.</span>
            </Callout>
          ) : (
            <>
              <Field label="Product">
                <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
                  <option value="">Choose…</option>
                  {products.map((r) => (
                    <option key={r.productId} value={r.productId}>
                      {r.productName} — pays {money(r.rateInclGstPaise)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Special price" hint="GST inclusive, per can.">
                <MoneyInput value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" />
              </Field>
              {gap != null ? (
                <p className="text-[13px] text-muted">
                  That is <span className={gap < 0 ? "text-danger" : "text-success"}>{gap > 0 ? "+" : ""}{gap}%</span> against the{" "}
                  {money(picked!.rateInclGstPaise)} it pays now.
                </p>
              ) : null}
              <div className="flex flex-wrap items-end gap-4">
                <Field label="From">
                  <DateInput value={from} onChange={setFrom} />
                </Field>
                <Field label="Until">
                  <DateInput value={until} onChange={setUntil} min={from} />
                </Field>
                <label className="mb-2 flex items-center gap-2 text-[13px] text-body">
                  <input type="checkbox" checked={noEnd} onChange={(e) => setNoEnd(e.target.checked)} /> No end date
                </label>
              </div>
              <Field label="Minimum cans a month" hint="Optional. The volume it was agreed against; the Overrides list flags a month below it.">
                <Input inputMode="numeric" value={minCans} onChange={(e) => setMinCans(e.target.value.replace(/[^0-9]/g, ""))} />
              </Field>
              <Field label="Note" hint="What was agreed, and with whom.">
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </>
          )
        ) : null}
        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
      </div>
    </Modal>
  );
}

function EndModal({
  o,
  todayIso,
  onClose,
  onSave,
}: {
  o: OverrideView;
  todayIso: string;
  onClose: () => void;
  onSave: (date: string, reason: string) => Promise<{ ok: boolean }>;
}) {
  const [date, setDate] = React.useState(todayIso);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={`End ${o.customerName}'s special price`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="primary"
            disabled={busy || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              const r = await onSave(date, reason);
              setBusy(false);
              if (r.ok) onClose();
            }}
          >
            End it
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-body">
          {o.productName} at {money(o.rateInclGstPaise)}. The last day it applies is the day you choose; the day after, the shop pays its book price
          {o.bookExGstPaise != null ? ` (${money(o.bookExGstPaise)} ex)` : ""}.
        </p>
        <Field label="Last day">
          <DateInput value={date} onChange={setDate} min={addDays(todayIso, -1)} />
        </Field>
        <Field label="Why" hint="The person who asked for it reads this.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ExtendModal({
  o,
  todayIso,
  onClose,
  onSave,
}: {
  o: OverrideView;
  todayIso: string;
  onClose: () => void;
  onSave: (date: string | null) => Promise<{ ok: boolean }>;
}) {
  const start = o.validTo && o.validTo > todayIso ? o.validTo : todayIso;
  const [date, setDate] = React.useState(addDays(start, 90));
  const [noEnd, setNoEnd] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Extend ${o.customerName}'s special price`}
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
              const r = await onSave(noEnd ? null : date);
              setBusy(false);
              if (r.ok) onClose();
            }}
          >
            Extend
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-body">
          {o.productName} at {money(o.rateInclGstPaise)}, now {o.validTo ? `ending ${longDate(o.validTo)}` : "with no end date"}.
          {o.minCansPerMonth != null ? ` Last month they took ${o.lastMonthCans ?? 0} of the ${o.minCansPerMonth} cans it was agreed against.` : ""}
        </p>
        <div className="flex items-end gap-4">
          <Field label="New last day">
            <DateInput value={date} onChange={setDate} min={start} />
          </Field>
          <label className="mb-2 flex items-center gap-2 text-[13px] text-body">
            <input type="checkbox" checked={noEnd} onChange={(e) => setNoEnd(e.target.checked)} /> No end date
          </label>
        </div>
      </div>
    </Modal>
  );
}

function CancelModal({ o, onClose, onSave }: { o: OverrideView; onClose: () => void; onSave: (reason: string) => Promise<{ ok: boolean }> }) {
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Cancel ${o.customerName}'s special price`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            disabled={busy || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              const r = await onSave(reason);
              setBusy(false);
              if (r.ok) onClose();
            }}
          >
            Cancel it
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-body">
          {o.productName} at {money(o.rateInclGstPaise)} comes off at once{o.state === "live" ? " — from today the shop pays its book price" : ""}. Use End instead
          if it applied correctly and is simply finishing.
        </p>
        <Field label="Why" hint="The person who asked for it reads this.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
