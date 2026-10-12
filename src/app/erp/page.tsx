import { APP_TIMEZONE } from "@/lib/business-date";
import Link from "next/link";
import { erpContext } from "@/lib/erp/access";
import { accuracyFlow, dashboardSections, latestDigest } from "@/lib/erp/dashboard";
import { Callout, Card, cx, Dot } from "@/components/ui/primitives";
import { Icon } from "@/components/shell/icons";
import { crmTone } from "./_ui/badge";
import { Page } from "./_ui/page-head";
import { CardGrid } from "@/components/ui/card-grid";

/**
 * The ERP dashboard. It only ever shows sections for screens the person holds,
 * and money figures only with the power that reveals them.
 */
export default async function ErpDashboard() {
  const ctx = await erpContext();
  const where = ctx.workingGodown?.name ?? null;
  const [sections, digest, flow] = await Promise.all([dashboardSections(ctx, where), latestDigest(), accuracyFlow(ctx, where)]);
  const first = ctx.user.name.split(" ")[0];
  const hour = Number(new Date().toLocaleString("en-IN", { timeZone: APP_TIMEZONE, hour: "numeric", hour12: false }));
  const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const today = new Date().toLocaleDateString("en-IN", { timeZone: APP_TIMEZONE, weekday: "long", day: "numeric", month: "short", year: "numeric" });
  const moneyOff = !ctx.powers.has("viewPurchaseMoney") && !ctx.powers.has("viewSalesAmounts");

  return (
    <Page title="Dashboard" sub={`${hello}, ${first} · ${today} · ${where ?? "All godowns"}`}>
      {moneyOff ? <p className="-mt-3 mb-4 text-meta text-muted">Money figures are not on your account.</p> : null}
      {digest ? (
        <Callout tone="brand" className="mb-4 block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-brand-hover uppercase">Yesterday · {digest.day}</span>
          <span className="text-sm leading-[21px] text-ink">{digest.text}</span>
        </Callout>
      ) : null}
      {flow ? (
        <Card className="mb-4 overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-divider px-5 py-3.5">
            <span className="text-base font-semibold text-ink">Stock accuracy</span>
            {flow.accuracy.counted ? (
              <span className="text-meta text-muted">
                <span className="font-semibold text-ink tabular-nums">{Math.round((flow.accuracy.matched / flow.accuracy.counted) * 100)}%</span> counted right first time · 30 days
              </span>
            ) : null}
          </div>
          <CardGrid min={100} gap="gap-0">
            {flow.steps.map((st, i) => {
              const hot = st.v > 0 && st.tone ? st.tone : undefined;
              return (
                <Link
                  key={st.l}
                  href={st.href}
                  className="flex min-w-0 flex-col gap-1 border-r border-b border-divider px-4 py-3 no-underline hover:bg-canvas hover:no-underline"
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
                    <span className="text-line-strong tabular-nums">{i + 1}</span>
                    <span className="truncate" title={st.l}>
                      {st.l}
                    </span>
                  </span>
                  <span className={cx("text-xl leading-7 font-semibold tabular-nums", !st.v ? "text-line-strong" : hot === "danger" ? "text-danger" : hot === "warn" ? "text-warn-ink" : "text-ink")}>{st.v}</span>
                  <span className="text-xs leading-4 text-muted">{st.sub}</span>
                </Link>
              );
            })}
          </CardGrid>
        </Card>
      ) : null}
      {sections.length === 0 ? (
        <Card className="mb-4 px-5 py-3.5 text-sm text-body">Nothing on your account has figures yet. Sections appear as your screens start recording work.</Card>
      ) : null}
      <div className="columns-[360px] gap-4">
        {sections.map((s) => (
          <Card key={s.t} className="mb-4 inline-block w-full break-inside-avoid overflow-hidden">
            <div className="border-b border-divider px-5 py-3 text-base font-semibold text-ink">{s.t}</div>
            {s.tiles.map((t) => {
              const zero = /^\D*0\D*$/.test(String(t.v));
              const hot = t.tone && !zero ? t.tone : undefined;
              return (
                <Link
                  key={t.l}
                  href={t.href}
                  className="group flex w-full items-center gap-3 border-b border-divider px-5 py-2.5 text-left no-underline last:border-0 hover:bg-canvas hover:no-underline"
                >
                  <Dot tone={hot ? crmTone(hot) : "neutral"} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{t.l}</span>
                    {t.sub ? <span className="mt-px block text-xs text-muted">{t.sub}</span> : null}
                  </span>
                  <span className={cx("text-lg font-semibold whitespace-nowrap tabular-nums", zero ? "text-line-strong" : hot === "danger" ? "text-danger" : "text-ink")}>{t.v}</span>
                  <Icon name="chevron" size={14} className="flex-none text-line-strong group-hover:text-muted" />
                </Link>
              );
            })}
          </Card>
        ))}
      </div>
    </Page>
  );
}
