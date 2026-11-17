"use client";

import * as React from "react";
import Link from "next/link";
import { Button, Input, Th, Td, Tr, buttonClass, checkboxClass, cx } from "@/components/ui/primitives";
import { fd, nf } from "@/lib/erp/ui";
import type { MrpBoardOrder } from "@/lib/erp/screens/order-hub";
import { clock } from "@/lib/format";
import { BoardHeader, Pill } from "../_ui/board";
import { useErpUi } from "../_ui/erp-ui";
import { useKit } from "../_ui/kit";
import { Eyebrow } from "../_ui/look";

/* ---------------------------------------------------------------------------
 * THE MRP CHECK BOARD: the orders waiting for the Production Head on the left,
 * the chosen one's answer on the right. Clear for production and Hold are the
 * MRP list's own actions on the server (`mrpActions`), so who may clear, and
 * that a held order is released in To Hold, are unchanged.
 * ------------------------------------------------------------------------- */

const SCREEN = "mrpCheck";

export function MrpBoard({
  orders,
  initialOpen,
  orderLinks,
  toHoldHref,
  readOnly,
}: {
  orders: MrpBoardOrder[];
  initialOpen: string | null;
  orderLinks: Record<number, string>;
  toHoldHref: string;
  readOnly: boolean;
}) {
  const [openId, setOpenId] = React.useState<string | null>(initialOpen ?? orders.find((o) => !o.held)?.id ?? orders[0]?.id ?? null);
  const open = orders.find((o) => o.id === openId) ?? null;
  return (
    <div className="flex min-h-full">
      <aside className="w-[290px] flex-none border-r border-line bg-surface">
        <div className="px-4 pt-6 pb-3">
          <div role="heading" aria-level={1} className="text-lg leading-7 font-semibold text-ink">
            MRP check
          </div>
          <span className="text-meta text-body">Approved by accounts, waiting for you</span>
        </div>
        {orders.length ? (
          <ul>
            {orders.map((o) => {
              const on = o.id === openId;
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(o.id)}
                    className={cx("block w-full cursor-pointer border-b border-l-[3px] border-b-divider px-4 py-3 text-left", on ? "border-l-success bg-success-soft/60" : "border-l-transparent hover:bg-canvas")}
                  >
                    <span className="block text-sm font-semibold text-ink">
                      Order {o.orderNo} · {o.party}
                    </span>
                    <span className="block text-meta text-muted">
                      {nf(o.litres)} L{o.accountsAt ? ` · accounts approved ${clock(new Date(o.accountsAt))}` : ""}
                    </span>
                    <span className={cx("block text-sm font-medium", o.verdict.tone === "short" ? "text-danger" : "text-success")}>{o.verdict.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-muted">Nothing waiting. An order comes here once Accounts approve it.</p>
        )}
      </aside>
      <div className="min-w-0 flex-1 px-6 pt-6 pb-10">
        {open ? <MrpDetail key={open.id} o={open} orderHref={orderLinks[open.orderNo]} toHoldHref={toHoldHref} readOnly={readOnly} /> : null}
      </div>
    </div>
  );
}

function MrpDetail({ o, orderHref, toHoldHref, readOnly }: { o: MrpBoardOrder; orderHref: string; toHoldHref: string; readOnly: boolean }) {
  const ui = useErpUi();
  const kit = useKit();
  const [capacity, setCapacity] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const clear = o.actions.find((a) => a.id === "clear");
  const hold = o.actions.find((a) => a.id === "hold");

  async function doClear() {
    setBusy(true);
    try {
      const res = await kit.runAction(SCREEN, "clear", o.id, { capacity: capacity ? "Yes" : "", note });
      if (res.ok) ui.toast(res.message ?? "Cleared");
      else ui.toast(res.fieldErrors?.[0]?.message ?? res.error, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <BoardHeader
        title={`Order ${o.orderNo}`}
        sub={[o.toNo ? `from TO-${o.toNo}` : null, o.party, o.dispatchOn ? `due ${fd(o.dispatchOn)}` : null].filter(Boolean).join(" · ")}
        actions={
          <Link href={orderHref} className={buttonClass({ variant: "secondary" })}>
            Edit order
          </Link>
        }
      />
      {o.held ? (
        <div className="rounded-card bg-danger-soft px-4 py-3 text-sm text-danger">
          On hold · {o.held.department}: {o.held.reason}
          {o.held.note ? ` — ${o.held.note}` : ""}.{" "}
          <Link href={toHoldHref} className="font-medium underline">
            Release it in To Hold
          </Link>
        </div>
      ) : null}

      <section>
        <Eyebrow className="mb-2">1 · Finished goods</Eyebrow>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <table className="w-full">
            <thead>
              <tr>
                <Th>Product</Th>
                <Th align="right">Needed</Th>
                <Th align="right">On shelf (free)</Th>
                <Th align="right">To make</Th>
                <Th>Base in tank</Th>
              </tr>
            </thead>
            <tbody>
              {o.goods.map((g, i) => (
                <Tr key={i}>
                  <Td className="text-ink">{g.sku}</Td>
                  <Td align="right" className="text-ink">
                    {g.need}
                  </Td>
                  <Td align="right" className="text-ink">
                    {g.onShelf}
                  </Td>
                  <Td align="right" className="text-ink">
                    {g.toMake}
                  </Td>
                  <Td className={cx("font-medium", g.base.tone === "short" ? "text-danger" : g.base.tone === "ok" ? "text-success" : "text-muted")}>{g.base.text}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
        {o.unknown.length ? <p className="mt-2 text-meta text-muted">{o.unknown.join(", ")}: the product names no base, so its making cannot be checked.</p> : null}
      </section>

      {o.materials.length ? (
        <section>
          <Eyebrow className="mb-2">2 · {o.batchLine ?? "Materials"}</Eyebrow>
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Material</Th>
                  <Th align="right">Needed</Th>
                  <Th align="right">In stock</Th>
                  <Th>Answer</Th>
                </tr>
              </thead>
              <tbody>
                {o.materials.map((m, i) => (
                  <Tr key={i}>
                    <Td className="text-ink">{m.name}</Td>
                    <Td align="right" className="text-ink">
                      {m.need}
                    </Td>
                    <Td align="right" className="text-ink">
                      {m.stock}
                    </Td>
                    <Td className={cx("font-medium", m.short ? "text-danger" : "text-success")}>{m.answer}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {!o.held && !readOnly ? (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-card border border-line bg-surface px-4 py-3.5">
              <Eyebrow className="mb-2 flex items-center gap-2">
                {o.materials.length ? "3" : "2"} · Capacity <Pill tone="brand">New</Pill>
              </Eyebrow>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
                <input type="checkbox" className={checkboxClass} checked={capacity} onChange={(e) => setCapacity(e.target.checked)} />
                The floor can make this{o.dispatchOn ? ` by ${fd(o.dispatchOn)}` : " in time"}
              </label>
              <p className="mt-2 text-meta text-muted">Your call. MahekOne does not know the floor&apos;s capacity.</p>
            </div>
            <div className="rounded-card border border-line bg-surface px-4 py-3.5">
              <Eyebrow className="mb-2">Note</Eyebrow>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={o.materials.some((m) => m.short) ? "When the short material arrives" : "Optional"} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-meta text-muted">Clear even with a shortage when you know it will arrive. It is recorded.</span>
            <span className="ml-auto flex gap-2">
              {hold ? (
                <Button variant="dangerOutline" disabled={!!hold.why} title={hold.why || undefined} onClick={() => ui.act(SCREEN, hold, o.id)}>
                  Hold
                </Button>
              ) : null}
              {clear ? (
                <Button variant="success" disabled={busy || !capacity || !!clear.why} title={clear.why || (!capacity ? "Tick that the floor can make it first" : undefined)} onClick={doClear}>
                  {busy ? "Clearing…" : "Clear for production"}
                </Button>
              ) : null}
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}
