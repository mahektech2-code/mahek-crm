"use client";

/* ---------------------------------------------------------------------------
 * WHAT THIS SHOP PAYS — on the record, where the call is prepared.
 *
 * The telecaller's half of the price list module. Everything else in it is
 * about lists; this is about ONE customer, read by somebody who is about to
 * ring them, so it answers the three questions that get asked on a call in
 * that order: what is the price, why is it that, and what do I do if they
 * want a different one.
 *
 * GST-INCLUSIVE IS THE DEFAULT READING. The shopkeeper quotes inclusive and
 * the list prints inclusive; ex-GST is what the ledger stores and what the
 * bill shows, so both are on the row and the toggle decides which is the big
 * figure. Per litre is beside them because it is the only way to read a 20 L
 * can against a 1 L one.
 *
 * TWO BADGES EARN THEIR PLACE. An expired list is one nobody has replaced,
 * and quoting off it is quoting a price the office may not honour. A list
 * that has CHANGED since their last order is the sentence a telecaller has to
 * say out loud before the customer finds it out from the invoice — the
 * previous list is named, because "it changed" without saying from what is
 * not something anybody can repeat on a phone.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { Badge, Button, Card, Callout } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { money, shortDate } from "@/lib/format";
import {
  FREIGHT_TERM_HINT,
  FREIGHT_TERM_LABEL,
  REQUEST_STATUS_LABEL,
  listSummary,
} from "@/lib/price-list-labels";
import type { CustomerPricing, PricingApp, PricingOptions } from "@/lib/price-list-views";
import { WhyThisPriceModal } from "./modals/why-this-price-modal";
import { SpecialPriceModal } from "./modals/special-price-modal";
import { AssignCustomerListModal } from "./modals/assign-customer-list-modal";

export function CustomerPricesPanel({
  pricing,
  canManage,
  basePath,
  app,
  gstBp,
  lists,
}: {
  pricing: CustomerPricing;
  /** `pricelist.manage` — whether a list can be put on this shop from here. */
  canManage: boolean;
  /** Where this app's price lists live, for the link on the list's name. */
  basePath: string;
  app: PricingApp;
  gstBp: number;
  lists: PricingOptions["lists"];
}) {
  const { push } = useToast();
  const [incl, setIncl] = React.useState(true);
  const [why, setWhy] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const [assigning, setAssigning] = React.useState(false);

  const list = pricing.list;
  const offered = pricing.rates.filter((r) => r.offered);

  /**
   * The list as plain text, for WhatsApp.
   *
   * Built here rather than on the server because it is what is ON THE SCREEN —
   * the same rows in the same order with the same figures — and a second
   * rendering would eventually disagree with the one somebody is looking at.
   */
  async function copy() {
    const header = [
      pricing.customer.name,
      list ? `${list.name}${list.refNo ? ` (${list.refNo})` : ""}` : "No price list applies",
      list ? listSummary(list) : null,
    ]
      .filter(Boolean)
      .join("\n");
    const body = offered
      .map(
        (r) =>
          `${r.productName} — ${money(r.rateInclGstPaise)} incl GST (${money(r.rateExGstPaise)} ex)`,
      )
      .join("\n");
    const terms = pricing.discountTerms.map((t) => t.sentence).join("\n");
    const text = [header, "", body, terms ? `\n${terms}` : ""].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      push("Copied. Paste it into WhatsApp.");
    } catch {
      push("Could not reach the clipboard. Copy the rows by hand.", "error");
    }
  }

  return (
    <>
      <Card className="flex max-h-[420px] flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider px-5 py-3.5">
          <span className="text-lg leading-6 font-semibold text-ink">Prices</span>
          <span className="text-[13px] text-muted">
            {offered.length ? `${offered.length} rates` : "none"}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {list ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`${basePath}/${list.id}`}
                  className="text-sm font-medium text-brand hover:underline"
                >
                  {list.name}
                </Link>
                {list.expired ? (
                  <Badge tone="danger" title="Nobody has replaced it. The office may not honour this rate.">
                    Expired
                  </Badge>
                ) : null}
                {pricing.listChangedSinceLastOrder ? (
                  <Badge
                    tone="warn"
                    title="Say so before they read it off the invoice."
                  >
                    Changed since their last order
                  </Badge>
                ) : null}
                <Badge tone="neutral" title={FREIGHT_TERM_HINT[list.freightTerm]}>
                  {FREIGHT_TERM_LABEL[list.freightTerm]}
                </Badge>
              </div>
              <p className="mt-1 text-[12px] text-muted">{listSummary(list)}</p>
              {pricing.listChangedSinceLastOrder && pricing.lastOrder?.listName ? (
                <p className="mt-1 text-[12px] text-muted">
                  Their last order, {shortDate(pricing.lastOrder.orderedAt)}, was priced
                  from {pricing.lastOrder.listName}.
                </p>
              ) : null}
            </>
          ) : (
            <Callout tone="warn" className="mb-0">
              <span className="text-[13px] text-body">
                No price list applies to this shop. No scope on any list in force today
                names them — not their city, not their state, not their salesman, and no
                list scoped to everybody. Press <strong>Why this price?</strong> for what
                was looked at.
              </span>
            </Callout>
          )}

          {offered.length ? (
            <>
              <div className="mt-3 mb-1 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  Rates
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setIncl(true)}
                    className={
                      incl
                        ? "rounded-[4px] bg-brand-soft px-2 py-0.5 text-[12px] text-brand"
                        : "rounded-[4px] px-2 py-0.5 text-[12px] text-muted"
                    }
                  >
                    Incl GST
                  </button>
                  <button
                    type="button"
                    onClick={() => setIncl(false)}
                    className={
                      !incl
                        ? "rounded-[4px] bg-brand-soft px-2 py-0.5 text-[12px] text-brand"
                        : "rounded-[4px] px-2 py-0.5 text-[12px] text-muted"
                    }
                  >
                    Ex GST
                  </button>
                </div>
              </div>
              <table className="w-full border-collapse text-sm">
                <tbody>
                  {offered.map((r) => (
                    <tr key={r.id} className="border-b border-divider last:border-0">
                      <td className="py-2 pr-2 text-ink">
                        {r.productName}
                        {r.packing ? (
                          <span className="block text-[12px] text-muted">{r.packing}</span>
                        ) : null}
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink">
                        {money(incl ? r.rateInclGstPaise : r.rateExGstPaise)}
                        <span className="block text-[12px] text-muted">
                          {money(incl ? r.rateExGstPaise : r.rateInclGstPaise)}{" "}
                          {incl ? "ex" : "incl"}
                        </span>
                      </td>
                      <td className="w-[86px] py-2 text-right text-[12px] tabular-nums text-muted">
                        {r.perLitrePaise == null ? "—" : `${money(r.perLitrePaise)}/L`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          {/* Where this panel sits beside an order form — which is the CRM and
              not the Sales Dashboard — the rates above are the ones the form
              will price a line at, so say so rather than leave somebody to
              find out whether the two agree. */}
          {app === "crm" && offered.length ? (
            <p className="mt-2 text-[12px] text-muted">
              These are the rates the order form prices a line at on a call.
            </p>
          ) : null}

          {pricing.discountTerms.length ? (
            <ul className="mt-3 space-y-1 text-[12px] text-muted">
              {pricing.discountTerms.map((t) => (
                <li key={t.id}>{t.sentence}</li>
              ))}
            </ul>
          ) : null}

          {pricing.pendingRequests.length ? (
            <div className="mt-4 border-t border-divider pt-3">
              <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                Asked for
              </span>
              {pricing.pendingRequests.map((r) => (
                <div
                  key={r.id}
                  className="flex items-start justify-between gap-3 border-b border-divider py-2 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-ink">{r.productName}</div>
                    <div className="text-[12px] text-muted">
                      {money(r.requestedRateInclGstPaise)} incl · {r.requestedByName}
                    </div>
                  </div>
                  <Badge tone="warn">{REQUEST_STATUS_LABEL[r.status]}</Badge>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-divider px-5 py-3">
          <Button size="sm" variant="secondary" onClick={() => setWhy(true)}>
            Why this price?
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!offered.length}
            title={!offered.length ? "There is no rate to ask for a difference against." : undefined}
            onClick={() => setAsking(true)}
          >
            Ask for a special price
          </Button>
          {canManage ? (
            <Button size="sm" variant="secondary" onClick={() => setAssigning(true)}>
              Assign a list
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={!offered.length}
            title={!offered.length ? "Nothing to copy." : undefined}
            onClick={() => void copy()}
          >
            Copy price list
          </Button>
        </div>
      </Card>

      <WhyThisPriceModal
        open={why}
        onClose={() => setWhy(false)}
        customerName={pricing.customer.name}
        resolution={pricing.resolution}
      />

      {asking ? (
        <SpecialPriceModal
          open
          onClose={() => setAsking(false)}
          customerId={pricing.customer.id}
          customerName={pricing.customer.name}
          rates={pricing.rates}
          gstBp={list?.gstBp ?? gstBp}
        />
      ) : null}

      {assigning ? (
        <AssignCustomerListModal
          open
          onClose={() => setAssigning(false)}
          customerId={pricing.customer.id}
          customerName={pricing.customer.name}
          lists={lists}
          currentListId={list?.id ?? null}
        />
      ) : null}
    </>
  );
}
