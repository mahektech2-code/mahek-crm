import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { CRIT, daysLabel } from "@/lib/locker/engine";
import type { AssetLite } from "@/lib/locker/lite";
import { toLite } from "@/lib/locker/register-service";
import { registerFor, today } from "@/lib/locker/service";
import { C, fd, nf } from "@/lib/locker/style";
import { PageHead, Pill, StatusPill } from "../_ui/kit";
import { GenTable } from "../_ui/register-parts";

export const metadata = { title: "Renewals" };
export const dynamic = "force-dynamic";

const DUE = ["renewal_due", "expiring", "in_grace", "expired"];
const OPEN = ["renewal_in_progress", "renewal_filed", "awaiting_document"];

export default async function RenewalsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  await requireModule(user.id, "locker.renewals");
  const { tab } = await searchParams;
  const all = (await registerFor(user.id, today())).filter((a) => a.live && a.endDate).map(toLite);
  const mineOf = (a: AssetLite) => a.ownerId === user.id || a.backupId === user.id;
  const scope = tab === "all" ? all : all.filter(mineOf);
  const due = scope.filter((a) => DUE.includes(a.status)).sort((a, b) => b.crit - a.crit || (a.actionIn ?? 0) - (b.actionIn ?? 0));
  const open = all.filter((a) => OPEN.includes(a.status)).sort((a, b) => (a.d ?? 0) - (b.d ?? 0));
  const cols: [string, string][] = [
    ["Asset", "minmax(280px,2fr)"],
    ["Days", "140px"],
    ["Status", "170px"],
    ["Owner", "150px"],
    ["", "130px"],
  ];
  const row = (a: AssetLite) => ({
    edge: CRIT[a.crit].edge,
    href: `/locker/assets/${a.id}/renewal`,
    cells: [
      { t: a.title, sub: `${a.code} · ${a.typeName}` },
      { t: daysLabel(a.actionIn), sub: fd(a.actionDate), style: { fontWeight: 600, color: (a.d ?? 0) < 0 ? C.red : C.ink } },
      { node: <StatusPill status={a.status} /> },
      { t: a.ownerName ?? "Unassigned", style: a.ownerName ? {} : { color: C.red, fontWeight: 600 } },
      { node: <Pill label={OPEN.includes(a.status) ? "Open case" : "Start renewal"} bg={C.brand} fg="#FFFFFF" style={{ height: 28, padding: "0 10px", borderRadius: 4, fontSize: 12 }} />, style: { textAlign: "right" as const } },
    ],
  });
  const tabSt = (on: boolean) => ({ height: 40, display: "inline-flex", alignItems: "center", fontSize: 14, fontWeight: on ? 600 : 400, color: on ? C.ink : C.muted, boxShadow: on ? `inset 0 -2px 0 ${C.brand}` : "none", textDecoration: "none" });
  return (
    <>
      <PageHead crumb="Locker · My work" title="Renewals" sub="Renewal tasks in flight, and what needs one started." />
      <div style={{ padding: "0 24px 48px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", gap: 24, borderBottom: `1px solid ${C.line}` }}>
          <Link href="/locker/renewals" style={tabSt(tab !== "all")}>
            Assigned to me · {nf(all.filter((a) => mineOf(a) && DUE.includes(a.status)).length)}
          </Link>
          <Link href="/locker/renewals?tab=all" style={tabSt(tab === "all")}>
            Everyone · {nf(all.filter((a) => DUE.includes(a.status)).length)}
          </Link>
        </div>
        <GenTable title="Needs a renewal started" sub="Inside the time needed or past end date, with no case open." cols={cols} rows={due.map(row)} emptyLine="Nothing needs a renewal started." />
        <GenTable title="Open renewal tasks" sub={`${nf(open.length)} in flight`} cols={cols} rows={open.map(row)} emptyLine="No renewal is under way." />
      </div>
    </>
  );
}
