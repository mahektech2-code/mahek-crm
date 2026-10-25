import { calendarDate, isoWeekday, localMinutesSince, type BusinessDate } from "@/lib/business-date";
import { longDate } from "@/lib/format";
import { NavLink } from "@/components/shell/nav-link";
import { erpContext } from "@/lib/erp/access";
import { withReadMemo } from "@/lib/erp/read-memo";
import { accuracyFlow, dashboardSections, latestDigest } from "@/lib/erp/dashboard";
import { Callout, Card, cx, Dot, SectionLabel } from "@/components/ui/primitives";
import { Icon } from "@/components/shell/icons";
import { crmTone } from "./_ui/badge";
import { Page } from "./_ui/page-head";
import { eyebrowClass, SectionTitle } from "./_ui/look";
import { CardGrid } from "@/components/ui/card-grid";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * The ERP dashboard. It only ever shows sections for screens the person holds,
 * and money figures only with the power that reveals them.
 */
export default async function ErpDashboard() {
  const ctx = await erpContext();
  const where = ctx.workingGodown?.name ?? null;
  const [sections, digest, flow] = await withReadMemo(() => Promise.all([dashboardSections(ctx, where), latestDigest(), accuracyFlow(ctx, where)]));
  const first = ctx.user.name.split(" ")[0];
  const now = new Date();
  const day = calendarDate(now);
  const hour = Math.floor((localMinutesSince(day, now) ?? 0) / 60);
  const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const today = `${WEEKDAYS[isoWeekday(day as string as BusinessDate) - 1]}, ${longDate(day)}`;
  const moneyOff = !ctx.powers.has("viewPurchaseMoney") && !ctx.powers.has("viewSalesAmounts");

  return (
    <Page title="Dashboard" sub={`${hello}, ${first} · ${today} · ${where ?? "All godowns"}`}>
      {moneyOff ? <p className="-mt-3 mb-5 text-meta text-muted">Money figures are not on your account.</p> : null}
      {digest ? (
        <Callout tone="brand" className="mb-5 block">
          <SectionLabel className="mb-1">Yesterday · {digest.day}</SectionLabel>
          <span className="text-sm leading-[21px] text-ink">{digest.text}</span>
        </Callout>
      ) : null}
      {flow ? (
        <Card className="mb-5 overflow-hidden">
          <SectionTitle
            className="mb-0 border-b border-divider px-5 py-3"
            aside={
              flow.accuracy.counted ? (
                <>
                  <span className="font-semibold text-ink tabular-nums">{Math.round((flow.accuracy.matched / flow.accuracy.counted) * 100)}%</span> counted right first time · 30 days
                </>
              ) : null
            }
          >
            Stock accuracy
          </SectionTitle>
          <CardGrid min={100} gap="gap-0">
            {flow.steps.map((st, i) => {
              const hot = st.v > 0 && st.tone ? st.tone : undefined;
              return (
                <NavLink
                  key={st.l}
                  href={st.href}
                  className="flex min-w-0 flex-col gap-1 border-r border-b border-divider px-4 py-3 no-underline hover:bg-canvas hover:no-underline"
                >
                  <span className={cx("flex items-center gap-1.5", eyebrowClass)}>
                    <span className="text-line-strong tabular-nums">{i + 1}</span>
                    <span className="truncate" title={st.l}>
                      {st.l}
                    </span>
                  </span>
                  <span className={cx("text-xl leading-7 font-semibold tabular-nums", !st.v ? "text-line-strong" : hot === "danger" ? "text-danger" : hot === "warn" ? "text-warn-ink" : "text-ink")}>{st.v}</span>
                  <span className="text-xs leading-4 text-muted">{st.sub}</span>
                </NavLink>
              );
            })}
          </CardGrid>
        </Card>
      ) : null}
      {sections.length === 0 ? (
        <Card className="mb-5 px-5 py-3 text-sm text-body">Nothing on your account has figures yet. Sections appear as your screens start recording work.</Card>
      ) : null}
      <div className="columns-[360px] gap-5">
        {sections.map((s) => (
          <Card key={s.t} className="mb-5 inline-block w-full break-inside-avoid overflow-hidden">
            <SectionTitle className="mb-0 border-b border-divider px-5 py-3">{s.t}</SectionTitle>
            {s.tiles.map((t) => {
              const zero = /^\D*0\D*$/.test(String(t.v));
              const hot = t.tone && !zero ? t.tone : undefined;
              return (
                <NavLink
                  key={t.l}
                  href={t.href}
                  className="group flex w-full items-center gap-3 border-b border-divider px-5 py-2.5 text-left no-underline last:border-0 hover:bg-canvas hover:no-underline"
                >
                  <Dot tone={hot ? crmTone(hot) : "neutral"} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{t.l}</span>
                    {t.sub ? <span className="mt-px block text-meta text-muted">{t.sub}</span> : null}
                  </span>
                  <span className={cx("text-lg font-semibold whitespace-nowrap tabular-nums", zero ? "text-line-strong" : hot === "danger" ? "text-danger" : "text-ink")}>{t.v}</span>
                  <Icon name="chevron" size={14} className="flex-none text-line-strong group-hover:text-muted" />
                </NavLink>
              );
            })}
          </Card>
        ))}
      </div>
    </Page>
  );
}
