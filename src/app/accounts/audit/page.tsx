import { accountsAudit } from "@/lib/services/accounts-audit-service";
import { AuditScreen } from "./audit-screen";

export const metadata = { title: "Audit log — Accounts — MahekOne" };

export default async function Page() {
  return <AuditScreen rows={await accountsAudit()} />;
}
