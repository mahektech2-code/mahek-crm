import { buttonClass } from "@/components/ui/primitives";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { graphData } from "@/lib/locker/vault-service";
import { PageHead } from "../../_ui/kit";
import { GraphScreen } from "./graph-screen";

export const metadata = { title: "Connections" };

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const user = await requireUser();
  await requireModule(user.id, "locker.graph");
  const [{ id }, g] = await Promise.all([searchParams, graphData()]);
  return (
    <>
      <PageHead
        vault
        crumb="Locker · Vault"
        title="Connection map"
        sub="Which sign-in account each service really relies on. Select a sign-in account to see what breaks; select a service to trace it."
        actions={
          <Link href="/locker/vault/accounts" className={buttonClass({ variant: "secondary" })}>
            Risk list view
          </Link>
        }
      />
      <GraphScreen identities={g.identities} creds={g.creds} links={g.links} initial={id ?? null} />
    </>
  );
}
