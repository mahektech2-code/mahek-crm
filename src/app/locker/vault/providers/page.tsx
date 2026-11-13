import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { daysLabel } from "@/lib/locker/engine";
import { providersView } from "@/lib/locker/vault-service";
import { PageHead } from "../../_ui/kit";
import { ProvidersScreen } from "./providers-screen";

export const metadata = { title: "Providers" };

export default async function ProvidersPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.providers");
  const list = await providersView();
  return (
    <>
      <PageHead vault crumb="Locker · Vault" title="Providers" sub="One screen for “how many DigitalOcean accounts do we have”: every account, login, subscription and its cost." />
      <ProvidersScreen
        list={list.map((p) => ({
          name: p.name,
          accounts: p.accounts,
          spendPaise: p.spendPaise,
          mfaPct: p.mfaPct,
          owners: p.owners,
          creds: p.creds.map((c) => ({ id: c.id, title: c.title, account: c.via ? `via ${c.via.email}` : c.username, tier: c.tier, env: c.env, owner: c.ownerName ?? "—" })),
          assets: p.assets.map((a) => ({ id: a.id, title: a.title, code: a.code, renews: daysLabel(a.d), date: a.endDate, amountPaise: a.amountPaise, cycle: a.billingCycle, owner: a.ownerName ?? "Unassigned" })),
        }))}
      />
    </>
  );
}
