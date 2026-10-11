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
  const hour = Number(new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }));
  const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "short", year: "numeric" });
  const moneyOff = !ctx.powers.has("viewPurchaseMoney") && !ctx.powers.has("viewSalesAmounts");

  return (
    <Page
      title="Dashboard"
      sub={`${hello}, ${first} · ${today} · stock and godown figures for ${where ?? "all godowns"}${moneyOff ? " · money figures are not on your account" : ""}. Every figure opens the records behind it.`}
    >
      {digest ? (
        <Callout tone="brand" className="block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-[#5223E0] uppercase">
            Yesterday · {digest.day}
            {digest.servedBy && digest.servedBy !== "rules" ? " · summarised by AI from the figures below" : ""}
          </span>
          <span className="text-sm leading-[21px] text-ink">{digest.text}</span>
        </Callout>
      ) : null}
      {flow ? (
        <Card className="mb-4 overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-divider px-5 py-3.5">
            <span className="text-base font-semibold text-ink">Inventory Accuracy Control</span>
            <span className="text-xs text-muted">
              No purchase on a book nobody has counted · never a silent adjustment
              {flow.accuracy.counted ? ` · ${Math.round((flow.accuracy.matched / flow.accuracy.counted) * 100)}% counted right first time over 30 days` : ""}
            </span>
          </div>
          <CardGrid min={132} gap="gap-0">
            {flow.steps.map((st, i) => (
              <div key={st.l} className="min-w-0 border-r border-b border-divider">
                <Link href={st.href} className="flex h-full flex-col gap-0.5 px-4 py-3 no-underline hover:bg-canvas hover:no-underline">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    <span className="grid size-4 flex-none place-items-center rounded-full bg-canvas text-[10px] text-body">{i + 1}</span>
                    <span className="truncate" title={st.l}>
                      {st.l}
                    </span>
                  </span>
                  <span className={cx("text-xl font-semibold tabular-nums", st.tone === "danger" && st.v ? "text-danger" : "text-ink")}>
                    <Dot tone={st.tone && st.v ? crmTone(st.tone) : "neutral"} /> {st.v}
                  </span>
                  <span className="text-xs leading-4 text-muted">{st.sub}</span>
                </Link>
              </div>
            ))}
          </CardGrid>
        </Card>
      ) : null}
      {sections.length <= 2 ? (
        <Card className="mb-4 px-5 py-3.5 text-sm text-body">
          {sections.length === 0
            ? "Nothing on your account has figures to show yet. Sections appear here as the screens you hold start recording work."
            : "You see the sections your role covers. Other parts of the ERP are not on your account."}
        </Card>
      ) : null}
      <div className="columns-[360px] gap-4">
        {sections.map((s) => (
          <Card key={s.t} className="mb-4 inline-block w-full break-inside-avoid overflow-hidden">
            <div className="border-b border-divider px-5 py-3.5 text-base font-semibold text-ink">{s.t}</div>
            {s.tiles.map((t) => {
              const hot = t.tone && Number(String(t.v).replace(/[^\d]/g, "")) > 0 ? t.tone : undefined;
              return (
                <Link
                  key={t.l}
                  href={t.href}
                  className="flex w-full items-center gap-3 border-b border-divider px-5 py-3 text-left no-underline last:border-0 hover:bg-canvas hover:no-underline"
                >
                  <Dot tone={hot ? crmTone(hot) : "neutral"} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{t.l}</span>
                    {t.sub ? <span className="mt-px block text-xs text-muted">{t.sub}</span> : null}
                  </span>
                  <span className={cx("text-lg font-semibold whitespace-nowrap tabular-nums", hot === "danger" ? "text-danger" : "text-ink")}>{t.v}</span>
                  <Icon name="chevron" size={14} className="flex-none text-line-strong" />
                </Link>
              );
            })}
          </Card>
        ))}
      </div>
    </Page>
  );
}
