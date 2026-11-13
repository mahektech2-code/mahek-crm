"use client";

import { useState } from "react";
import type { Tier } from "@/lib/locker/engine";
import { C, TierPill, fd, inr, nf } from "../../_ui/kit";
import { BarCell, Block, Cell, GTable } from "../../_ui/vault-parts";

type P = {
  name: string;
  accounts: number;
  spendPaise: number;
  mfaPct: number | null;
  owners: string[];
  creds: { id: string; title: string; account: string; tier: Tier; env: string; owner: string }[];
  assets: { id: string; title: string; code: string; renews: string; date: string | null; amountPaise: number; cycle: string; owner: string }[];
};

export function ProvidersScreen({ list }: { list: P[] }) {
  const [selName, setSel] = useState<string | null>(null);
  const sel = list.find((p) => p.name === selName) ?? list.find((p) => /DigitalOcean/i.test(p.name)) ?? list[0];
  return (
    <div style={{ padding: "0 24px 48px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
      <Block vault title="Providers" sub={`${nf(list.length)} providers · click one to expand`}>
        <GTable
          vault
          emptyLine="No providers yet — they appear as logins and subscriptions are recorded."
          cols={[
            ["Provider", "minmax(200px,1.5fr)"],
            ["Accounts", "90px"],
            ["Passwords & keys", "100px"],
            ["Assets", "80px"],
            ["Annual spend", "130px"],
            ["2-step sign-in coverage", "140px"],
            ["Owners", "minmax(160px,1fr)"],
          ]}
          rows={list.map((p) => ({
            key: p.name,
            edge: p === sel ? C.v700 : null,
            bg: p === sel ? C.v50 : null,
            onClick: () => setSel(p.name),
            cells: [
              <Cell key="a" t={p.name} style={{ fontWeight: 500, color: C.v900 }} />,
              <Cell key="b" t={nf(p.accounts)} />,
              <Cell key="c" t={nf(p.creds.length)} />,
              <Cell key="d" t={nf(p.assets.length)} />,
              <Cell key="e" t={p.spendPaise ? inr(p.spendPaise) : "—"} />,
              p.mfaPct == null ? <Cell key="f" t="—" /> : <BarCell key="f" t={`${p.mfaPct}%`} pct={p.mfaPct} col={p.mfaPct < 60 ? "#B77B08" : C.v500} />,
              <Cell key="g" t={p.owners.slice(0, 2).join(", ") || "—"} />,
            ],
          }))}
        />
      </Block>
      {sel ? (
        <>
          <Block vault title={`${sel.name} · accounts and logins`} sub={`${nf(sel.accounts)} distinct accounts · ${nf(sel.creds.length)} logins`}>
            <GTable
              vault
              emptyLine="No logins for this provider."
              cols={[
                ["Login", "minmax(240px,2fr)"],
                ["Account", "minmax(180px,1.4fr)"],
                ["Level", "100px"],
                ["Env", "100px"],
                ["Owner", "140px"],
              ]}
              rows={sel.creds.map((x) => ({ key: x.id, href: `/locker/vault/${x.id}`, cells: [<Cell key="a" t={x.title} style={{ color: C.v900, fontWeight: 500 }} />, <Cell key="b" t={x.account} style={{ fontSize: 13 }} />, <TierPill key="c" tier={x.tier} />, <Cell key="d" t={x.env} />, <Cell key="e" t={x.owner} />] }))}
            />
          </Block>
          <Block title={`${sel.name} · subscriptions and assets`} sub={`${inr(sel.spendPaise)} a year`}>
            <GTable
              emptyLine="No subscriptions recorded."
              cols={[
                ["Asset", "minmax(240px,2fr)"],
                ["Renews", "140px"],
                ["Amount", "140px"],
                ["Owner", "140px"],
              ]}
              rows={sel.assets.map((a) => ({ key: a.id, href: `/locker/assets/${a.id}`, cells: [<Cell key="a" t={a.title} sub={a.code} />, <Cell key="b" t={a.renews} sub={fd(a.date)} />, <Cell key="c" t={a.amountPaise ? `${inr(a.amountPaise)} / ${(a.cycle || "year").toLowerCase()}` : "—"} />, <Cell key="d" t={a.owner} />] }))}
            />
          </Block>
        </>
      ) : null}
    </div>
  );
}
