"use client";

import * as React from "react";
import { CustomerQuickView } from "./customer-quick-view";

/**
 * THE SHOP'S NAME, WHICH OPENS THE SHOP.
 *
 * Every list in this console names a customer — a visit, an order, a receipt, a
 * bill, a sample, a task — and on all of them it was plain text. The salesman
 * beside it was a link to his record and the shop was nothing, so a manager
 * reading "₹48,000 order, over the limit" had no way to ask the obvious next
 * question: who is this shop, what do they already owe, when did they last buy.
 *
 * There is no customer RECORD page in this app — that lives in the CRM, which
 * a sales manager may not hold — so this opens the same quick-view drawer
 * Territory's and the Live map's pins open, reading the same endpoint. One
 * answer about one account, wherever it is asked from.
 *
 * It is a BUTTON rather than a link because the destination is a drawer, and a
 * link that does not navigate is a link people middle-click and get a blank
 * tab from. It carries the same hover as `EntityLink` so the two read as one
 * affordance on a row that has both.
 */
export function CustomerName({
  id,
  name,
  muted,
}: {
  /** Null where the row names no customer — a task with no shop behind it. */
  id: string | null;
  name: string | null;
  /** What to draw where there is no name at all. */
  muted?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);

  if (!name) return <>{muted ?? <span className="text-muted">—</span>}</>;
  /* A name with no id is a name off a sheet that never matched an account.
     Drawn plainly rather than as a control that opens an empty drawer. */
  if (!id) return <span title="Not matched to an account">{name}</span>;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Open this shop"
        className="max-w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-sm text-body underline-offset-2 hover:text-brand hover:underline"
      >
        {name}
      </button>
      {open ? (
        <CustomerQuickView customerId={id} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
