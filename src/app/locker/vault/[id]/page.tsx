import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { AUTH_LABEL } from "@/lib/locker/catalogue";
import { vaultReady } from "@/lib/locker/crypto";
import { TIER, type Tier } from "@/lib/locker/engine";
import { lockerSettingsRow } from "@/lib/locker/service";
import { holdersOf } from "@/lib/locker/vault-core";
import { credentialDetail, graphData } from "@/lib/locker/vault-service";
import { Badge, Card, cx } from "@/components/ui/primitives";
import { TierPill } from "../../_ui/kit";
import { LkIcon } from "../../_ui/icons";
import { when } from "@/lib/locker/style";
import { RevealButton } from "../../_ui/reveal-dialog";
import { NoVaultKey } from "../../_ui/vault-parts";
import { CredActions, LinkControls } from "./cred-actions";

export const metadata = { title: "Login" };

/* A panel on this page: the v4 card with its header bar. */
function Head({ t, right, lock }: { t: string; right?: React.ReactNode; lock?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-divider px-5 py-3.5 text-base font-semibold text-ink">
      {lock ? (
        <span className="flex text-muted">
          <LkIcon name="key" size={15} />
        </span>
      ) : null}
      <span className="flex-1">{t}</span>
      {right ? <span className="text-xs font-normal text-muted">{right}</span> : null}
    </div>
  );
}
const MFA_LABEL: Record<string, string> = { totp: "Authenticator app", sms: "SMS", email: "Email code", hardware_key: "Hardware key", app_push: "App push", none: "Not enabled" };
const LBL = "text-xs font-medium tracking-label text-muted uppercase";
const ROW = "border-t border-divider first:border-t-0";

export default async function CredentialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  await requireModule(user.id, "locker.credentials");
  const [d, s, holders, g] = await Promise.all([credentialDetail(id), lockerSettingsRow(), holdersOf("locker.credentials"), graphData()]);
  if (!d) notFound();
  const { c, row } = d;
  const tier = c.tier as Tier;
  const rules = s.tiers[tier];
  const who = tier === "restricted" ? holders.filter((h) => h.id === c.ownerId || c.revealers.includes(h.id)) : holders;
  const notice =
    tier === "standard"
      ? `Revealing this is recorded. It hides after ${rules.showSeconds} seconds.`
      : tier === "sensitive"
        ? `Revealing this needs your password and a reason. It is recorded and the owner is notified. It hides after ${rules.showSeconds} seconds.`
        : `Revealing this needs a second person’s approval and your password. Management is notified. It hides after ${rules.showSeconds} seconds and cannot be copied.`;
  const fv = (l: string, v: React.ReactNode, mono = false, warn = false) => (
    <div key={l} className={cx("grid grid-cols-[160px_minmax(0,1fr)] gap-3 px-5 py-3", ROW)}>
      <span className={LBL}>{l}</span>
      <span className={cx("text-sm break-all", warn ? "font-medium text-warn-ink" : "text-ink", mono && "font-mono")}>{v}</span>
    </div>
  );
  const okPill = (l: string) => <Badge tone="success">{l}</Badge>;
  const badPill = (l: string) => <Badge tone="danger">{l}</Badge>;
  const flags = d.via && !d.via.controlled ? [`This login signs in through ${d.via.email}, a personal account controlled by ${d.via.controlledByName ?? "somebody"}. If that person leaves, access may be lost for good. Move it to a company sign-in account.`] : [];
  const identOpts = g.identities.map((i) => ({ id: i.id, email: i.email })).sort((a, b) => a.email.localeCompare(b.email));

  return (
    <div className="flex flex-col gap-4 px-6 pt-6 pb-12">
      {vaultReady() ? null : <NoVaultKey />}
      <Card className="overflow-hidden shadow-[inset_3px_0_0_var(--color-ink)]">
        <div className="flex flex-wrap items-start gap-4 px-6 py-5">
          <Link href="/locker/vault" title="Back" className="flex h-8 w-8 flex-none items-center justify-center rounded-control border border-line bg-surface text-body no-underline hover:bg-canvas hover:no-underline">
            ‹
          </Link>
          <span className="min-w-[260px] flex-1">
            <span className="flex items-center gap-2">
              <span className="flex text-muted">
                <LkIcon name="key" size={16} />
              </span>
              <TierPill tier={tier} />
              <span className="text-xs text-muted">
                {c.kind} · {c.env}
              </span>
              {!c.active ? <Badge tone="muted">Retired</Badge> : null}
            </span>
            <span className="mt-2 block text-[22px] leading-7 font-semibold text-ink">{c.title}</span>
            <span className="mt-1 block text-[13px] text-muted">
              {[c.provider, c.url, d.ownerName ? `owner ${d.ownerName}` : "no owner"].filter(Boolean).join(" · ")}
            </span>
          </span>
          <CredActions id={c.id} title={c.title} provider={c.provider} fields={d.current.map((x) => x.field)} canWrite={vaultReady()} />
        </div>
        {flags.map((f) => (
          <div key={f} className="mx-6 mb-4 ml-[72px] rounded-control bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
            {f}
          </div>
        ))}
      </Card>

      <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] items-start gap-4">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="overflow-hidden">
            <Head lock t="Secrets" right="Hidden by default · each revealed separately" />
            {d.current.length ? (
              d.current.map((v) => (
                <div key={v.id} className={cx("grid min-h-14 grid-cols-[minmax(110px,150px)_minmax(0,1fr)_auto] items-center gap-3 px-5 py-2", ROW)}>
                  <span className={LBL}>{v.field}</span>
                  <span className="flex min-w-0 flex-col gap-0.5 overflow-hidden">
                    <span className="font-mono text-[15px] leading-5 tracking-[0.08em] whitespace-nowrap text-ink">••••••••••••</span>
                    <span className="font-mono text-xs leading-4 text-muted">ends ····{v.hint}</span>
                  </span>
                  <RevealButton credentialId={c.id} title={c.title} tier={tier} field={v.field} />
                </div>
              ))
            ) : (
              <div className="px-5 py-3.5 text-[13px] text-muted">{c.auth === "federated_sso" ? `No secret of its own — it signs in through ${d.via?.email ?? "another account"}.` : "No value stored yet. Use Change to record one."}</div>
            )}
            <div className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-divider px-5 py-3 text-[13px]">
              <span className="text-muted">Last changed</span>
              <span className={row?.changeDue ? "font-semibold text-danger" : "text-ink"}>{c.lastRotatedAt ? `${when(c.lastRotatedAt.toISOString())} · ${row?.ageDays ?? 0} days ago` : "Never"}</span>
              <span className="text-muted">Last revealed</span>
              <span className="text-ink">{row?.lastRevealedAt ? `${when(row.lastRevealedAt)} by ${row.lastRevealedBy ?? ""}` : "Never"}</span>
              <span className="text-muted">Change due</span>
              <span className={row?.changeDue ? "font-semibold text-danger" : "text-ink"}>{row ? (row.changeDue ? `${row.overBy} days overdue` : `in ${Math.max(0, row.policyDays - (row.ageDays ?? 0))} days`) : "—"}</span>
            </div>
            <div className="border-t border-divider bg-canvas px-5 py-2.5 text-xs text-body">ⓘ {notice}</div>
          </Card>

          <Card className="overflow-hidden">
            <Head t="Access" />
            {fv("URL", c.url || "—", true)}
            {fv("Username", c.username || "—", true)}
            {fv("Environment", c.env)}
            {fv("Access level", c.accessLevel || "Not recorded", false, !c.accessLevel)}
            {fv("Owner", d.ownerName ?? "No owner", false, !d.ownerName)}
            {fv("Backup owner", d.backupName ?? "None")}
            {c.notes ? fv("Notes", c.notes) : null}
          </Card>

          <Card className="overflow-hidden">
            <Head t="Authentication, 2-step sign-in & recovery" />
            {fv("Signs in", d.via ? `via ${d.via.email} · ${d.via.provider}${c.sole ? " · no other way in" : ""}` : (AUTH_LABEL[c.auth] ?? "Direct username and password"))}
            {fv("2-step sign-in", c.mfa ? (MFA_LABEL[c.mfaMethod] ?? "Enabled") : "Not enabled", false, !c.mfa)}
            {fv("Recovery email", c.recoveryEmail || (d.via ? d.via.email : "Not recorded"), false, !c.recoveryEmail && !d.via)}
            {d.selfIdentity ? fv("Is the login of", d.selfIdentity.email) : null}
          </Card>

          <Card className="overflow-hidden">
            <Head t="Previous values" right="Kept encrypted · revealing needs a reason" />
            {d.previous.length ? (
              d.previous.map((p) => (
                <div key={p.id} className={cx("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-5 py-2.5", ROW)}>
                  <span>
                    <span className="block text-sm text-ink">
                      {p.field} · replaced {when(p.replacedAt)}
                    </span>
                    <span className="block text-xs text-muted">
                      Set {when(p.setAt)}
                      {p.by ? ` by ${p.by}` : ""} · kept encrypted
                    </span>
                  </span>
                  <RevealButton
                    credentialId={c.id}
                    title={c.title}
                    tier={tier}
                    field={p.field}
                    previousSecretId={p.id}
                    label="Reveal previous"
                    variant="secondary"
                  />
                </div>
              ))
            ) : (
              <div className="px-5 py-3 text-[13px] text-muted">No earlier values — it has not been changed since it was added.</div>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card className="overflow-hidden">
            <Head t="Health" />
            {[
              { l: "Password change", m: `Policy every ${row?.policyDays ?? rules.rotateDays} days for ${TIER[tier].label.toLowerCase()} secrets`, b: row?.changeDue ? badPill("Overdue") : okPill("Within policy") },
              {
                l: "Reuse",
                m: d.reuseWith.length ? `This password is used on ${d.reuseWith.length} other ${d.reuseWith.length === 1 ? "item" : "items"}: ${d.reuseWith.map((r) => r.title).join(", ")}. Matched by a one-way code — no password was read.` : "No other item shares this password.",
                b: d.reuseWith.length ? badPill(`Reused · ${d.reuseWith.length + 1}`) : okPill("Unique"),
              },
              { l: "2-step sign-in", m: c.mfa ? MFA_LABEL[c.mfaMethod] ?? "Enabled" : "A password alone protects this login.", b: c.mfa ? okPill("On") : tier === "standard" ? <Badge tone="warn">Off</Badge> : badPill("Off") },
              { l: "Last checked working", m: c.lastVerifiedAt ? `${when(c.lastVerifiedAt.toISOString())} — recorded with a change` : "Not confirmed since it was added.", b: c.lastVerifiedAt ? okPill("Working") : <Badge tone="warn">Not checked</Badge> },
            ].map((h) => (
              <div key={h.l} className={cx("px-5 py-3", ROW)}>
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm font-medium text-ink">{h.l}</span>
                  {h.b}
                </div>
                <div className="mt-0.5 text-xs text-muted">{h.m}</div>
              </div>
            ))}
          </Card>

          <Card className="overflow-hidden">
            <Head t="Who can reveal this" />
            {who.length ? (
              who.map((w) => (
                <div key={w.id} className={cx("flex items-center gap-2.5 px-5 py-2.5 text-sm", ROW)}>
                  <span className="flex-1 text-ink">{w.name}</span>
                  <span className="text-xs text-muted">{w.id === c.ownerId ? "owner" : "Passwords & keys"}{tier === "restricted" ? " · with a second approver" : ""}</span>
                </div>
              ))
            ) : (
              <div className="px-5 py-3 text-[13px] text-danger">Nobody can reveal it except through emergency access. Name somebody on Edit.</div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <Head t="Connections" />
            {d.links.map((l) => (
              <div key={l.id} className={cx("flex items-center gap-2.5 px-5 py-2.5", ROW)}>
                <span className="min-w-0 flex-1">
                  <Link href={`/locker/vault/connections?id=${l.identity?.id ?? ""}`} className="block text-sm font-medium text-ink no-underline hover:text-brand">
                    {l.identity?.email ?? "Removed account"}
                  </Link>
                  <span className="block text-xs text-muted">
                    {l.kind} · {l.identity?.provider ?? ""}
                  </span>
                </span>
                {l.sole ? <Badge tone="danger">Only way in</Badge> : <Badge>{l.kind}</Badge>}
                <LinkControls mode="remove" linkId={l.id} credentialId={c.id} />
              </div>
            ))}
            {d.dependants.map((x) => (
              <Link key={x.id + x.kind} href={`/locker/vault/${x.id}`} className={cx("flex items-center gap-2.5 px-5 py-2.5 no-underline hover:bg-canvas hover:no-underline", ROW)}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{x.title}</span>
                  <span className="block text-xs text-muted">Relies on this inbox · {x.kind}</span>
                </span>
                {x.sole ? <Badge tone="danger">Only way in</Badge> : <Badge>{x.kind}</Badge>}
              </Link>
            ))}
            {!d.links.length && !d.dependants.length ? <div className="px-5 py-3 text-[13px] text-muted">No connections recorded.</div> : null}
            <div className="border-t border-divider px-5 py-2.5">
              <LinkControls mode="add" credentialId={c.id} identities={identOpts} />
            </div>
          </Card>

          <Card className="overflow-hidden">
            <Head t="Reveal history" right={`${d.history.length.toLocaleString("en-IN")} reveals`} />
            {d.history.length ? (
              d.history.map((h, i) => (
                <div key={i} className={cx("px-5 py-2.5", ROW)}>
                  <div className="flex flex-wrap gap-2 text-[13px]">
                    <span className="font-semibold text-ink">{h.who}</span>
                    <span className="text-muted">{when(h.at, true)}</span>
                    <span className="text-muted">
                      · {h.field}
                      {h.previous ? " (previous)" : ""}
                      {h.approvedBy ? ` · approved by ${h.approvedBy}` : ""}
                      {h.emergency ? " · emergency access" : ""}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[13px] text-body">“{h.reason}”</div>
                </div>
              ))
            ) : (
              <div className="px-5 py-3 text-[13px] text-muted">Never revealed.</div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
