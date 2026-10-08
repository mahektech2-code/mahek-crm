"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import type { PayoutPo, PayoutSupplier, PayoutView } from "@/lib/services/vendor-payout-service";
import { InfoTip } from "./info-tip";
import { MoneyInSection, type CashInProps } from "./money-in-section";
import { OverviewSection } from "./overview-section";
import { PayoutsSection } from "./payouts-section";

/* ---------------------------------------------------------------------------
 * CASH FLOW — one screen for money going out and money coming in.
 *
 * Three tabs on one URL (`?view=`): the Overview is inflows against outflows
 * on one daily axis; Receivables is the collections forecast, customer by
 * date; Payables is the vendor payouts, vendor by date, dragged between
 * payment runs. Explanations live behind an "i", not on the screen.
 * ------------------------------------------------------------------------- */

export type CashFlowView = "overview" | "in" | "out";

export function CashFlowScreen({
  view: initialView,
  today,
  cashIn,
  payouts,
  suppliers,
  pos,
  paymentDays,
  defaultCreditDays,
  modes,
  canEdit,
  canSettle,
}: {
  view: CashFlowView;
  today: string;
  cashIn: CashInProps;
  payouts: PayoutView[];
  suppliers: PayoutSupplier[];
  pos: PayoutPo[];
  paymentDays: string[];
  defaultCreditDays: number;
  modes: string[];
  canEdit: boolean;
  canSettle: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [view, setView] = React.useState<CashFlowView>(initialView);

  function go(next: CashFlowView) {
    setView(next);
    router.replace(next === "overview" ? pathname : `${pathname}?view=${next}`, { scroll: false });
  }

  const counts = {
    in: cashIn.items.filter((i) => i.expectedOn >= today).length,
    out: payouts.filter((p) => p.status === "open" || p.status === "on_hold").length,
  };

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[28px] leading-[34px] font-semibold text-ink">Cash flow</h1>
          <InfoTip>
            Projected inflows from open invoices against scheduled outflows to vendors, day by day, in IST. Inflows are
            projected from each customer&apos;s actual average days to pay, not from credit terms.
          </InfoTip>
        </div>
        <nav className="flex rounded-[8px] border border-line bg-canvas p-1" aria-label="Cash flow views">
          {(
            [
              ["overview", "Overview", null],
              ["in", "Receivables", counts.in],
              ["out", "Payables", counts.out],
            ] as const
          ).map(([key, label, n]) => (
            <button
              key={key}
              type="button"
              onClick={() => go(key)}
              aria-current={view === key ? "page" : undefined}
              className={cx(
                "flex h-8 cursor-pointer items-center gap-2 rounded-[6px] px-3.5 text-[13px] font-medium transition-colors",
                view === key ? "bg-surface text-ink shadow-[0_1px_3px_rgba(22,22,22,0.12)]" : "text-muted hover:text-body",
              )}
            >
              {label}
              {n ? (
                <span
                  className={cx(
                    "rounded-full px-1.5 text-[11px] tabular-nums",
                    view === key ? "bg-brand-soft text-[#5223E0]" : "bg-divider text-muted",
                  )}
                >
                  {n}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </div>

      {view === "overview" ? (
        <OverviewSection ins={cashIn.items} outs={payouts} today={today} onGo={go} />
      ) : view === "in" ? (
        <MoneyInSection data={cashIn} today={today} />
      ) : (
        <PayoutsSection
          payouts={payouts}
          suppliers={suppliers}
          pos={pos}
          today={today}
          paymentDays={paymentDays}
          defaultCreditDays={defaultCreditDays}
          modes={modes}
          canEdit={canEdit}
          canSettle={canSettle}
        />
      )}
    </div>
  );
}
