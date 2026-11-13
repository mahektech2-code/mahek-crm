import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { lockerAccess } from "@/lib/locker/access";
import { writeLockerAudit } from "@/lib/locker/audit";
import { auditRows } from "@/lib/locker/vault-service";

/** The Locker's audit as CSV. The export is itself an audited event. No row holds a secret. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Sign in first.", { status: 401 });
  const a = await lockerAccess(user.id);
  if (!a.has("locker.audit")) return new NextResponse("You do not have Audit in the Locker.", { status: 403 });
  const rows = await auditRows(100_000);
  await writeLockerAudit({ actorId: user.id, actorName: user.name, action: "locker.assets.exported", entityType: "audit", summary: `Exported the audit log · ${rows.length} entries`, security: true });
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const redact = !a.vault;
  const lines = [
    ["seq", "when", "actor", "event", "item", "what", "reason", "security", "ip"].join(","),
    ...rows.map((r) => [r.seq, r.at, r.actor, r.action, r.entity, r.summary, redact && r.action.startsWith("locker.secret") ? "" : r.reason, r.security ? "yes" : "", r.ip].map(esc).join(",")),
  ];
  return new NextResponse(lines.join("\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="locker-audit.csv"`, "cache-control": "no-store" },
  });
}
