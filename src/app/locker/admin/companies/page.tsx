import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { allAssets, lockerEntitiesList, lockerSitesList } from "@/lib/locker/service";
import { PageHead } from "../../_ui/kit";
import { CompaniesScreen } from "./companies-screen";

export const metadata = { title: "Companies" };

export default async function CompaniesPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.entities");
  const [ents, sites, assets] = await Promise.all([lockerEntitiesList(), lockerSitesList(), allAssets()]);
  const byEnt = new Map<string, number>();
  const bySite = new Map<string, number>();
  for (const a of assets.filter((a) => a.live)) {
    if (a.entityId) byEnt.set(a.entityId, (byEnt.get(a.entityId) ?? 0) + 1);
    if (a.siteId) bySite.set(a.siteId, (bySite.get(a.siteId) ?? 0) + 1);
  }
  return (
    <>
      <PageHead crumb="Locker · Admin" title="Companies & sites" sub="Companies and sites. The hazardous-storage flag drives which licences each location must hold." />
      <CompaniesScreen
        ents={ents.map((e) => ({ id: e.id, name: e.name, gstin: e.gstin, isPrimary: e.isPrimary, active: e.active, n: byEnt.get(e.id) ?? 0 }))}
        sites={sites.map((s) => ({ id: s.id, name: s.name, kind: s.kind, state: s.state, hazardous: s.hazardous, entityId: s.entityId, active: s.active, n: bySite.get(s.id) ?? 0 }))}
      />
    </>
  );
}
