"use client";

import { CardGrid } from "@/components/ui/card-grid";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { exportBackupPlan } from "@/lib/actions/locker-vault";
import { blastRadius, dependentsOf, narrate, rankIdentities, type GCred, type GIdentity, type GLink } from "@/lib/locker/graph";
import { C, Chip, Pill, nf, useToast } from "../../_ui/kit";

const KINDS = ["Shared sign-in", "Recovery email", "Billing owner"] as const;

export function GraphScreen({ identities, creds, links, initial }: { identities: GIdentity[]; creds: GCred[]; links: GLink[]; initial: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const ranked = rankIdentities(identities, creds, links);
  const [selId, setSelId] = useState<string | null>(initial);
  const [kinds, setKinds] = useState<Record<string, boolean>>({ "Shared sign-in": true, "Recovery email": true, "Billing owner": true });
  const [sole, setSole] = useState(false);
  const [node, setNode] = useState<string | null>(null);
  const [wi, setWi] = useState(false);
  const sel = identities.find((i) => i.id === selId) ?? ranked[0]?.identity;

  if (!sel)
    return (
      <div style={{ padding: "0 24px 48px 24px" }}>
        <div style={{ background: "#FFFFFF", border: `1px solid ${C.v100}`, borderRadius: 6, padding: "48px 24px", textAlign: "center", fontSize: 15, color: C.muted }}>
          No sign-in accounts are recorded yet. Add them under Sign-in accounts, then record which logins sign in through each.
        </div>
      </div>
    );

  const risk = (i: GIdentity) => (!i.controlled ? C.red : !i.mfa ? "#B77B08" : C.v500);
  const all = links.filter((l) => l.identityId === sel.id && kinds[l.kind] && (!sole || l.sole));
  const seen = new Set<string>();
  const E = all.filter((l) => (seen.has(l.credentialId) ? false : (seen.add(l.credentialId), true)));
  const shown = E.slice(0, 18);
  const C2 = new Map(creds.map((c) => [c.id, c]));
  const cx = 380;
  const cy = 270;
  const nodes = shown.map((e, i) => {
    const x = C2.get(e.credentialId)!;
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(shown.length, 1);
    const R = shown.length > 14 ? (i % 2 ? 215 : 160) : 190;
    const px = cx + Math.cos(ang) * R;
    const py = cy + Math.sin(ang) * R * 0.92;
    const hot = e.sole && x.tier !== "standard";
    const on = !node || node === x.id;
    return { e, x, px, py, hot, on };
  });
  const deps = dependentsOf(sel.id, creds, links);
  const soleN = deps.filter((d) => d.sole).length;
  const score = ranked.find((r) => r.identity.id === sel.id)?.score ?? 0;
  const blast = blastRadius(sel.id, identities, creds, links)!;
  const facts: [string, string, boolean][] = [
    ["Company controlled", sel.controlled ? "Yes" : `No — ${sel.controlledByName ?? "a person"}`, !sel.controlled],
    ["2-step sign-in", sel.mfa ? "Enabled" : "Off", !sel.mfa],
    ["Recovery", sel.recovery ? "Configured" : "Missing", !sel.recovery],
    ["Linked services", String(deps.length), false],
    ["Only-way-in services", String(soleN), soleN > 0],
    ["Lost with it, all told", String(blast.affected.length), false],
    ["Risk score", nf(score), score > 100],
  ];
  const label = (t: string) => t.split(" · ")[0].split(" — ")[0];

  return (
    <div style={{ padding: "0 24px 48px 24px", display: "grid", gridTemplateColumns: "minmax(190px,230px) minmax(0,1fr)", gap: 16, alignItems: "start" }}>
      <div style={{ background: "#FFFFFF", border: `1px solid ${C.v100}`, borderRadius: 6, overflow: "hidden", position: "sticky", top: 16 }}>
        <div style={{ padding: "10px 14px", background: C.v50, borderBottom: `1px solid ${C.v100}`, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: C.v700 }}>Sign-in accounts · by Risk score</div>
        <div style={{ maxHeight: "calc(100vh - 220px)", overflowY: "auto" }}>
          {ranked.map(({ identity: i, score: s, direct }) => (
            <button
              key={i.id}
              type="button"
              onClick={() => {
                setSelId(i.id);
                setNode(null);
                setWi(false);
                router.replace(`/locker/vault/connections?id=${i.id}`, { scroll: false });
              }}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 14px", border: "none", borderTop: `1px solid ${C.v50}`, background: i.id === sel.id ? C.v50 : "#FFFFFF", boxShadow: i.id === sel.id ? `inset 3px 0 0 ${C.v700}` : "none", textAlign: "left", cursor: "pointer" }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: C.v900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i.email}</span>
                <span style={{ display: "block", fontSize: 11, color: C.muted }}>
                  {i.provider} · {direct} linked services
                </span>
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: risk(i) === C.v500 ? C.v700 : risk(i) }}>{nf(s)}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ background: "#FFFFFF", border: `1px solid ${C.v100}`, borderRadius: 6, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${C.v100}`, flexWrap: "wrap", rowGap: 8 }}>
          {KINDS.map((k) => (
            <Chip key={k} vault label={k} on={!!kinds[k]} onFlip={() => setKinds({ ...kinds, [k]: !kinds[k] })} />
          ))}
          <span style={{ flex: 1 }} />
          <Chip vault label="Only way in" on={sole} onFlip={() => setSole(!sole)} />
        </div>
        <div style={{ position: "relative" }}>
          <svg viewBox="0 0 760 560" style={{ width: "100%", height: "auto", display: "block", background: C.canvas }} role="img" aria-label={`What relies on ${sel.email}`}>
            {nodes.map((n) => (
              <line key={`l${n.x.id}`} x1={cx} y1={cy} x2={n.px.toFixed(1)} y2={n.py.toFixed(1)} stroke={n.e.sole ? C.red : C.v500} strokeWidth={n.on && node ? 2.5 : 1.2} strokeDasharray={n.e.kind === "Recovery email" ? "4 4" : n.e.kind === "Billing owner" ? "1 4" : undefined} opacity={n.on ? 0.9 : 0.15} />
            ))}
            {nodes.map((n) => (
              <circle
                key={`c${n.x.id}`}
                onClick={() => setNode(node === n.x.id ? null : n.x.id)}
                style={{ cursor: "pointer" }}
                opacity={n.on ? 1 : 0.25}
                cx={n.px.toFixed(1)}
                cy={n.py.toFixed(1)}
                r={n.x.tier === "restricted" ? 12 : n.x.tier === "sensitive" ? 10 : 8}
                fill={n.hot ? "#FCECEC" : n.e.sole ? "#FDF6E7" : C.v50}
                stroke={n.hot ? C.red : n.e.sole ? "#B77B08" : C.v500}
                strokeWidth={node === n.x.id ? 3 : 1.5}
              />
            ))}
            <circle onClick={() => setNode(null)} style={{ cursor: "pointer" }} cx={cx} cy={cy} r={34} fill={!sel.controlled ? C.red : !sel.mfa ? "#B77B08" : C.v700} stroke="#FFFFFF" strokeWidth={3} />
          </svg>
          {[
            ...nodes.map((n) => ({ key: n.x.id, x: n.px, ty: n.py + (n.py > cy ? 28 : -20), l: label(n.x.title), l2: n.e.sole ? "only way in" : "", c2: C.red, o: n.on ? 1 : 0.25, main: false, go: () => setNode(node === n.x.id ? null : n.x.id) })),
            { key: "root", x: cx, ty: cy + 58, l: sel.email.length > 26 ? sel.email.slice(0, 24) + "…" : sel.email, l2: `${deps.length} linked services · 2-step sign-in ${sel.mfa ? "on" : "off"}`, c2: !sel.controlled ? C.red : C.v700, o: 1, main: true, go: () => setNode(null) },
          ].map((t) => {
            const below = t.ty > (t.main ? cy : 0) || t.main;
            return (
              <button
                key={t.key}
                type="button"
                onClick={t.go}
                style={{ position: "absolute", left: `${(t.x / 760) * 100}%`, top: `${(t.ty / 560) * 100}%`, transform: `translate(-50%,${below ? "-30%" : "-70%"})`, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, padding: "1px 4px", border: "none", borderRadius: 3, background: "rgba(252,252,253,0.85)", cursor: "pointer", opacity: t.o, whiteSpace: "nowrap", maxWidth: 150 }}
              >
                <span style={{ fontSize: t.main ? 13 : 12, lineHeight: "15px", fontWeight: t.main ? 600 : 500, color: C.v900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", maxWidth: 146 }}>{t.l}</span>
                {t.l2 ? <span style={{ fontSize: 11, lineHeight: "13px", fontWeight: 500, color: t.c2 }}>{t.l2}</span> : null}
              </button>
            );
          })}
          {!shown.length ? <div style={{ position: "absolute", left: 0, right: 0, top: "62%", textAlign: "center", fontSize: 13, color: C.muted }}>Nothing recorded relies on this account{sole ? " as its only way in" : ""}.</div> : null}
        </div>
        <div style={{ display: "flex", gap: 16, padding: "10px 14px", borderTop: `1px solid ${C.v100}`, fontSize: 12, color: C.body, flexWrap: "wrap" }}>
          {(
            [
              ["Personal or no-2-step sign-in account", C.red],
              ["Only way in, sensitive or above", "#FCECEC"],
              ["Only way in", "#FDF6E7"],
              ["Has another way in", C.v50],
            ] as const
          ).map(([l, col]) => (
            <span key={l} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: col, border: `1px solid ${C.v500}` }} />
              {l}
            </span>
          ))}
          {E.length > shown.length ? <span>+{E.length - shown.length} more not drawn — see the risk list</span> : null}
        </div>
      </div>
      <div style={{ gridColumn: 2 }}>
        <CardGrid min={280} className="items-start">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: "#FFFFFF", border: `1px solid ${C.v100}`, borderRadius: 6, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", background: C.v50, borderBottom: `1px solid ${C.v100}` }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: C.v900, wordBreak: "break-all" }}>{sel.email}</div>
              <div style={{ fontSize: 12, color: C.v500 }}>
                {sel.provider} · {sel.kind}
              </div>
            </div>
            {facts.map(([l, v, bad]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 16px", borderTop: `1px solid ${C.v50}`, fontSize: 13 }}>
                <span style={{ color: C.muted }}>{l}</span>
                <span style={{ fontWeight: 600, color: bad ? C.red : C.v900 }}>{v}</span>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setWi(!wi)} style={{ height: 40, border: "none", borderRadius: 4, background: C.v700, color: "#FFFFFF", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>
            What if we lose this?
          </button>
        </div>
        {wi ? (
          <div style={{ background: "#FFFFFF", border: `1px solid ${C.v100}`, borderRadius: 6, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.v100}`, fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "#343E96" }}>◈ What breaks · explained</div>
            <div style={{ padding: "12px 16px", fontSize: 14, lineHeight: "21px", color: C.ink, textWrap: "pretty" }}>{narrate(blast)}</div>
            {blast.affected.slice(0, 12).map((a) => (
              <button
                key={a.cred.id}
                type="button"
                onClick={() => router.push(`/locker/vault/${a.cred.id}`)}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 16px", border: "none", borderTop: `1px solid ${C.v50}`, background: "#FFFFFF", textAlign: "left", cursor: "pointer" }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, color: C.v900, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.cred.title}</span>
                  <span style={{ display: "block", fontSize: 11, color: C.muted }}>
                    {a.kind}
                    {a.depth > 1 ? ` · through ${a.via}` : ""} · recovery {a.sole ? `needs ${a.cred.provider || "the provider"}'s support, days to weeks` : "via another admin, hours"}
                  </span>
                </span>
                {a.sole ? <Pill label="No other path" bg="#FCECEC" fg="#B3261E" /> : <Pill label="Can be recovered" bg="#E9F5EE" fg="#1D7A45" />}
              </button>
            ))}
            {blast.affected.length > 12 ? <div style={{ padding: "8px 16px", fontSize: 12, color: C.muted }}>and {blast.affected.length - 12} more in the backup plan</div> : null}
            <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.v50}` }}>
              <button
                type="button"
                onClick={async () => {
                  const r = await exportBackupPlan(sel.id);
                  if (!r.ok) return toast(r.error);
                  const url = URL.createObjectURL(new Blob([r.data.text], { type: "text/plain" }));
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = r.data.filename;
                  a.click();
                  URL.revokeObjectURL(url);
                  toast("Backup plan exported · the export is recorded");
                }}
                style={{ height: 30, padding: "0 10px", border: "1px solid #C2C8D2", background: "#FFFFFF", borderRadius: 4, fontSize: 12, cursor: "pointer" }}
              >
                Export as a backup plan
              </button>
            </div>
          </div>
        ) : null}
      </CardGrid>
      </div>
    </div>
  );
}
