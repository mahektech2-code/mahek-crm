import { notFound } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { lockerCredentials, lockerSecrets } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import type { Tier } from "@/lib/locker/engine";
import { PageHead } from "../../../_ui/kit";
import { CredentialForm } from "../../credential-form";
import { formOptions } from "../../form-options";

export const metadata = { title: "Edit login" };

export default async function EditLoginPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  await requireModule(user.id, "locker.credentials");
  const [c] = await db.select().from(lockerCredentials).where(eq(lockerCredentials.id, id)).limit(1);
  if (!c) notFound();
  const fields = await db.select({ field: lockerSecrets.field }).from(lockerSecrets).where(and(eq(lockerSecrets.credentialId, id), isNull(lockerSecrets.retiredAt)));
  const opts = await formOptions();
  return (
    <>
      <PageHead vault crumb="Locker · ◈ Vault" title={`Edit · ${c.title}`} sub="Only the fields around the secret. To change the secret itself, use Change on the login — the old value is kept, encrypted." />
      <div style={{ padding: "0 24px 48px 24px", maxWidth: 1080 }}>
        <CredentialForm
          id={id}
          {...opts}
          initial={{
            title: c.title,
            kind: c.kind,
            tier: c.tier as Tier,
            provider: c.provider,
            url: c.url,
            username: c.username,
            env: c.env,
            auth: c.auth,
            viaIdentityId: c.viaIdentityId,
            sole: c.sole,
            identityId: c.identityId,
            assetId: c.assetId,
            ownerId: c.ownerId,
            backupOwnerId: c.backupOwnerId,
            mfa: c.mfa,
            mfaMethod: c.mfaMethod,
            recoveryEmail: c.recoveryEmail,
            accessLevel: c.accessLevel,
            rotateEveryDays: c.rotateEveryDays,
            revealers: c.revealers,
            notes: c.notes ?? "",
            fields: fields.map((f) => f.field),
          }}
        />
      </div>
    </>
  );
}
