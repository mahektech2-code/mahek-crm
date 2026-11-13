import Link from "next/link";
import { buttonClass } from "@/components/ui/primitives";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { vaultReady } from "@/lib/locker/crypto";
import { listCredentials } from "@/lib/locker/vault-service";
import { PageHead } from "../_ui/kit";
import { NoVaultKey } from "../_ui/vault-parts";
import { VaultList } from "./vault-list";

export const metadata = { title: "Passwords & keys" };

export default async function VaultPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.credentials");
  const rows = await listCredentials();
  return (
    <>
      <PageHead
        vault
        crumb="Locker · Vault"
        title="Passwords & keys"
        sub="Every login, key and secret, hidden. The auth-method column shows which sign-in account each one really relies on."
        actions={
          <Link href="/locker/vault/new" className={buttonClass({ variant: "primary" })}>
            Add login
          </Link>
        }
      />
      <div className="flex flex-col gap-3 px-6 pb-10">
        {vaultReady() ? null : <NoVaultKey />}
        <VaultList rows={rows} />
      </div>
    </>
  );
}
