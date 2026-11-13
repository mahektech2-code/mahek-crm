import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerAccess } from "@/lib/locker/access";
import { daysLabel } from "@/lib/locker/engine";
import { CRIT } from "@/lib/locker/engine";
import { identityRisks, toLite } from "@/lib/locker/register-service";
import { registerFor, today } from "@/lib/locker/service";
import { Badge, buttonClass } from "@/components/ui/primitives";
import { C, nf } from "@/lib/locker/style";
import { PageHead } from "../_ui/kit";
import { GenTable, Stat, StatGrid } from "../_ui/register-parts";

export const metadata = { title: "Risk" };
export const dynamic = "force-dynamic";

export default async function RiskPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.risk");
  const day = today();
  const [access, rows] = await Promise.all([lockerAccess(user.id), registerFor(user.id, day)]);
  const ids = access.vault ? await identityRisks() : [];
  const live = rows.filter((a) => a.live).map(toLite);
  const un = live.filter((a) => !a.ownerId);
  const nob = live.filter((a) => a.crit >= 3 && !a.backupId);
  const unv = live.filter((a) => a.crit === 4 && a.unchecked);
  const weak = ids.slice().sort((a, b) => b.score - a.score).slice(0, 15);
  const graph = access.has("locker.graph");
  return (
    <>
      <PageHead crumb="Locker · Overview" title="Risk" sub="Hidden risks — things that could fail without anyone noticing, worst first." />
      <div className="flex flex-col gap-5 px-6 pb-12">
        <StatGrid n={4}>
          <Stat l="Unowned" v={nf(un.length)} s="assets" red={un.length > 0} />
          <Stat l="No backup owner" v={nf(nob.length)} s="critical and high" />
          <Stat l="Personal sign-in accounts" v={access.vault ? nf(ids.filter((i) => !i.controlled).length) : "—"} s="rooting company services" red={access.vault && ids.some((i) => !i.controlled)} />
          <Stat l="Not checked critical" v={nf(unv.length)} s="past the 90-day check" red={unv.length > 0} />
        </StatGrid>
        {access.vault ? (
          <GenTable
            vault
            wide
            title="Weak spots"
            sub="Sign-in accounts ranked by Risk score: linked services × importance × no-2-step sign-in (×3) × personal (×5) × no recovery (×2)."
            cols={[
              ["Sign-in account", "minmax(240px,2fr)"],
              ["Controlled by", "160px"],
              ["Linked services", "100px"],
              ["2-step sign-in", "80px"],
              ["Risk", "80px"],
              ["Recommended action", "minmax(220px,1.6fr)"],
            ]}
            rows={weak.map((i) => ({
              edge: !i.controlled ? C.red : !i.mfa ? C.amber : null,
              href: graph ? `/locker/vault/connections?id=${i.id}` : undefined,
              cells: [
                { t: i.email, sub: i.provider },
                { t: i.controlled ? "Company" : (i.controlledByName ?? "A person"), cls: i.controlled ? undefined : "font-semibold text-danger" },
                { t: nf(i.linked) },
                { node: i.mfa ? <Badge tone="success">On</Badge> : <Badge tone="danger">Off</Badge> },
                { t: nf(i.score), cls: "font-semibold text-ink" },
                { t: !i.controlled ? "Move every linked to a company sign-in account" : !i.mfa ? "Turn on 2-step sign-in with a hardware key" : !i.recovery ? "Configure recovery to a company inbox" : "Add a second admin path", cls: "text-[13px]" },
              ],
            }))}
            emptyLine="No sign-in accounts are recorded in the vault yet."
          />
        ) : null}
        <GenTable
          title="Unowned assets"
          sub="A problem until someone accepts responsibility."
          cols={[
            ["Asset", "minmax(260px,2fr)"],
            ["Type", "180px"],
            ["Days", "120px"],
            ["", "100px"],
          ]}
          rows={un.map((a) => ({ edge: C.red, href: `/locker/assets/${a.id}?tab=ownership`, cells: [{ t: a.title, sub: a.code }, { t: a.typeName }, { t: daysLabel(a.d) }, { node: <span className={buttonClass({ variant: "danger", size: "sm" })}>Assign</span>, cls: "text-right" }] }))}
          emptyLine="Every asset has an owner."
        />
        <GenTable
          title="High-importance assets without a backup owner"
          sub="If the owner is away, nobody receives the reminder."
          cols={[
            ["Asset", "minmax(260px,2fr)"],
            ["Owner", "160px"],
            ["Days", "120px"],
          ]}
          rows={nob.map((a) => ({ edge: CRIT[a.crit].edge, href: `/locker/assets/${a.id}?tab=ownership`, cells: [{ t: a.title, sub: a.code }, { t: a.ownerName ?? "Unassigned" }, { t: daysLabel(a.d) }] }))}
          emptyLine="Every high and business-critical asset has a backup owner."
        />
        <GenTable
          title="Business-critical assets not checked this quarter"
          sub="An end date nobody has checked against the document is a guess."
          cols={[
            ["Asset", "minmax(260px,2fr)"],
            ["Last checked", "140px"],
            ["Owner", "160px"],
          ]}
          rows={unv.map((a) => ({ edge: C.red, href: `/locker/assets/${a.id}`, cells: [{ t: a.title, sub: a.code }, { t: a.checkedAgo == null ? "Never" : `${nf(a.checkedAgo)} days ago`, cls: "font-medium text-warn-ink" }, { t: a.ownerName ?? "Unassigned" }] }))}
          emptyLine="All checked."
        />
      </div>
    </>
  );
}
