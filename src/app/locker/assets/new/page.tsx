import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { redirect } from "next/navigation";
import { lockerAccess } from "@/lib/locker/access";
import { canEditRegister } from "@/lib/locker/register-service";
import { lockerEntitiesList, lockerPaymentMethodsList, lockerPeople, lockerSitesList, lockerTypes, today } from "@/lib/locker/service";
import type { TimeModel } from "@/lib/locker/catalogue";
import { NewAsset } from "./new-asset";

export const metadata = { title: "Add asset" };
export const dynamic = "force-dynamic";

export default async function NewAssetPage({ searchParams }: { searchParams: Promise<{ cat?: string }> }) {
  const user = await requireUser();
  const access = await lockerAccess(user.id);
  if (!access.categories.length) await requireModule(user.id, "locker.assets");
  if (!canEditRegister(access)) redirect("/locker/assets");
  const [{ cat }, types, people, entities, sites, pms] = await Promise.all([searchParams, lockerTypes(), lockerPeople(), lockerEntitiesList(), lockerSitesList(), lockerPaymentMethodsList()]);
  return (
    <NewAsset
      types={types
        .filter((t) => t.active && access.catOk(t.category))
        .map((t) => ({ code: t.code, name: t.name, category: t.category, model: t.model as TimeModel, validityMonths: t.validityMonths, leadDays: t.leadDays, graceDays: t.graceDays, criticality: t.criticality, authority: t.authority, fields: t.fields }))}
      cats={access.categories}
      initialCat={cat && access.catOk(cat) ? cat : null}
      people={people.map((p) => ({ id: p.id, name: p.name, title: p.title }))}
      entities={entities.filter((e) => e.active).map((e) => ({ id: e.id, name: e.name }))}
      sites={sites.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name }))}
      pms={pms.filter((p) => p.active).map((p) => ({ id: p.id, label: p.label, last4: p.last4, expiresOn: p.expiresOn }))}
      today={today()}
    />
  );
}
