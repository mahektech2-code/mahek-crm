import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpScreen } from "@/lib/erp/registry";
import { listPlans, planCatalogue, planView, syncPlanFromOrders, underProcessLines } from "@/lib/erp/production-plan";
import { orderDemand } from "@/lib/erp/engines/production-plan";
import { calendarDate } from "@/lib/business-date";
import { nowMs } from "@/lib/format";
import { Page } from "../_ui/page-head";
import { PlanEditor, PlanList } from "./plan-screen";

/**
 * UNDER PROCESS — the Production Head's daily production plan. With no plan
 * named it is the list: today's plan, if there is one, and the plans before
 * it, searchable by date. With one named it is that plan: its lines by work
 * category, what each would draw on, and Print.
 */
export const dynamic = "force-dynamic";

const SCREEN = erpScreen("underProcess")!;

export default async function UnderProcess({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("underProcess")) redirect("/erp");
  const sp = await searchParams;
  const today = calendarDate(new Date(nowMs()));
  const planId = typeof sp.plan === "string" ? sp.plan : null;
  const readOnly = ctx.viewingAs != null;

  if (planId) {
    /* The orders under process come in by themselves; a preview writes nothing. */
    if (!readOnly) await syncPlanFromOrders(planId);
    const [plan, items] = await Promise.all([planView(planId), planCatalogue()]);
    /* A past day's plan is the record of that day: shown, never changed or printed again. */
    if (plan) return <PlanEditor plan={plan} items={items} today={today} readOnly={readOnly || plan.planDate < today} past={plan.planDate < today} />;
  }

  const date = typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : null;
  const [todays, previous] = await Promise.all([listPlans({ date: today }), listPlans({ date, limit: 60 })]);
  const todaysPlan = todays[0] ?? null;
  /* The banner counts the orders the plan would carry: today's plan's godown where there is a plan, else where this person works. */
  const godownId = todaysPlan ? todaysPlan.godownId : (ctx.workingGodown?.id ?? null);
  const godown = todaysPlan ? todaysPlan.godown : (ctx.workingGodown?.name ?? null);
  const waiting = await underProcessLines(godownId);
  const products = orderDemand(waiting).length;
  return (
    <Page title={SCREEN.label}>
      <PlanList
        today={today}
        todays={todaysPlan}
        previous={previous.filter((p) => p.planDate !== today || date)}
        date={date}
        underProcess={{ lines: waiting.length, orders: new Set(waiting.map((w) => w.orderNo)).size, products, godown }}
        readOnly={readOnly}
        missing={planId != null}
      />
    </Page>
  );
}
