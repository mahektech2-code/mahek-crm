import { buttonClass } from "@/components/ui/primitives";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerAccess } from "@/lib/locker/access";
import { auditRows } from "@/lib/locker/vault-service";
import { PageHead } from "../_ui/kit";
import { AuditScreen } from "./audit-screen";

export const metadata = { title: "Audit" };

export default async function AuditPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.audit");
  const [rows, access] = await Promise.all([auditRows(), lockerAccess(user.id)]);
  /* Somebody without the vault (an external auditor) reads that a reveal happened, never why — the reason can describe the system it opens. */
  const shown = access.vault ? rows : rows.map((r) => (r.action.startsWith("locker.secret") ? { ...r, reason: r.reason ? "Recorded · visible to vault holders" : null } : r));
  return (
    <>
      <PageHead
        crumb="Locker · Operations"
        title="Audit log"
        sub="Nothing here can be changed or deleted, by anyone. Each entry carries the fingerprint of the one before it, so a removed or altered entry is found. No entry holds a password."
        actions={
          <a href="/api/locker/audit/export" className={buttonClass({ variant: "secondary" })}>
            Export
          </a>
        }
      />
      <AuditScreen rows={shown} />
    </>
  );
}
