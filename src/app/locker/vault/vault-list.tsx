"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CredRow } from "@/lib/locker/vault-service";
import { AUTH_LABEL } from "@/lib/locker/catalogue";
import { TIER } from "@/lib/locker/engine";
import { Card, EmptyState, SortableTh, Td, Tr, cx } from "@/components/ui/primitives";
import { Chip, Picker, SearchBox, TierPill, fds, nf, useDensity, usePager } from "../_ui/kit";

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
  const hasF = Object.values(f).some(Boolean) || !!needle;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
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
          <Chip key={k} label={l} on={!!f[k]} onFlip={() => set(k, !f[k])} />
        ))}
        {hasF ? (
          <button type="button" onClick={() => { setF({}); setQ(""); }} className="h-8 cursor-pointer px-2.5 text-[13px] font-medium text-brand-hover hover:underline">
            Clear all
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {nf(rows.length)} of {nf(base.length)} logins
        </span>
      </div>
      {!rows.length ? (
        <Card>
          <EmptyState title={base.length ? "No logins match these filters." : "No logins are recorded yet. Add one to start tracking who can get in."} />
        </Card>
      ) : (
        <Card className="overflow-hidden shadow-[inset_3px_0_0_var(--color-ink)]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] table-fixed border-collapse">
              <colgroup>
                {[8.5, 24, 14, 14, 8.5, 10, 10].map((w, k) => (
                  <col key={k} style={{ width: `${w}%` }} />
                ))}
              </colgroup>
              <thead>
                <tr>
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
                    <SortableTh key={k} active={sk === k} direction={sd > 0 ? "asc" : "desc"} onSort={() => setSort([k, sk === k ? (-sd as 1 | -1) : 1])}>
                      {l}
                    </SortableTh>
                  ))}
                </tr>
              </thead>
              <tbody>
                {P.slice(sorted).map((x) => (
                  <Tr key={x.id} onClick={() => router.push(`/locker/vault/${x.id}`)} className="cursor-pointer hover:bg-canvas">
                    <Td className={cx(compact ? "py-1.5" : "py-2")}>
                      <TierPill tier={x.tier} />
                    </Td>
                    <Td className="py-1.5 whitespace-normal">
                      <span className="block leading-[19px] font-medium [overflow-wrap:anywhere] text-ink">{x.title}</span>
                      <span className="block truncate text-xs leading-4 text-muted">
                        {x.kind} · {x.provider || "—"}
                      </span>
                      {x.flags.length ? <span className="block text-xs leading-4 text-danger">{x.flags.join(" · ")}</span> : null}
                    </Td>
                    <Td className="whitespace-normal">
                      <span className="block truncate font-mono text-xs">{x.via ? x.via.email : x.username || "—"}</span>
                      <span className="block text-xs leading-4 text-muted">{x.env}</span>
                    </Td>
                    <Td className={cx("text-[13px] leading-[18px] [overflow-wrap:anywhere] whitespace-normal", x.via ? (x.via.controlled ? "font-medium text-ink" : "font-medium text-danger") : "text-body")}>
                      {x.via ? `via ${x.via.email}` : (AUTH_LABEL[x.auth] ?? "Direct")}
                    </Td>
                    <Td className={cx("text-[13px]", x.changeDue ? "font-semibold text-danger" : "text-body")}>
                      {x.ageDays == null ? "Never" : `${x.ageDays}d`} / {x.policyDays}
                    </Td>
                    <Td className="truncate text-[13px] text-muted">{x.lastRevealedAt ? `${fds(x.lastRevealedAt)} · ${(x.lastRevealedBy ?? "").split(" ")[0]}` : "Never"}</Td>
                    <Td className={cx("truncate", x.ownerName ? "text-body" : "text-danger")}>{x.ownerName ?? "No owner"}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
          {P.footer}
        </Card>
      )}
    </>
  );
}
