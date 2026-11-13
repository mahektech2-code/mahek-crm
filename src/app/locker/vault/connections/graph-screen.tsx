"use client";

import { CardGrid } from "@/components/ui/card-grid";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { exportBackupPlan } from "@/lib/actions/locker-vault";
import { blastRadius, dependentsOf, narrate, rankIdentities, type GCred, type GIdentity, type GLink } from "@/lib/locker/graph";
import { Button, Card, cx } from "@/components/ui/primitives";
import { Chip, Pill, nf, useToast } from "../../_ui/kit";
import { LkIcon } from "../../_ui/icons";

/* Colours on the map are the v4 theme's tokens. */
const T = (n: string) => `var(--color-${n})`;

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
      <div className="px-6 pb-12">
        <div className="rounded-card border border-line bg-surface px-6 py-12 text-center text-[15px] text-muted">
          No sign-in accounts are recorded yet. Add them under Sign-in accounts, then record which logins sign in through each.
        </div>
      </div>
    );

  const riskClass = (i: GIdentity) => (!i.controlled ? "text-danger" : !i.mfa ? "text-warn-ink" : "text-ink");
  const all = links.filter((l) => l.identityId === sel.id && kinds[l.kind] && (!sole || l.sole));
  const seen = new Set<string>();
  const E = all.filter((l) => (seen.has(l.credentialId) ? false : (seen.add(l.credentialId), true)));
  const shown = E.slice(0, 18);
  const C2 = new Map(creds.map((c) => [c.id, c]));
  const ox = 380;
  const oy = 270;
  const nodes = shown.map((e, i) => {
    const x = C2.get(e.credentialId)!;
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(shown.length, 1);
    const R = shown.length > 14 ? (i % 2 ? 215 : 160) : 190;
    const px = ox + Math.cos(ang) * R;
    const py = oy + Math.sin(ang) * R * 0.92;
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
    <div className="grid grid-cols-[minmax(190px,230px)_minmax(0,1fr)] items-start gap-4 px-6 pb-12">
      <Card className="sticky top-4 overflow-hidden">
        <div className="flex items-center gap-1.5 border-b border-divider px-3.5 py-2.5 text-xs font-semibold tracking-label text-muted uppercase">
          <LkIcon name="key" size={12} />
          Sign-in accounts · by Risk score
        </div>
        <div className="max-h-[calc(100vh-220px)] overflow-y-auto">
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
              className={cx(
                "flex w-full cursor-pointer items-center gap-2 border-t border-divider px-3.5 py-2 text-left first:border-t-0",
                i.id === sel.id ? "bg-brand-soft shadow-[inset_3px_0_0_var(--color-brand)]" : "bg-surface hover:bg-canvas",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{i.email}</span>
                <span className="block text-2xs text-muted">
                  {i.provider} · {direct} linked services
                </span>
              </span>
              <span className={cx("text-[13px] font-semibold", riskClass(i))}>{nf(s)}</span>
            </button>
          ))}
        </div>
      </Card>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-divider px-3.5 py-2.5">
          {KINDS.map((k) => (
            <Chip key={k} label={k} on={!!kinds[k]} onFlip={() => setKinds({ ...kinds, [k]: !kinds[k] })} />
          ))}
          <span className="flex-1" />
          <Chip label="Only way in" on={sole} onFlip={() => setSole(!sole)} />
        </div>
        <div className="relative">
          <svg viewBox="0 0 760 560" className="block h-auto w-full bg-page" role="img" aria-label={`What relies on ${sel.email}`}>
            {nodes.map((n) => (
              <line key={`l${n.x.id}`} x1={ox} y1={oy} x2={n.px.toFixed(1)} y2={n.py.toFixed(1)} stroke={n.e.sole ? T("danger") : T("muted")} strokeWidth={n.on && node ? 2.5 : 1.2} strokeDasharray={n.e.kind === "Recovery email" ? "4 4" : n.e.kind === "Billing owner" ? "1 4" : undefined} opacity={n.on ? 0.9 : 0.15} />
            ))}
            {nodes.map((n) => (
              <circle
                key={`c${n.x.id}`}
                onClick={() => setNode(node === n.x.id ? null : n.x.id)}
                className="cursor-pointer"
                opacity={n.on ? 1 : 0.25}
                cx={n.px.toFixed(1)}
                cy={n.py.toFixed(1)}
                r={n.x.tier === "restricted" ? 12 : n.x.tier === "sensitive" ? 10 : 8}
                fill={n.hot ? T("danger-soft") : n.e.sole ? T("warn-soft") : T("canvas")}
                stroke={n.hot ? T("danger") : n.e.sole ? T("warn") : T("muted")}
                strokeWidth={node === n.x.id ? 3 : 1.5}
              />
            ))}
            <circle onClick={() => setNode(null)} className="cursor-pointer" cx={ox} cy={oy} r={34} fill={!sel.controlled ? T("danger") : !sel.mfa ? T("warn") : T("ink")} stroke={T("surface")} strokeWidth={3} />
          </svg>
          {[
            ...nodes.map((n) => ({ key: n.x.id, x: n.px, ty: n.py + (n.py > oy ? 28 : -20), l: label(n.x.title), l2: n.e.sole ? "only way in" : "", red2: true, o: n.on ? 1 : 0.25, main: false, go: () => setNode(node === n.x.id ? null : n.x.id) })),
            { key: "root", x: ox, ty: oy + 58, l: sel.email.length > 26 ? sel.email.slice(0, 24) + "…" : sel.email, l2: `${deps.length} linked services · 2-step sign-in ${sel.mfa ? "on" : "off"}`, red2: !sel.controlled, o: 1, main: true, go: () => setNode(null) },
          ].map((t) => {
            const below = t.ty > (t.main ? oy : 0) || t.main;
            return (
              <button
                key={t.key}
                type="button"
                onClick={t.go}
                className="absolute flex max-w-[150px] cursor-pointer flex-col items-center gap-px rounded-[3px] bg-page/85 px-1 py-px whitespace-nowrap"
                style={{ left: `${(t.x / 760) * 100}%`, top: `${(t.ty / 560) * 100}%`, transform: `translate(-50%,${below ? "-30%" : "-70%"})`, opacity: t.o }}
              >
                <span className={cx("block max-w-[146px] truncate leading-[15px] text-ink", t.main ? "text-[13px] font-semibold" : "text-xs font-medium")}>{t.l}</span>
                {t.l2 ? <span className={cx("text-2xs leading-[13px] font-medium", t.red2 ? "text-danger" : "text-body")}>{t.l2}</span> : null}
              </button>
            );
          })}
          {!shown.length ? <div className="absolute top-[62%] right-0 left-0 text-center text-[13px] text-muted">Nothing recorded relies on this account{sole ? " as its only way in" : ""}.</div> : null}
        </div>
        <div className="flex flex-wrap gap-4 border-t border-divider px-3.5 py-2.5 text-xs text-body">
          {(
            [
              ["Personal or no-2-step sign-in account", "bg-danger"],
              ["Only way in, sensitive or above", "bg-danger-soft"],
              ["Only way in", "bg-warn-soft"],
              ["Has another way in", "bg-canvas"],
            ] as const
          ).map(([l, col]) => (
            <span key={l} className="flex items-center gap-1.5">
              <span className={cx("h-2.5 w-2.5 rounded-full border border-muted", col)} />
              {l}
            </span>
          ))}
          {E.length > shown.length ? <span>+{E.length - shown.length} more not drawn — see the risk list</span> : null}
        </div>
      </Card>
      <div className="col-start-2">
        <CardGrid min={280} className="items-start">
          <div className="flex flex-col gap-3">
            <Card className="overflow-hidden">
              <div className="border-b border-divider px-4 py-3">
                <div className="text-[15px] font-semibold break-all text-ink">{sel.email}</div>
                <div className="text-xs text-muted">
                  {sel.provider} · {sel.kind}
                </div>
              </div>
              {facts.map(([l, v, bad]) => (
                <div key={l} className="flex justify-between gap-2.5 border-t border-divider px-4 py-2 text-[13px] first:border-t-0">
                  <span className="text-muted">{l}</span>
                  <span className={cx("font-semibold", bad ? "text-danger" : "text-ink")}>{v}</span>
                </div>
              ))}
            </Card>
            <Button variant="primary" className="h-10" onClick={() => setWi(!wi)}>
              What if we lose this?
            </Button>
          </div>
          {wi ? (
            <Card className="overflow-hidden">
              <div className="flex items-center gap-1.5 border-b border-divider px-4 py-3 text-xs font-semibold tracking-label text-info uppercase">
                <LkIcon name="share" size={12} />
                What breaks · explained
              </div>
              <div className="px-4 py-3 text-sm leading-[21px] text-pretty text-ink">{narrate(blast)}</div>
              {blast.affected.slice(0, 12).map((a) => (
                <button
                  key={a.cred.id}
                  type="button"
                  onClick={() => router.push(`/locker/vault/${a.cred.id}`)}
                  className="flex w-full cursor-pointer items-center gap-2 border-t border-divider bg-surface px-4 py-2 text-left hover:bg-canvas"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{a.cred.title}</span>
                    <span className="block text-2xs text-muted">
                      {a.kind}
                      {a.depth > 1 ? ` · through ${a.via}` : ""} · recovery {a.sole ? `needs ${a.cred.provider || "the provider"}'s support, days to weeks` : "via another admin, hours"}
                    </span>
                  </span>
                  {a.sole ? <Pill label="No other path" tone="danger" /> : <Pill label="Can be recovered" tone="success" />}
                </button>
              ))}
              {blast.affected.length > 12 ? <div className="px-4 py-2 text-xs text-muted">and {blast.affected.length - 12} more in the backup plan</div> : null}
              <div className="border-t border-divider px-4 py-2.5">
                <Button
                  size="sm"
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
                >
                  Export as a backup plan
                </Button>
              </div>
            </Card>
          ) : null}
        </CardGrid>
      </div>
    </div>
  );
}
