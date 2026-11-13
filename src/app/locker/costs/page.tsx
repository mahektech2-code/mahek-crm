import { and, gte, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { lockerRenewals } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerAccess } from "@/lib/locker/access";
import { CATEGORY } from "@/lib/locker/catalogue";
import { addMonthsIso, istDay } from "@/lib/locker/engine";
import { cardRisks, monthlyPaise } from "@/lib/locker/register-service";
import { lockerPaymentMethodsList, registerFor, today } from "@/lib/locker/service";
import { C, MONTHS, fd, inr, nf } from "@/lib/locker/style";
import { Badge } from "@/components/ui/primitives";
import { PageHead } from "../_ui/kit";
import { Alert, Bars, GenTable, Grid, ListBlock, ShareBar, Stat, StatGrid } from "../_ui/register-parts";
import { PaymentMethods } from "./payment-methods";

export const metadata = { title: "Costs" };
export const dynamic = "force-dynamic";

/* ---------------------------------------------------------------------------
 * COSTS — subscription spend by provider and department, the next twelve
 * months of renewals, renewal spend actually recorded, and the cards that
 * will fail first. Every figure is read off the register: nothing here is a
 * modelled history the Locker never saw.
 * ------------------------------------------------------------------------- */

export default async function CostsPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.costs");
  const day = today();
  const [access, rows, pms] = await Promise.all([lockerAccess(user.id), registerFor(user.id, day), lockerPaymentMethodsList()]);
  const live = rows.filter((a) => a.live);
  const subs = live.filter((a) => a.model === "subscription" && a.amountPaise > 0);
  const monthly = subs.reduce((x, a) => x + monthlyPaise(a), 0);
  const cards = await cardRisks(rows, day);
  const visible = new Set(live.map((a) => a.id));

  /* Renewal spend actually recorded, by the month it was completed. */
  const yearAgo = addMonthsIso(`${day.slice(0, 7)}-01`, -11);
  const done = (await db.select({ assetId: lockerRenewals.assetId, cost: lockerRenewals.costPaise, at: lockerRenewals.completedAt }).from(lockerRenewals).where(and(isNotNull(lockerRenewals.completedAt), gte(lockerRenewals.completedAt, new Date(`${yearAgo}T00:00:00+05:30`))))).filter((r) => visible.has(r.assetId) || rows.some((a) => a.id === r.assetId));
  const months = Array.from({ length: 12 }, (_, i) => addMonthsIso(yearAgo, i).slice(0, 7));
  const spent = months.map((mk, i) => {
    const v = done.filter((r) => r.at && istDay(r.at).slice(0, 7) === mk).reduce((s, r) => s + r.cost, 0);
    return { l: MONTHS[Number(mk.slice(5)) - 1], v, tip: inr(v), c: i === 11 ? C.brand : "var(--color-brand-softer)" };
  });

  /* Forecast: monthly subscriptions every month; everything else in the month somebody must act, at its own amount or its type's typical fee. */
  const next = Array.from({ length: 12 }, (_, i) => addMonthsIso(`${day.slice(0, 7)}-01`, i).slice(0, 7));
  const forecast = next.map((mk) => {
    let v = 0;
    for (const a of live) {
      if (a.model === "subscription" && a.billingCycle.toLowerCase().startsWith("month")) {
        v += a.amountPaise;
        continue;
      }
      if (!a.endDate || a.endDate.slice(0, 7) !== mk) continue;
      v += a.model === "subscription" ? a.amountPaise : a.type.typicalCostPaise;
    }
    return { l: MONTHS[Number(mk.slice(5)) - 1], v, tip: inr(v) };
  });

  const byP = new Map<string, number>();
  subs.forEach((a) => byP.set(a.provider || "Unnamed provider", (byP.get(a.provider || "Unnamed provider") ?? 0) + monthlyPaise(a) * 12));
  const prov = [...byP.entries()].sort((a, b) => b[1] - a[1]);
  const byDept = new Map<string, { n: number; v: number }>();
  subs.forEach((a) => {
    const k = a.department || CATEGORY[a.category]?.name || a.category;
    const cur = byDept.get(k) ?? { n: 0, v: 0 };
    byDept.set(k, { n: cur.n + 1, v: cur.v + monthlyPaise(a) * 12 });
  });
  const dupProviders = [...new Set(subs.map((a) => a.provider).filter(Boolean))].map((p) => ({ p, list: subs.filter((a) => a.provider === p) })).filter((x) => x.list.length > 1);
  const dupValue = dupProviders.reduce((s, x) => s + x.list.slice(1).reduce((t, a) => t + monthlyPaise(a) * 12, 0), 0);
  const total = monthly * 12;

  return (
    <>
      <PageHead crumb="Locker · Operations" title="Costs" sub="Subscription spend by provider and department, the next 12 months of renewals, and cards that will fail first." />
      <div className="flex flex-col gap-5 px-6 pb-12">
        {cards.map((x) => (
          <Alert
            key={x.pm.id}
            tone="amber"
            t={`Card ····${x.pm.last4} (${x.pm.label}) expires in ${x.daysLeft} days — ${x.subs.length} auto-renewals are on it`}
            m={`At risk: ${x.subs.map((a) => `${a.title} (${fd(a.endDate)})`).join(", ")}. The charge fails, the service runs out. Move them or update the card now.`}
          />
        ))}
        <StatGrid n={4}>
          <Stat l="Monthly run rate" v={inr(Math.round(monthly))} s="subscriptions, GST extra" />
          <Stat l="Annual" v={inr(Math.round(total))} s={`${nf(subs.length)} subscriptions`} />
          <Stat l="Possible duplicates" v={nf(dupProviders.length)} s={dupProviders.length ? `${inr(dupValue)} a year if each is one too many` : "no provider billed twice"} />
          <Stat l="On expiring cards" v={nf(cards.reduce((x, y) => x + y.subs.length, 0))} s="auto-renewals at risk" red={cards.length > 0} />
        </StatGrid>
        <Grid cols={2}>
          <Bars title="Renewal spend · last 12 months" sub="Costs recorded on completed renewals, INR" bars={spent} note={done.length ? `${nf(done.length)} renewals completed in the period.` : "No renewal has been completed in the Locker yet — this fills in as renewals close."} />
          <Bars title="Renewal forecast · next 12 months" sub="Annual renewals land in their month; monthly ones every month" bars={forecast} note="Documents are forecast at their type’s typical fee; subscriptions at their own amount." />
          <GenTable
            title="By provider"
            sub={`${nf(prov.length)} providers`}
            cols={[
              ["Provider", "minmax(200px,2fr)"],
              ["Annual", "140px"],
              ["Share", "minmax(160px,1fr)"],
            ]}
            rows={prov.map(([p, v]) => ({ cells: [{ t: p }, { t: inr(Math.round(v)) }, { node: <ShareBar t={`${total ? Math.round((v / total) * 100) : 0}%`} p={total ? (v / total) * 300 : 0} /> }] }))}
            emptyLine="No subscription with an amount is in the register yet."
          />
          <ListBlock
            title="Possible duplicate subscriptions"
            sub="The same provider billed more than once. Only a suggestion — a person decides."
            items={dupProviders.map((x) => ({ t: x.p, sub: `${x.list.length} subscriptions: ${x.list.map((a) => `${a.title} (${inr(Math.round(monthlyPaise(a) * 12))}/yr)`).join(", ")}`, badge: <Badge tone="brand">Check</Badge> }))}
            emptyLine="No provider is billed twice."
          />
          <GenTable
            title="By department"
            sub=""
            cols={[
              ["Department", "minmax(200px,1fr)"],
              ["Subscriptions", "120px"],
              ["Annual", "140px"],
            ]}
            rows={[...byDept.entries()].sort((a, b) => b[1].v - a[1].v).map(([k, x]) => ({ cells: [{ t: k }, { t: nf(x.n) }, { t: inr(Math.round(x.v)) }] }))}
            emptyLine="Nothing to show."
          />
          <PaymentMethods
            canEdit={access.has("locker.costs")}
            today={day}
            pms={pms.map((p) => ({ id: p.id, label: p.label, kind: p.kind, last4: p.last4, expiresOn: p.expiresOn, holder: p.holder, bank: p.bank, personal: p.personal, active: p.active, uses: live.filter((a) => a.paymentMethodId === p.id).length }))}
          />
        </Grid>
      </div>
    </>
  );
}
