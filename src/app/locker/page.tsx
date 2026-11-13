import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { addDays } from "@/lib/format";
import { lockerAccess } from "@/lib/locker/access";
import { CRIT, daysLabel } from "@/lib/locker/engine";
import { cardRisks, identityRisks, toLite } from "@/lib/locker/register-service";
import { registerFor, today } from "@/lib/locker/service";
import { C, LBL, fd, fds, nf } from "@/lib/locker/style";
import { PageHead, Tag } from "./_ui/kit";
import { AttentionRow } from "./_ui/register-parts";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const box = { background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden" } as const;
const h2 = { fontSize: 18, lineHeight: "24px", fontWeight: 600, color: C.ink } as const;

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

  return (
    <>
      <PageHead crumb="Locker · Overview" title="Dashboard" sub="What needs attention, most serious first." />
      <div style={{ padding: "0 24px 40px 24px", display: "flex", flexDirection: "column", gap: 32 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr)) 260px", gap: 16 }}>
          {strip.map((k) => {
            const red = k.red && k.v > 0;
            const inner = (
              <>
                <span style={{ ...LBL, display: "block" }}>{k.l}</span>
                <span style={{ display: "block", fontSize: 32, lineHeight: "36px", fontWeight: 600, color: red ? C.red : C.ink, marginTop: 6 }}>{nf(k.v)}</span>
                <span style={{ display: "block", fontSize: 12, color: red ? C.redInk : C.muted, marginTop: 2 }}>{k.s}</span>
              </>
            );
            const st = { ...box, padding: "16px 20px", textAlign: "left" as const, textDecoration: "none", display: "block" };
            return k.href ? (
              <Link key={k.l} href={k.href} className="lk-card-hover" style={st}>
                {inner}
              </Link>
            ) : (
              <div key={k.l} style={st}>
                {inner}
              </div>
            );
          })}
          <div style={{ ...box, padding: "16px 20px" }}>
            <div style={LBL}>How complete the register is</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 6 }}>
              <span style={{ fontSize: 32, lineHeight: "36px", fontWeight: 600, color: C.ink }}>{cp}%</span>
              <span style={{ fontSize: 13, color: C.muted }}>filled in and checked</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: C.line2, marginTop: 10, overflow: "hidden" }}>
              <div style={{ height: 6, width: `${cp}%`, background: C.brand, borderRadius: 3 }} />
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
              {nf(live.length - filled)} of {nf(live.length)} assets missing an owner, backup or check
            </div>
          </div>
        </div>

        <section>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
            <span style={h2}>Critical items needing attention</span>
            <span style={{ fontSize: 13, color: C.muted }}>{nf(crit.length)} inside their time needed to renew · with what happens if each runs out</span>
          </div>
          <div style={box}>
            {crit.slice(0, 8).map((a) => (
              <AttentionRow key={a.id} a={a} conseq />
            ))}
            {!crit.length ? <div style={{ padding: 20, fontSize: 14, color: C.muted }}>No business-critical asset is inside its renewal window.</div> : null}
          </div>
        </section>

        <section>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
            <span style={h2}>Overdue</span>
            <span style={{ fontSize: 13, color: C.muted }}>{nf(ov.length)} past end date · grace, applied and expired shown separately</span>
          </div>
          <div style={box}>
            {ov.slice(0, 6).map((a) => (
              <AttentionRow key={a.id} a={a} />
            ))}
            {!ov.length ? <div style={{ padding: 20, fontSize: 14, color: C.muted }}>Nothing is past its end date.</div> : null}
            {ov.length > 6 && reg ? (
              <Link href="/locker/assets?view=over" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: 38, borderTop: `1px solid ${C.line2}`, background: C.canvas, color: C.brandInk, fontSize: 13, fontWeight: 500, textDecoration: "none" }}>
                All {nf(ov.length)} overdue in the register
              </Link>
            ) : null}
          </div>
        </section>

        <section>
          <div style={{ ...h2, marginBottom: 12 }}>Hidden risks</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 16 }}>
            {risks.map((g) => (
              <div key={g.l} style={box}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "14px 20px 10px 20px" }}>
                  <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: C.ink }}>{g.l}</span>
                  <span style={{ fontSize: 22, fontWeight: 600, color: g.red ? C.red : C.ink }}>{nf(g.n)}</span>
                </div>
                <div style={{ fontSize: 13, color: C.muted, padding: "0 20px 10px 20px" }}>{g.sub}</div>
                {g.items.map((i, k) => {
                  const inner = (
                    <>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i.t}</span>
                        <span style={{ display: "block", fontSize: 12, color: C.muted }}>{i.m}</span>
                      </span>
                      {i.tag}
                    </>
                  );
                  const st = { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 20px", borderTop: `1px solid ${C.line3}`, background: "#FFFFFF", textDecoration: "none" } as const;
                  return i.href ? (
                    <Link key={k} href={i.href} className="lk-row" style={st}>
                      {inner}
                    </Link>
                  ) : (
                    <div key={k} style={st}>
                      {inner}
                    </div>
                  );
                })}
                {!g.items.length ? <div style={{ padding: "12px 20px 16px 20px", fontSize: 13, color: C.muted }}>{g.empty}</div> : null}
              </div>
            ))}
          </div>
        </section>

        <section>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
            <span style={h2}>My work</span>
            <span style={{ fontSize: 13, color: C.muted }}>
              {nf(mine.length)} assigned to {user.name} in the next 90 days
            </span>
          </div>
          <div style={box}>
            {mine.slice(0, 6).map((a) => (
              <AttentionRow key={a.id} a={a} />
            ))}
            {!mine.length ? <div style={{ padding: 20, fontSize: 14, color: C.muted }}>Nothing assigned to you needs attention in the next 90 days.</div> : null}
          </div>
        </section>

        <section>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
            <span style={h2}>Upcoming 90 days</span>
            <span style={{ fontSize: 13, color: C.muted }}>{nf(up.length)} end dates · each dot one asset, sized by importance</span>
          </div>
          <div style={{ ...box, overflow: "visible", padding: "20px 24px" }}>
            <div style={{ position: "relative", height: 120 }}>
              {Array.from({ length: 13 }, (_, i) => (
                <span key={i} style={{ position: "absolute", left: `${((i * 7) / 90) * 100}%`, top: 0, bottom: 0, borderLeft: `1px dashed ${i === 0 ? C.faint : C.line2}` }}>
                  <span style={{ position: "absolute", bottom: -20, left: 0, fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>{i === 0 ? "Today" : fds(addDays(day, i * 7))}</span>
                </span>
              ))}
              {dots.map(({ a, x, y, sz }) => (
                <Link
                  key={a.id}
                  href={`/locker/assets/${a.id}`}
                  title={`${a.title} · ${daysLabel(a.d)}`}
                  aria-label={`${a.title} · ${daysLabel(a.d)}`}
                  style={{ position: "absolute", left: `calc(${x}% - ${sz / 2}px)`, bottom: 4 + y * 15, width: sz, height: sz, borderRadius: "50%", border: "2px solid #FFFFFF", background: CRIT[a.crit].edge, padding: 0, boxShadow: "0 0 0 1px rgba(26,30,40,0.08)" }}
                />
              ))}
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 32, fontSize: 12, color: C.body }}>
              {[4, 3, 2, 1].map((k) => (
                <span key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: CRIT[k].edge }} />
                  {CRIT[k].label}
                </span>
              ))}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
