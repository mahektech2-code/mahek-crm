import Link from "next/link";
import { erpContext } from "@/lib/erp/access";
import { dashboardSections, latestDigest } from "@/lib/erp/dashboard";
import { TONES } from "@/lib/erp/ui";
import { PageBody, PageHead } from "./_ui/page-head";
import { Icon } from "./_ui/icons";

/**
 * The ERP dashboard. It only ever shows sections for screens the person holds,
 * and money figures only with the power that reveals them.
 */
export default async function ErpDashboard() {
  const ctx = await erpContext();
  const where = ctx.workingGodown?.name ?? null;
  const [sections, digest] = await Promise.all([dashboardSections(ctx, where), latestDigest()]);
  const first = ctx.user.name.split(" ")[0];
  const hour = Number(new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }));
  const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "short", year: "numeric" });
  const moneyOff = !ctx.powers.has("viewPurchaseMoney") && !ctx.powers.has("viewSalesAmounts");

  return (
    <>
      <PageHead crumb={`ERP · ${where ?? "No working location"}`} title="Dashboard" sub="Every figure opens the records behind it." />
      <PageBody>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#161616" }}>
            {hello}, {first}
          </div>
          <div style={{ fontSize: 13, color: "#6B7385" }}>
            {today} · stock and godown figures for {where ?? "all godowns"}
            {moneyOff ? " · money figures are not on your account" : ""}
          </div>
        </div>
        {digest ? (
          <div style={{ padding: "12px 16px", background: "#F7F5FF", border: "1px solid #DDD2FF", borderRadius: 8, fontSize: 14, color: "#161616", marginBottom: 16, lineHeight: "21px" }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: "#5223E0", marginBottom: 4 }}>
              Yesterday · {digest.day}
              {digest.servedBy && digest.servedBy !== "rules" ? " · summarised by AI from the figures below" : ""}
            </span>
            {digest.text}
          </div>
        ) : null}
        {sections.length <= 2 ? (
          <div style={{ padding: "12px 16px", background: "#FFFFFF", border: "1px solid #EDEFF3", borderRadius: 8, fontSize: 14, color: "#3D4453", marginBottom: 16 }}>
            {sections.length === 0
              ? "Nothing on your account has figures to show yet. Sections appear here as the screens you hold start recording work."
              : "You see the sections your role covers. Other parts of the ERP are not on your account."}
          </div>
        ) : null}
        <div style={{ columns: "360px", columnGap: 16 }}>
          {sections.map((s) => (
            <div key={s.t} style={{ breakInside: "avoid", display: "inline-block", width: "100%", margin: "0 0 16px 0", background: "#FFFFFF", border: "1px solid #DDE1E8", borderRadius: 8, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", fontSize: 15, fontWeight: 600, color: "#161616" }}>{s.t}</div>
              {s.tiles.map((t) => {
                const hot = t.tone && Number(String(t.v).replace(/[^\d]/g, "")) > 0 ? t.tone : undefined;
                return (
                  <Link key={t.l} href={t.href} className="erp-row" style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "11px 16px", borderTop: "1px solid #F3F4F7", textAlign: "left", textDecoration: "none" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: hot ? TONES[hot][1] : "#DDE1E8" }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 14, color: "#161616" }}>{t.l}</span>
                      {t.sub ? <span style={{ display: "block", fontSize: 12, color: "#6B7385", marginTop: 1 }}>{t.sub}</span> : null}
                    </span>
                    <span style={{ fontSize: 18, fontWeight: 600, color: hot === "danger" ? "#B3261E" : "#161616", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{t.v}</span>
                    <span style={{ display: "flex", color: "#C2C8D2" }}>
                      <Icon n="chev" s={14} />
                    </span>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </PageBody>
    </>
  );
}
