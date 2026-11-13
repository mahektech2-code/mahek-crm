import { isNull } from "drizzle-orm";
import { db } from "@/db";
import { lockerSecrets } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerAccess } from "@/lib/locker/access";
import { breakglassView } from "@/lib/locker/vault-service";
import { PageHead } from "../_ui/kit";
import { EmergencyScreen } from "./emergency-screen";

export const metadata = { title: "Emergency access" };

export default async function EmergencyPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.approvals");
  const [v, access, fields] = await Promise.all([breakglassView(), lockerAccess(user.id), db.select({ c: lockerSecrets.credentialId, f: lockerSecrets.field }).from(lockerSecrets).where(isNull(lockerSecrets.retiredAt))]);
  const F: Record<string, string[]> = {};
  for (const r of fields) (F[r.c] ??= []).push(r.f);
  return (
    <>
      <PageHead vault crumb="Locker · Vault" title="Emergency access" sub="Emergency access when the normal path is unavailable. Time-boxed, scoped, approved by a second person, and visible to everyone." />
      <EmergencyScreen
        me={user.id}
        canInvoke={access.vault && access.has("locker.approvals")}
        minutes={v.settings.breakglassMinutes}
        reviewHours={v.settings.breakglassReviewHours}
        candidates={v.candidates.map((c) => ({ ...c, fields: F[c.id] ?? [] }))}
        sessions={v.sessions.map((s) => ({ ...s, scope: s.scope.map((x) => ({ ...x, fields: F[x.id] ?? [] })) }))}
      />
    </>
  );
}
