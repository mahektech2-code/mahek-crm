import { erpContext } from "@/lib/erp/access";
import { hatForHeader } from "@/lib/hat-for-header";
import { ERP_POWERS, ERP_POWER_LABEL } from "@/lib/erp/powers";
import { SEAT_LABEL } from "@/lib/erp/departments";
import { Badge, Card, CardHeader } from "@/components/ui/primitives";
import { Page } from "../_ui/page-head";
import { WorkingLocation } from "./working-location";

/** Settings (spec §2.2): the working location, and what the account can do. */
export default async function ErpSettings() {
  const ctx = await erpContext();
  const hat = await hatForHeader(ctx.user, "erp");
  return (
    <Page title="Settings" sub="Your working location and profile.">
      <div className="grid max-w-[980px] grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-start gap-4">
        <Card>
          <CardHeader title="Working location" hint="Pre-fills godown on every form and scopes godown lists. Only godowns you are assigned to." />
          <div className="px-5 py-4">
            <WorkingLocation
              godowns={ctx.assignedGodowns.map((g) => ({ id: g.id, name: g.name }))}
              working={ctx.workingGodown ? { id: ctx.workingGodown.id, name: ctx.workingGodown.name } : null}
            />
            <div className="mt-2 text-[13px] text-muted">
              {ctx.assignedGodowns.length
                ? `Assigned to ${ctx.assignedGodowns.length} godown${ctx.assignedGodowns.length > 1 ? "s" : ""}${ctx.workingGodown ? ` · current: ${ctx.workingGodown.name}` : ""}`
                : "You are not assigned to any godown yet. Ask an ERP administrator to add you on the Godowns screen."}
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader
            title={ctx.viewingAs?.kind === "designation" ? ctx.viewingAs.label : ctx.user.name}
            hint={`${ctx.designation ?? hat.label}${ctx.department ? ` · ${SEAT_LABEL[ctx.department]} department` : ""} · access is set in the MahekOne Admin Console`}
          />
          <div className="px-5 py-1">
            {ERP_POWERS.map((p) => (
              <div key={p} className="flex items-center justify-between gap-3 border-b border-divider py-2.5 text-sm last:border-0">
                <span className="text-body">{ERP_POWER_LABEL[p].label}</span>
                {ctx.powers.has(p) ? <Badge tone="success">Yes</Badge> : <Badge tone="muted">No</Badge>}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </Page>
  );
}
