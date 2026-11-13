"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CredRow } from "@/lib/locker/vault-service";
import { AUTH_LABEL } from "@/lib/locker/catalogue";
import { TIER } from "@/lib/locker/engine";
import { C, Chip, Picker, SearchBox, TierPill, fds, nf, useDensity, usePager } from "../_ui/kit";

type Sort = "tier" | "title" | "user" | "auth" | "rot" | "rev" | "owner";
const TIER_ORD = { restricted: 0, sensitive: 1, standard: 2 } as const;

export function VaultList({ rows: base }: { rows: CredRow[] }) {
  const router = useRouter();
  const compact = useDensity() === "compact";
  const [q, setQ] = useState("");
  const [f, setF] = useState<{ tier?: string; kind?: string; prov?: string; env?: string; auth?: string; rot?: boolean; never?: boolean; reuse?: boolean; nomfa?: boolean }>({});
  const [sort, setSort] = useState<[Sort, 1 | -1]>(["rot", -1]);
  const set = (k: keyof typeof f, v: string | boolean | undefined) => setF({ ...f, [k]: v || undefined });
  const needle = q.trim().toLowerCase();
  const rows = base.filter(
    (x) =>
      (!f.tier || x.tier === f.tier) &&
      (!f.kind || x.kind === f.kind) &&
      (!f.prov || x.provider === f.prov) &&
      (!f.env || x.env === f.env) &&
      (!f.auth || (f.auth === "direct" ? !x.via : x.via?.id === f.auth)) &&
      (!f.rot || x.changeDue) &&
      (!f.never || !x.lastRevealedAt) &&
      (!f.reuse || x.reuseCount > 0) &&
      (!f.nomfa || !x.mfa) &&
      (!needle || `${x.title} ${x.username} ${x.url} ${x.provider}`.toLowerCase().includes(needle)),
  );
  const count = (fn: (x: CredRow) => string) => {
    const m = new Map<string, number>();
    for (const x of base) m.set(fn(x), (m.get(fn(x)) ?? 0) + 1);
    return m;
  };
  const pc = count((x) => x.provider || "—");
  const tc = count((x) => x.kind);
  const ac = count((x) => x.via?.id ?? "direct");
  const viaEmail = new Map(base.filter((x) => x.via).map((x) => [x.via!.id, x.via!.email]));
  const key: Record<Sort, (x: CredRow) => string | number> = {
    tier: (x) => TIER_ORD[x.tier],
    title: (x) => x.title.toLowerCase(),
    user: (x) => x.username.toLowerCase(),
    auth: (x) => x.via?.email ?? "",
    rot: (x) => (x.ageDays ?? 99999) - x.policyDays,
    rev: (x) => x.lastRevealedAt ?? "",
    owner: (x) => x.ownerName ?? "",
  };
  const [sk, sd] = sort;
  const sorted = rows.slice().sort((a, b) => {
    const A = key[sk](a);
    const B = key[sk](b);
    return (A > B ? 1 : A < B ? -1 : 0) * sd;
  });
  const P = usePager(sorted.length);
  const tpl = "minmax(0,0.85fr) minmax(0,2.4fr) minmax(0,1.4fr) minmax(0,1.4fr) minmax(0,0.85fr) minmax(0,1fr) minmax(0,1fr)";
  const hasF = Object.values(f).some(Boolean) || !!needle;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <SearchBox value={q} onChange={(v) => { setQ(v); P.reset(); }} placeholder="Title, username or URL" />
        <Picker k="Level" label={f.tier ? TIER[f.tier as keyof typeof TIER].label : "All"} value={f.tier ?? ""} options={[{ v: "", l: "All tiers" }, ...(["restricted", "sensitive", "standard"] as const).map((k) => ({ v: k, l: TIER[k].label, m: nf(base.filter((x) => x.tier === k).length) }))]} onPick={(v) => set("tier", v)} />
        <Picker k="Type" label={f.kind || "All"} value={f.kind ?? ""} options={[{ v: "", l: "All types" }, ...[...tc.keys()].sort().map((k) => ({ v: k, l: k, m: nf(tc.get(k)!) }))]} onPick={(v) => set("kind", v)} />
        <Picker k="Provider" label={f.prov || "All"} value={f.prov ?? ""} ph={`Search ${pc.size} providers`} options={[{ v: "", l: "All providers" }, ...[...pc.keys()].sort((a, b) => pc.get(b)! - pc.get(a)!).map((k) => ({ v: k, l: k, m: nf(pc.get(k)!) }))]} onPick={(v) => set("prov", v)} />
        <Picker k="Environment" label={f.env || "All"} value={f.env ?? ""} options={[{ v: "", l: "All" }, ...["Production", "Staging", "Development", "Shared"].map((k) => ({ v: k, l: k }))]} onPick={(v) => set("env", v)} />
        <Picker
          k="Auth"
          label={f.auth ? (f.auth === "direct" ? "Direct" : `via ${viaEmail.get(f.auth) ?? ""}`) : "All"}
          value={f.auth ?? ""}
          ph="Search sign-in accounts"
          options={[{ v: "", l: "Any method" }, { v: "direct", l: "Direct login", m: nf(ac.get("direct") ?? 0) }, ...[...ac.keys()].filter((k) => k !== "direct").sort((a, b) => ac.get(b)! - ac.get(a)!).map((k) => ({ v: k, l: `via ${viaEmail.get(k) ?? k}`, m: nf(ac.get(k)!) }))]}
          onPick={(v) => set("auth", v)}
        />
        {(
          [
            ["rot", "Change overdue"],
            ["never", "Never revealed"],
            ["reuse", "Reuse detected"],
            ["nomfa", "2-step sign-in missing"],
          ] as const
        ).map(([k, l]) => (
          <Chip key={k} vault label={l} on={!!f[k]} onFlip={() => set(k, !f[k])} />
        ))}
        {hasF ? (
          <button type="button" onClick={() => { setF({}); setQ(""); }} style={{ height: 34, padding: "0 10px", border: "none", background: "transparent", color: C.brandInk, fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
            Clear all
          </button>
        ) : null}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: C.muted }}>
          {nf(rows.length)} of {nf(base.length)} logins
        </span>
      </div>
      {!rows.length ? (
        <div style={{ background: "#FFFFFF", border: `1px solid ${C.v100}`, borderRadius: 6, padding: "48px 24px", textAlign: "center", fontSize: 15, color: C.muted }}>
          {base.length ? "No logins match these filters." : "No logins are recorded yet. Add one to start tracking who can get in."}
        </div>
      ) : (
        <div style={{ background: "#FFFFFF", border: `1px solid ${C.v100}`, borderRadius: 6, overflow: "hidden", boxShadow: `inset 3px 0 0 ${C.v700}` }}>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 900 }}>
              <div style={{ display: "grid", gridTemplateColumns: tpl, gap: 12, alignItems: "center", padding: "0 16px 0 19px", height: 36, background: C.v50, borderBottom: `1px solid ${C.v100}` }}>
                {(
                  [
                    ["tier", "Level"],
                    ["title", "Login"],
                    ["user", "Account"],
                    ["auth", "Auth method"],
                    ["rot", "Changed"],
                    ["rev", "Last revealed"],
                    ["owner", "Owner"],
                  ] as [Sort, string][]
                ).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setSort([k, sk === k ? (-sd as 1 | -1) : 1])} style={{ border: "none", background: "transparent", padding: 0, fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: sk === k ? C.v900 : C.v500, cursor: "pointer", textAlign: "left", whiteSpace: "nowrap" }}>
                    {l}
                    {sk === k ? (sd > 0 ? " ↑" : " ↓") : ""}
                  </button>
                ))}
              </div>
              {P.slice(sorted).map((x, i) => (
                <div
                  key={x.id}
                  className="lk-row"
                  onClick={() => router.push(`/locker/vault/${x.id}`)}
                  style={{ display: "grid", gridTemplateColumns: tpl, gap: 12, alignItems: "center", padding: "0 16px", minHeight: compact ? 40 : 48, borderTop: `1px solid ${C.v50}`, background: i % 2 ? C.canvas : "#FFFFFF", cursor: "pointer", fontSize: 14, color: C.body }}
                >
                  <span style={{ minWidth: 0, overflow: "hidden" }}>
                    <TierPill tier={x.tier} />
                  </span>
                  <span style={{ minWidth: 0, padding: "6px 0" }}>
                    <span style={{ display: "block", fontWeight: 500, color: C.v900, lineHeight: "19px", overflowWrap: "anywhere" }}>{x.title}</span>
                    <span style={{ display: "block", fontSize: 12, lineHeight: "16px", color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {x.kind} · {x.provider || "—"}
                    </span>
                    {x.flags.length ? <span style={{ display: "block", fontSize: 12, lineHeight: "16px", color: C.red }}>{x.flags.join(" · ")}</span> : null}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.via ? x.via.email : x.username || "—"}</span>
                    <span style={{ display: "block", fontSize: 12, lineHeight: "16px", color: C.muted }}>{x.env}</span>
                  </span>
                  <span style={{ minWidth: 0, fontSize: 13, lineHeight: "18px", color: x.via ? (x.via.controlled ? C.v700 : C.red) : C.body, fontWeight: x.via ? 500 : 400, overflowWrap: "anywhere" }}>
                    {x.via ? `via ${x.via.email}` : (AUTH_LABEL[x.auth] ?? "Direct")}
                  </span>
                  <span style={{ minWidth: 0, fontSize: 13, color: x.changeDue ? C.red : C.body, fontWeight: x.changeDue ? 600 : 400, whiteSpace: "nowrap" }}>
                    {x.ageDays == null ? "Never" : `${x.ageDays}d`} / {x.policyDays}
                  </span>
                  <span style={{ minWidth: 0, fontSize: 13, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.lastRevealedAt ? `${fds(x.lastRevealedAt)} · ${(x.lastRevealedBy ?? "").split(" ")[0]}` : "Never"}</span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: x.ownerName ? C.body : C.red }}>{x.ownerName ?? "No owner"}</span>
                </div>
              ))}
            </div>
          </div>
          {P.footer}
        </div>
      )}
    </>
  );
}
