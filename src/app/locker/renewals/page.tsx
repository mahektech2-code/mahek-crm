import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { CRIT, daysLabel } from "@/lib/locker/engine";
import type { AssetLite } from "@/lib/locker/lite";
import { toLite } from "@/lib/locker/register-service";
import { registerFor, today } from "@/lib/locker/service";
import { buttonClass, cx } from "@/components/ui/primitives";
import { fd, nf } from "@/lib/locker/style";
import { PageHead, StatusPill } from "../_ui/kit";
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
      { t: daysLabel(a.actionIn), sub: fd(a.actionDate), cls: cx("font-semibold", (a.d ?? 0) < 0 ? "text-danger" : "text-ink") },
      { node: <StatusPill status={a.status} /> },
      { t: a.ownerName ?? "Unassigned", cls: a.ownerName ? undefined : "font-semibold text-danger" },
      { node: <span className={buttonClass({ variant: "primary", size: "sm" })}>{OPEN.includes(a.status) ? "Open case" : "Start renewal"}</span>, cls: "text-right" },
    ],
  });
  const tabCls = (on: boolean) => cx("-mb-px flex items-center border-b-2 py-2 text-sm whitespace-nowrap no-underline hover:no-underline", on ? "border-brand font-semibold text-ink" : "border-transparent font-medium text-muted hover:text-body");
  return (
    <>
      <PageHead crumb="Locker · My work" title="Renewals" sub="Renewal tasks in flight, and what needs one started." />
      <div className="flex flex-col gap-5 px-6 pb-12">
        <div className="flex flex-wrap gap-x-5 border-b border-line">
          <Link href="/locker/renewals" className={tabCls(tab !== "all")}>
            Assigned to me · {nf(all.filter((a) => mineOf(a) && DUE.includes(a.status)).length)}
          </Link>
          <Link href="/locker/renewals?tab=all" className={tabCls(tab === "all")}>
            Everyone · {nf(all.filter((a) => DUE.includes(a.status)).length)}
          </Link>
        </div>
        <GenTable title="Needs a renewal started" sub="Inside the time needed or past end date, with no case open." cols={cols} rows={due.map(row)} emptyLine="Nothing needs a renewal started." />
        <GenTable title="Open renewal tasks" sub={`${nf(open.length)} in flight`} cols={cols} rows={open.map(row)} emptyLine="No renewal is under way." />
      </div>
    </>
  );
}
