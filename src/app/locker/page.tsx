import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { addDays } from "@/lib/format";
import { lockerAccess } from "@/lib/locker/access";
import { CRIT, daysLabel } from "@/lib/locker/engine";
import { cardRisks, identityRisks, toLite } from "@/lib/locker/register-service";
import { registerFor, today } from "@/lib/locker/service";
import { Card, Progress, cx } from "@/components/ui/primitives";
import { fd, fds, nf } from "@/lib/locker/style";
import { PageHead, Tag } from "./_ui/kit";
import { AttentionRow, Stat } from "./_ui/register-parts";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";


export default async function LockerDashboard() {
  const user = await requireUser();
  await requireModule(user.id, "locker.dashboard");
  const day = today();
  const [access, rows] = await Promise.all([lockerAccess(user.id), registerFor(user.id, day)]);
  const [ids, cards] = await Promise.all([access.vault ? identityRisks() : Promise.resolve([]), cardRisks(rows, day)]);
  const live = rows.filter((a) => a.live);
  const L = live.map(toLite);
  const in30 = L.filter((a) => a.d != null && a.d >= 0 && a.d <= 30);
  const over = L.filter((a) => a.d != null && a.d < 0);
  const unowned = L.filter((a) => !a.ownerId);
  const personal = ids.filter((i) => !i.controlled);
  const noMfa = ids.filter((i) => !i.mfa);
  const reg = access.has("locker.assets") || access.categories.length > 0;
  const view = (v: string) => (reg ? `/locker/assets?view=${v}` : undefined);

  const strip = [
    { l: "Expiring in 30 days", v: in30.length, s: `${in30.filter((a) => a.crit === 4).length} business critical`, href: view("d30"), red: false },
    { l: "Overdue", v: over.length, s: `${over.filter((a) => a.crit === 4).length} critical · ${over.filter((a) => a.status === "in_grace").length} in grace · ${over.filter((a) => a.status === "renewal_filed").length} applied`, href: view("over"), red: true },
    { l: "Unowned", v: unowned.length, s: unowned.length ? "needs an owner — a problem" : "every asset has an owner", href: view("unowned"), red: unowned.length > 0 },
    { l: "At risk", v: personal.length, s: "sign-in accounts on personal accounts", href: access.has("locker.identities") ? "/locker/vault/accounts" : access.has("locker.risk") ? "/locker/risk" : undefined, red: personal.length > 0 },
  ];
  const filled = rows.filter((a) => a.live && a.complete).length;
  const cp = live.length ? Math.round((filled / live.length) * 100) : 0;
  const crit = L.filter((a) => a.crit === 4 && a.d != null && a.d <= a.leadDays + 30).sort((a, b) => (a.actionIn ?? 0) - (b.actionIn ?? 0));
  const ov = over.slice().sort((a, b) => b.crit - a.crit || (a.d ?? 0) - (b.d ?? 0));
  const mine = L.filter((a) => (a.ownerId === user.id || a.backupId === user.id) && a.d != null && a.d <= 90).sort((a, b) => (a.d ?? 0) - (b.d ?? 0));
  const up = L.filter((a) => a.d != null && a.d >= 0 && a.d <= 90);
  const lane: Record<number, number> = {};
  const dots = up.map((a) => {
    const x = ((a.d ?? 0) / 90) * 100;
    const b = Math.floor((a.d ?? 0) / 3);
    lane[b] = (lane[b] || 0) + 1;
    const y = Math.min(6, lane[b] - 1);
    const sz = ({ 4: 14, 3: 11, 2: 9, 1: 8 } as Record<number, number>)[a.crit];
    return { a, x, y, sz };
  });

  const risks = [
    {
      l: "Unowned assets",
      n: unowned.length,
      sub: "An asset without a responsible person is a problem, not a blank.",
      items: unowned.slice(0, 4).map((a) => ({ t: a.title, m: `${a.typeName} · ${daysLabel(a.d)}`, href: `/locker/assets/${a.id}?tab=ownership`, tag: <Tag label="No owner" tone="red" /> })),
      red: unowned.length > 0,
      empty: "Every asset has an owner.",
    },
    {
      l: "Personal sign-in accounts",
      n: personal.length,
      sub: access.vault ? "Company services that sign in through someone’s personal account." : "Visible to vault roles.",
      items: personal.slice(0, 4).map((i) => ({ t: i.email, m: `Controlled by ${i.controlledByName || "—"} · ${i.linked} linked services`, href: access.has("locker.identities") ? (access.has("locker.graph") ? `/locker/vault/connections?id=${i.id}` : "/locker/vault/accounts") : undefined, tag: <Tag label="Not company controlled" tone="red" /> })),
      red: personal.length > 0,
      empty: access.vault ? "Every sign-in account is company controlled." : "Ask the IT Lead for this view.",
    },
    {
      l: "Sign-in accounts without 2-step sign-in",
      n: noMfa.length,
      sub: "A password alone protects everything downstream of these.",
      items: noMfa.slice(0, 4).map((i) => ({ t: i.email, m: `${i.provider} · ${i.linked} linked services`, href: access.has("locker.identities") ? (access.has("locker.graph") ? `/locker/vault/connections?id=${i.id}` : "/locker/vault/accounts") : undefined, tag: <Tag label="2-step sign-in off" tone="amber" /> })),
      red: false,
      empty: access.vault ? "2-step sign-in is on everywhere." : "Visible to vault roles.",
    },
    {
      l: "Cards expiring with auto-renewals on them",
      n: cards.reduce((x, y) => x + y.subs.length, 0),
      sub: "The charge fails, the service runs out, and nobody connected the two.",
      items: cards.map((x) => ({
        t: `${x.pm.label} ····${x.pm.last4}`,
        m: `Expires ${fd(x.pm.expiresOn)} · ${x.subs.length} subscriptions: ${x.subs.slice(0, 3).map((a) => a.title).join(", ")}${x.subs.length > 3 ? "…" : ""}`,
        href: access.has("locker.costs") ? "/locker/costs" : undefined,
        tag: <Tag label={`In ${x.daysLeft} days`} tone="amber" />,
      })),
      red: cards.length > 0,
      empty: "No payment method expires in the next 60 days.",
    },
  ];

  const h2 = "text-lg leading-6 font-semibold text-ink";
  const empty = "p-5 text-sm text-muted";
  return (
    <>
      <PageHead crumb="Locker · Overview" title="Dashboard" sub="What needs attention, most serious first." />
      <div className="flex flex-col gap-8 px-6 pb-10">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))_260px]">
          {strip.map((k) => (
            <Stat key={k.l} l={k.l} v={nf(k.v)} s={k.s} href={k.href} red={k.red && k.v > 0} />
          ))}
          <Card className="p-5">
            <div className="text-xs font-medium tracking-label text-muted uppercase">How complete the register is</div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-[32px] leading-9 font-semibold text-ink">{cp}%</span>
              <span className="text-[13px] text-muted">filled in and checked</span>
            </div>
            <Progress value={cp} className="mt-3" />
            <div className="mt-1.5 text-xs text-muted">
              {nf(live.length - filled)} of {nf(live.length)} assets missing an owner, backup or check
            </div>
          </Card>
        </div>

        <section>
          <div className="mb-3 flex items-baseline gap-2.5">
            <span className={h2}>Critical items needing attention</span>
            <span className="text-[13px] text-muted">{nf(crit.length)} inside their time needed to renew · with what happens if each runs out</span>
          </div>
          <Card className="overflow-hidden">
            {crit.slice(0, 8).map((a) => (
              <AttentionRow key={a.id} a={a} conseq />
            ))}
            {!crit.length ? <div className={empty}>No business-critical asset is inside its renewal window.</div> : null}
          </Card>
        </section>

        <section>
          <div className="mb-3 flex items-baseline gap-2.5">
            <span className={h2}>Overdue</span>
            <span className="text-[13px] text-muted">{nf(ov.length)} past end date · grace, applied and expired shown separately</span>
          </div>
          <Card className="overflow-hidden">
            {ov.slice(0, 6).map((a) => (
              <AttentionRow key={a.id} a={a} />
            ))}
            {!ov.length ? <div className={empty}>Nothing is past its end date.</div> : null}
            {ov.length > 6 && reg ? (
              <Link href="/locker/assets?view=over" className="flex h-[38px] w-full items-center justify-center border-t border-divider bg-page text-[13px] font-medium text-brand-hover no-underline hover:underline">
                All {nf(ov.length)} overdue in the register
              </Link>
            ) : null}
          </Card>
        </section>

        <section>
          <div className={cx(h2, "mb-3")}>Hidden risks</div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {risks.map((g) => (
              <Card key={g.l} className="overflow-hidden">
                <div className="flex items-baseline gap-2 px-5 pt-3.5 pb-2.5">
                  <span className="flex-1 text-[15px] font-semibold text-ink">{g.l}</span>
                  <span className={cx("text-[22px] font-semibold", g.red ? "text-danger" : "text-ink")}>{nf(g.n)}</span>
                </div>
                <div className="px-5 pb-2.5 text-[13px] text-muted">{g.sub}</div>
                {g.items.map((i, k) => {
                  const inner = (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{i.t}</span>
                        <span className="block text-xs text-muted">{i.m}</span>
                      </span>
                      {i.tag}
                    </>
                  );
                  const cls = "flex w-full items-center gap-2.5 border-t border-divider bg-surface px-5 py-2.5 no-underline";
                  return i.href ? (
                    <Link key={k} href={i.href} className={cx(cls, "hover:bg-canvas hover:no-underline")}>
                      {inner}
                    </Link>
                  ) : (
                    <div key={k} className={cls}>
                      {inner}
                    </div>
                  );
                })}
                {!g.items.length ? <div className="px-5 pt-3 pb-4 text-[13px] text-muted">{g.empty}</div> : null}
              </Card>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-baseline gap-2.5">
            <span className={h2}>My work</span>
            <span className="text-[13px] text-muted">
              {nf(mine.length)} assigned to {user.name} in the next 90 days
            </span>
          </div>
          <Card className="overflow-hidden">
            {mine.slice(0, 6).map((a) => (
              <AttentionRow key={a.id} a={a} />
            ))}
            {!mine.length ? <div className={empty}>Nothing assigned to you needs attention in the next 90 days.</div> : null}
          </Card>
        </section>

        <section>
          <div className="mb-3 flex items-baseline gap-2.5">
            <span className={h2}>Upcoming 90 days</span>
            <span className="text-[13px] text-muted">{nf(up.length)} end dates · each dot one asset, sized by importance</span>
          </div>
          <Card className="px-6 py-5">
            <div className="relative h-[120px]">
              {Array.from({ length: 13 }, (_, i) => (
                <span key={i} className={cx("absolute top-0 bottom-0 border-l border-dashed", i === 0 ? "border-faint" : "border-divider")} style={{ left: `${((i * 7) / 90) * 100}%` }}>
                  <span className="absolute -bottom-5 left-0 text-2xs whitespace-nowrap text-muted">{i === 0 ? "Today" : fds(addDays(day, i * 7))}</span>
                </span>
              ))}
              {dots.map(({ a, x, y, sz }) => (
                <Link
                  key={a.id}
                  href={`/locker/assets/${a.id}`}
                  title={`${a.title} · ${daysLabel(a.d)}`}
                  aria-label={`${a.title} · ${daysLabel(a.d)}`}
                  className="absolute rounded-full border-2 border-surface p-0 shadow-[0_0_0_1px_rgba(15,27,51,0.08)]"
                  style={{ left: `calc(${x}% - ${sz / 2}px)`, bottom: 4 + y * 15, width: sz, height: sz, background: CRIT[a.crit].edge }}
                />
              ))}
            </div>
            <div className="mt-8 flex flex-wrap gap-4 text-xs text-body">
              {[4, 3, 2, 1].map((k) => (
                <span key={k} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: CRIT[k].edge }} />
                  {CRIT[k].label}
                </span>
              ))}
            </div>
          </Card>
        </section>
      </div>
    </>
  );
}
