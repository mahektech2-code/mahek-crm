import Link from "next/link";
import type { ErpContext } from "@/lib/erp/access";
import { erpCountsFor } from "@/lib/erp/counts";
import { erpLink } from "@/lib/erp/registry";
import { cx } from "@/components/ui/primitives";

/**
 * THE PURCHASE STAGE BAR. Purchase is one line — requirement, PO, receipt,
 * test, bill — and it was five sidebar rows plus three tabs behind one of
 * them, with nothing saying which comes after which. The sidebar now draws the
 * group as one row (`ERP_WORKSPACES`) and every purchase screen draws this bar
 * over its own title: the steps in order, each with the work waiting on it
 * (the same figure the sidebar badge always showed), and the buyer's tools at
 * the end. A step whose screen is not held is not drawn.
 */
type Step = { module: string; screen: string; step: string; label: string; count?: string };

const STEPS: Step[] = [
  { module: "requisitions", screen: "requisitions", step: "1 · Need", label: "Requirements", count: "requisitions" },
  { module: "purchaseOrders", screen: "purchaseOrders", step: "2 · Order", label: "Purchase orders", count: "purchaseOrders" },
  { module: "inward", screen: "register", step: "3 · Gate", label: "Receive", count: "inward" },
  { module: "testing", screen: "testing", step: "4 · Quality", label: "Testing", count: "testing" },
  { module: "register", screen: "register", step: "5 · Accounts", label: "Bills", count: "register" },
];
const TOOLS: Step[] = [
  { module: "quoteManager", screen: "quoteManager", step: "Buyer's tool", label: "Supplier rates" },
  { module: "barcode", screen: "register", step: "After receipt", label: "Drum labels" },
];

/** The purchase screens' module keys — a page draws the bar when its module is one of them. */
export const PURCHASE_STAGE_MODULES: ReadonlySet<string> = new Set([...STEPS, ...TOOLS].map((s) => s.module));

export async function PurchaseStages({ ctx, current }: { ctx: ErpContext; current: string }) {
  const held = (s: Step) => ctx.screens.has(s.screen);
  const steps = STEPS.filter(held);
  const tools = TOOLS.filter(held);
  if (steps.length + tools.length < 2) return null;
  const counts = await erpCountsFor(ctx, steps.flatMap((s) => (s.count ? [s.count] : [])).join(",")).catch(() => ({}) as Record<string, number>);
  const cell = (s: Step, tool: boolean) => {
    const on = s.module === current;
    const n = s.count ? (counts[s.count] ?? 0) : 0;
    return (
      <Link
        key={s.module}
        href={erpLink(s.module)}
        aria-current={on ? "page" : undefined}
        className={cx(
          "flex min-w-0 flex-col gap-0.5 border-l border-divider px-4 py-2.5 first:border-l-0",
          tool ? "flex-[0_1_150px] bg-page/60" : "flex-[1_1_130px]",
          on ? "bg-brand-soft shadow-[inset_0_-3px_0_var(--color-brand)]" : "hover:bg-brand-soft/40",
        )}
      >
        <span className="text-2xs font-medium text-muted">{s.step}</span>
        <span className={cx("flex items-center gap-1.5 text-sm whitespace-nowrap", on ? "font-semibold text-brand-deep" : "font-semibold text-ink")}>
          {s.label}
          {n ? <span className="min-w-5 rounded-full bg-brand px-1.5 text-center text-2xs leading-[18px] font-bold text-white">{n}</span> : null}
        </span>
      </Link>
    );
  };
  return (
    <nav aria-label="Purchase steps" className="mb-5 flex flex-wrap overflow-hidden rounded-card border border-line bg-surface">
      {steps.map((s) => cell(s, false))}
      {tools.map((s) => cell(s, true))}
    </nav>
  );
}
