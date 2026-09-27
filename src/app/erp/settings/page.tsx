import { erpContext } from "@/lib/erp/access";
import { hatForHeader } from "@/lib/hat-for-header";
import { ERP_POWERS, ERP_POWER_LABEL } from "@/lib/erp/powers";
import { PageBody, PageHead } from "../_ui/page-head";
import { WorkingLocation } from "./working-location";

/** Settings (spec §2.2): the working location, and what the account can do. */
export default async function ErpSettings() {
  const ctx = await erpContext();
  const hat = await hatForHeader(ctx.user, "erp");
  const card: React.CSSProperties = { background: "#FFFFFF", border: "1px solid #DDE1E8", borderRadius: 8, padding: "18px 20px" };
  return (
    <>
      <PageHead crumb="ERP · Settings" title="Settings" sub="Your working location and profile." />
      <PageBody>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 16, maxWidth: 980 }}>
          <div style={card}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#161616" }}>Working location</div>
            <div style={{ fontSize: 13, color: "#6B7385", margin: "2px 0 12px 0" }}>
              Pre-fills godown on every form and scopes godown lists. Only godowns you are assigned to.
            </div>
            <WorkingLocation
              godowns={ctx.assignedGodowns.map((g) => ({ id: g.id, name: g.name }))}
              working={ctx.workingGodown ? { id: ctx.workingGodown.id, name: ctx.workingGodown.name } : null}
            />
            <div style={{ fontSize: 13, color: "#6B7385", marginTop: 8 }}>
              {ctx.assignedGodowns.length
                ? `Assigned to ${ctx.assignedGodowns.length} godown${ctx.assignedGodowns.length > 1 ? "s" : ""}${ctx.workingGodown ? ` · current: ${ctx.workingGodown.name}` : ""}`
                : "You are not assigned to any godown yet. Ask an ERP administrator to add you on the Godowns screen."}
            </div>
          </div>
          <div style={card}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#161616" }}>{ctx.user.name}</div>
            <div style={{ fontSize: 13, color: "#6B7385", margin: "2px 0 12px 0" }}>{hat.label} · access is set in the MahekOne Admin Console</div>
            {ERP_POWERS.map((p) => (
              <div key={p} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid #F3F4F7", fontSize: 14 }}>
                <span style={{ color: "#3D4453" }}>{ERP_POWER_LABEL[p].label}</span>
                <span style={{ fontWeight: 500, color: "#161616" }}>{ctx.powers.has(p) ? "Yes" : "No"}</span>
              </div>
            ))}
          </div>
        </div>
      </PageBody>
    </>
  );
}
