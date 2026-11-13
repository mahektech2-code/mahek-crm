import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { vaultReady } from "@/lib/locker/crypto";
import { PageHead } from "../../_ui/kit";
import { NoVaultKey } from "../../_ui/vault-parts";
import { CredentialForm } from "../credential-form";
import { formOptions } from "../form-options";

export const metadata = { title: "Add login" };

export default async function AddLoginPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.credentials");
  const opts = await formOptions();
  return (
    <>
      <PageHead vault crumb="Locker · Vault" title="Add login" sub="Secrets are encrypted with a key of their own, never logged, and never sent to an AI model." />
      <div className="flex max-w-[1080px] flex-col gap-4 px-6 pb-12">
        {vaultReady() ? <CredentialForm {...opts} /> : <NoVaultKey />}
      </div>
    </>
  );
}
