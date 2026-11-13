import { isNull } from "drizzle-orm";
import { db } from "@/db";
import { lockerSecrets } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { listCredentials } from "@/lib/locker/vault-service";
import { lockerSettingsRow } from "@/lib/locker/service";
import { PageHead } from "../../_ui/kit";
import { ChangeDueScreen } from "./change-due-screen";

export const metadata = { title: "Change due" };

export default async function ChangeDuePage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.rotation");
  const [rows, s, fields] = await Promise.all([listCredentials(), lockerSettingsRow(), db.select({ c: lockerSecrets.credentialId, f: lockerSecrets.field }).from(lockerSecrets).where(isNull(lockerSecrets.retiredAt))]);
  const F = new Map<string, string[]>();
  for (const r of fields) F.set(r.c, [...(F.get(r.c) ?? []), r.f]);
  const ord = { restricted: 0, sensitive: 1, standard: 2 } as const;
  const due = rows.filter((r) => r.changeDue).sort((a, b) => ord[a.tier] - ord[b.tier] || b.overBy - a.overBy);
  return (
    <>
      <PageHead vault crumb="Locker · ◈ Vault" title="Passwords to change" sub="Passwords & keys past their change date." />
      <ChangeDueScreen due={due.map((d) => ({ ...d, fields: F.get(d.id) ?? [] }))} policy={{ restricted: s.tiers.restricted.rotateDays, sensitive: s.tiers.sensitive.rotateDays, standard: s.tiers.standard.rotateDays }} />
    </>
  );
}
