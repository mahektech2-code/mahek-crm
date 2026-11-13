import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerPeople } from "@/lib/locker/service";
import { identitiesView } from "@/lib/locker/vault-service";
import { PageHead } from "../../_ui/kit";
import { IdentitiesScreen } from "./identities-screen";

export const metadata = { title: "Sign-in accounts" };

export default async function AccountsPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.identities");
  const [rows, people] = await Promise.all([identitiesView(), lockerPeople()]);
  return (
    <>
      <PageHead
        vault
        crumb="Locker · ◈ Vault"
        title="Sign-in accounts"
        sub="Every Google, Microsoft, GitHub and Apple account the company relies on. A personal account rooting company services stays red until it is resolved."
      />
      <IdentitiesScreen
        rows={rows.map((r) => ({ ...r.identity, score: r.score, direct: r.direct, ownerName: r.ownerName, ownerId: r.ownerId }))}
        people={people.map((p) => ({ v: p.id, l: p.name }))}
      />
    </>
  );
}
