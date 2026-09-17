import {
  ACCOUNTS_AUDIT_LIMIT,
  accountsAudit,
  accountsAuditCount,
} from "@/lib/services/accounts-audit-service";
import { AuditScreen } from "./audit-screen";

export const metadata = { title: "Audit log — Accounts — MahekOne" };

/**
 * The log, and — separately — how much of it there is.
 *
 * The read is capped and the count is not, because they answer two questions:
 * one is what this page can draw, the other is what it is a slice of. Passing
 * `rows.length` as the total is how a pager comes to say "of 500" over an audit
 * log of fifty thousand decisions, which is a screen asserting a false fact on
 * the one screen whose whole value is being complete.
 */
export default async function Page() {
  const [rows, total] = await Promise.all([accountsAudit(), accountsAuditCount()]);

  return <AuditScreen rows={rows} total={total} limit={ACCOUNTS_AUDIT_LIMIT} />;
}
