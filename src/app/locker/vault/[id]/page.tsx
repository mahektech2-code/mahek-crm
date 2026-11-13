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
import { Pill, TierPill } from "../../_ui/kit";
import { C, LBL, MONO, when } from "@/lib/locker/style";
import { RevealButton } from "../../_ui/reveal-dialog";
import { NoVaultKey } from "../../_ui/vault-parts";
import { CredActions, LinkControls } from "./cred-actions";

export const metadata = { title: "Login" };

const panel: React.CSSProperties = { background: "#FFFFFF", border: `1px solid ${C.v100}`, borderRadius: 6, overflow: "hidden" };
function Head({ t, right }: { t: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 20px", background: C.v50, borderBottom: `1px solid ${C.v100}`, color: C.v900, fontSize: 15, fontWeight: 600 }}>
      <span style={{ flex: 1 }}>{t}</span>
      {right ? <span style={{ fontSize: 12, fontWeight: 400, color: C.v500 }}>{right}</span> : null}
    </div>
  );
}
const MFA_LABEL: Record<string, string> = { totp: "Authenticator app", sms: "SMS", email: "Email code", hardware_key: "Hardware key", app_push: "App push", none: "Not enabled" };

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
    <div key={l} style={{ display: "grid", gridTemplateColumns: "160px minmax(0,1fr)", gap: 12, padding: "12px 20px", borderTop: `1px solid ${C.v50}` }}>
      <span style={LBL}>{l}</span>
      <span style={{ fontSize: 14, color: warn ? C.amber : C.v900, fontWeight: warn ? 500 : 400, fontFamily: mono ? MONO : "inherit", wordBreak: "break-all" }}>{v}</span>
    </div>
  );
  const okPill = (l: string) => <Pill label={l} bg="#E9F5EE" fg="#1D7A45" />;
  const badPill = (l: string) => <Pill label={l} bg="#FCECEC" fg="#B3261E" />;
  const flags = d.via && !d.via.controlled ? [`This login signs in through ${d.via.email}, a personal account controlled by ${d.via.controlledByName ?? "somebody"}. If that person leaves, access may be lost for good. Move it to a company sign-in account.`] : [];
  const identOpts = g.identities.map((i) => ({ id: i.id, email: i.email })).sort((a, b) => a.email.localeCompare(b.email));

  return (
    <div style={{ padding: "20px 24px 48px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
      {vaultReady() ? null : <NoVaultKey />}
      <div style={{ ...panel, boxShadow: `inset 3px 0 0 ${C.v700}` }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, padding: "20px 24px", flexWrap: "wrap" }}>
          <Link href="/locker/vault" title="Back" style={{ width: 32, height: 32, border: `1px solid ${C.v100}`, background: "#FFFFFF", borderRadius: 4, color: C.v700, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}>
            ‹
          </Link>
          <span style={{ flex: 1, minWidth: 260 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: C.v700, fontSize: 16 }}>◈</span>
              <TierPill tier={tier} />
              <span style={{ fontSize: 12, color: C.v500 }}>
                {c.kind} · {c.env}
              </span>
              {!c.active ? <Pill label="Retired" bg="#F7F8FA" fg="#6B7385" /> : null}
            </span>
            <span style={{ display: "block", fontSize: 22, lineHeight: "28px", fontWeight: 600, color: C.v900, marginTop: 8 }}>{c.title}</span>
            <span style={{ display: "block", fontSize: 13, color: C.v500, marginTop: 4 }}>
              {[c.provider, c.url, d.ownerName ? `owner ${d.ownerName}` : "no owner"].filter(Boolean).join(" · ")}
            </span>
          </span>
          <CredActions id={c.id} title={c.title} provider={c.provider} fields={d.current.map((x) => x.field)} canWrite={vaultReady()} />
        </div>
        {flags.map((f) => (
          <div key={f} style={{ margin: "0 24px 16px 72px", padding: "10px 14px", borderRadius: 4, background: "#FCECEC", color: C.red, fontSize: 13, fontWeight: 500 }}>
            {f}
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.35fr) minmax(0,1fr)", gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div style={panel}>
            <Head t="◈ Secrets" right="Hidden by default · each revealed separately" />
            {d.current.length ? (
              d.current.map((v) => (
                <div key={v.id} style={{ display: "grid", gridTemplateColumns: "minmax(110px,150px) minmax(0,1fr) auto", gap: 12, alignItems: "center", minHeight: 56, padding: "8px 20px", borderTop: `1px solid ${C.v50}` }}>
                  <span style={LBL}>{v.field}</span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, overflow: "hidden" }}>
                    <span style={{ fontFamily: MONO, fontSize: 15, lineHeight: "20px", letterSpacing: "0.08em", color: C.v700, whiteSpace: "nowrap" }}>••••••••••••</span>
                    <span style={{ fontSize: 12, lineHeight: "16px", color: C.muted, fontFamily: MONO }}>ends ····{v.hint}</span>
                  </span>
                  <RevealButton credentialId={c.id} title={c.title} tier={tier} field={v.field} />
                </div>
              ))
            ) : (
              <div style={{ padding: "14px 20px", fontSize: 13, color: C.muted }}>{c.auth === "federated_sso" ? `No secret of its own — it signs in through ${d.via?.email ?? "another account"}.` : "No value stored yet. Use Change to record one."}</div>
            )}
            <div style={{ padding: "12px 20px", borderTop: `1px solid ${C.v50}`, display: "grid", gridTemplateColumns: "160px minmax(0,1fr)", gap: "6px 12px", fontSize: 13 }}>
              <span style={{ color: C.muted }}>Last changed</span>
              <span style={{ color: row?.changeDue ? C.red : C.v900, fontWeight: row?.changeDue ? 600 : 400 }}>{c.lastRotatedAt ? `${when(c.lastRotatedAt.toISOString())} · ${row?.ageDays ?? 0} days ago` : "Never"}</span>
              <span style={{ color: C.muted }}>Last revealed</span>
              <span style={{ color: C.v900 }}>{row?.lastRevealedAt ? `${when(row.lastRevealedAt)} by ${row.lastRevealedBy ?? ""}` : "Never"}</span>
              <span style={{ color: C.muted }}>Change due</span>
              <span style={{ color: row?.changeDue ? C.red : C.v900, fontWeight: row?.changeDue ? 600 : 400 }}>{row ? (row.changeDue ? `${row.overBy} days overdue` : `in ${Math.max(0, row.policyDays - (row.ageDays ?? 0))} days`) : "—"}</span>
            </div>
            <div style={{ padding: "10px 20px", background: C.v50, borderTop: `1px solid ${C.v100}`, fontSize: 12, color: C.v700 }}>ⓘ {notice}</div>
          </div>

          <div style={panel}>
            <Head t="Access" />
            {fv("URL", c.url || "—", true)}
            {fv("Username", c.username || "—", true)}
            {fv("Environment", c.env)}
            {fv("Access level", c.accessLevel || "Not recorded", false, !c.accessLevel)}
            {fv("Owner", d.ownerName ?? "No owner", false, !d.ownerName)}
            {fv("Backup owner", d.backupName ?? "None")}
            {c.notes ? fv("Notes", c.notes) : null}
          </div>

          <div style={panel}>
            <Head t="Authentication, 2-step sign-in & recovery" />
            {fv("Signs in", d.via ? `via ${d.via.email} · ${d.via.provider}${c.sole ? " · no other way in" : ""}` : (AUTH_LABEL[c.auth] ?? "Direct username and password"))}
            {fv("2-step sign-in", c.mfa ? (MFA_LABEL[c.mfaMethod] ?? "Enabled") : "Not enabled", false, !c.mfa)}
            {fv("Recovery email", c.recoveryEmail || (d.via ? d.via.email : "Not recorded"), false, !c.recoveryEmail && !d.via)}
            {d.selfIdentity ? fv("Is the login of", d.selfIdentity.email) : null}
          </div>

          <div style={panel}>
            <Head t="Previous values" right="Kept encrypted · revealing needs a reason" />
            {d.previous.length ? (
              d.previous.map((p) => (
                <div key={p.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "10px 20px", borderTop: `1px solid ${C.v50}` }}>
                  <span>
                    <span style={{ display: "block", fontSize: 14, color: C.v900 }}>
                      {p.field} · replaced {when(p.replacedAt)}
                    </span>
                    <span style={{ display: "block", fontSize: 12, color: C.muted }}>
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
                    style={{ height: 30, padding: "0 12px", border: `1px solid ${C.v700}`, background: "#FFFFFF", borderRadius: 4, color: C.v700, fontSize: 12, fontWeight: 500, cursor: "pointer" }}
                  />
                </div>
              ))
            ) : (
              <div style={{ padding: "12px 20px", fontSize: 13, color: C.muted }}>No earlier values — it has not been changed since it was added.</div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div style={panel}>
            <Head t="Health" />
            {[
              { l: "Password change", m: `Policy every ${row?.policyDays ?? rules.rotateDays} days for ${TIER[tier].label.toLowerCase()} secrets`, b: row?.changeDue ? badPill("Overdue") : okPill("Within policy") },
              {
                l: "Reuse",
                m: d.reuseWith.length ? `This password is used on ${d.reuseWith.length} other ${d.reuseWith.length === 1 ? "item" : "items"}: ${d.reuseWith.map((r) => r.title).join(", ")}. Matched by a one-way code — no password was read.` : "No other item shares this password.",
                b: d.reuseWith.length ? badPill(`Reused · ${d.reuseWith.length + 1}`) : okPill("Unique"),
              },
              { l: "2-step sign-in", m: c.mfa ? MFA_LABEL[c.mfaMethod] ?? "Enabled" : "A password alone protects this login.", b: c.mfa ? okPill("On") : tier === "standard" ? <Pill label="Off" bg="#FDF6E7" fg="#8A5C05" /> : badPill("Off") },
              { l: "Last checked working", m: c.lastVerifiedAt ? `${when(c.lastVerifiedAt.toISOString())} — recorded with a change` : "Not confirmed since it was added.", b: c.lastVerifiedAt ? okPill("Working") : <Pill label="Not checked" bg="#FDF6E7" fg="#8A5C05" /> },
            ].map((h) => (
              <div key={h.l} style={{ padding: "12px 20px", borderTop: `1px solid ${C.v50}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1, fontSize: 14, color: C.v900, fontWeight: 500 }}>{h.l}</span>
                  {h.b}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{h.m}</div>
              </div>
            ))}
          </div>

          <div style={panel}>
            <Head t="Who can reveal this" />
            {who.length ? (
              who.map((w) => (
                <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 20px", borderTop: `1px solid ${C.v50}`, fontSize: 14 }}>
                  <span style={{ flex: 1, color: C.v900 }}>{w.name}</span>
                  <span style={{ fontSize: 12, color: C.muted }}>{w.id === c.ownerId ? "owner" : "Passwords & keys"}{tier === "restricted" ? " · with a second approver" : ""}</span>
                </div>
              ))
            ) : (
              <div style={{ padding: "12px 20px", fontSize: 13, color: C.red }}>Nobody can reveal it except through emergency access. Name somebody on Edit.</div>
            )}
          </div>

          <div style={panel}>
            <Head t="Connections" />
            {d.links.map((l) => (
              <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 20px", borderTop: `1px solid ${C.v50}` }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <Link href={`/locker/vault/connections?id=${l.identity?.id ?? ""}`} style={{ display: "block", fontSize: 14, color: C.v900, fontWeight: 500, textDecoration: "none" }}>
                    {l.identity?.email ?? "Removed account"}
                  </Link>
                  <span style={{ display: "block", fontSize: 12, color: C.muted }}>
                    {l.kind} · {l.identity?.provider ?? ""}
                  </span>
                </span>
                {l.sole ? <Pill label="Only way in" bg="#FCECEC" fg="#B3261E" /> : <Pill label={l.kind} bg={C.v50} fg={C.v700} />}
                <LinkControls mode="remove" linkId={l.id} credentialId={c.id} />
              </div>
            ))}
            {d.dependants.map((x) => (
              <Link key={x.id + x.kind} href={`/locker/vault/${x.id}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 20px", borderTop: `1px solid ${C.v50}`, textDecoration: "none" }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, color: C.v900, fontWeight: 500 }}>{x.title}</span>
                  <span style={{ display: "block", fontSize: 12, color: C.muted }}>Relies on this inbox · {x.kind}</span>
                </span>
                {x.sole ? <Pill label="Only way in" bg="#FCECEC" fg="#B3261E" /> : <Pill label={x.kind} bg={C.v50} fg={C.v700} />}
              </Link>
            ))}
            {!d.links.length && !d.dependants.length ? <div style={{ padding: "12px 20px", fontSize: 13, color: C.muted }}>No connections recorded.</div> : null}
            <div style={{ padding: "10px 20px", borderTop: `1px solid ${C.v50}` }}>
              <LinkControls mode="add" credentialId={c.id} identities={identOpts} />
            </div>
          </div>

          <div style={panel}>
            <Head t="Reveal history" right={`${d.history.length.toLocaleString("en-IN")} reveals`} />
            {d.history.length ? (
              d.history.map((h, i) => (
                <div key={i} style={{ padding: "10px 20px", borderTop: `1px solid ${C.v50}` }}>
                  <div style={{ display: "flex", gap: 8, fontSize: 13, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, color: C.v900 }}>{h.who}</span>
                    <span style={{ color: C.muted }}>{when(h.at, true)}</span>
                    <span style={{ color: C.muted }}>
                      · {h.field}
                      {h.previous ? " (previous)" : ""}
                      {h.approvedBy ? ` · approved by ${h.approvedBy}` : ""}
                      {h.emergency ? " · emergency access" : ""}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: C.body, marginTop: 2 }}>“{h.reason}”</div>
                </div>
              ))
            ) : (
              <div style={{ padding: "12px 20px", fontSize: 13, color: C.muted }}>Never revealed.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
