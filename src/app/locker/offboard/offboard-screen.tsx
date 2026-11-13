"use client";

import { buttonClass } from "@/components/ui/primitives";
import { useRouter } from "next/navigation";
import { completeOffItem, signOffOffboarding, startOffboarding } from "@/lib/actions/locker-admin";
import type { OffItem } from "@/lib/locker/ops-core";
import type { Tier } from "@/lib/locker/engine";
import { Pill, Picker, TierPill, useModal, useToast } from "../_ui/kit";
import { Alert, Block, Cell, GTable, Grid, LList, Stats, when } from "../_ui/vault-parts";

type Case = { id: string; userId: string; name: string; by: string; startedAt: string; completedAt: string | null; items: OffItem[] };

export function OffboardScreen({ people, owners, cases, selId, revealed }: { people: { v: string; l: string }[]; owners: { v: string; l: string }[]; cases: Case[]; selId: string | null; revealed: { id: string; title: string; tier: string; at: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const modal = useModal();
  const sel = cases.find((c) => c.id === selId) ?? null;
  const start = async (userId: string) => {
    if (!userId) return;
    const r = await startOffboarding(userId);
    if (!r.ok) return toast(r.error);
    router.push(`/locker/offboard?id=${r.data.id}`);
    router.refresh();
  };
  const tick = async (idx: number, done: boolean, to: string | null = null) => {
    const r = await completeOffItem(sel!.id, idx, done, to);
    if (!r.ok) toast(r.error);
    router.refresh();
  };
  const picker = <Picker k="Offboard" label="Choose a person" value="" options={people} onPick={start} ph="Search people" />;
  if (!sel)
    return (
      <div className="flex flex-col gap-4 px-6 pb-12">
        <div>{picker}</div>
        {cases.length ? <CaseList cases={cases} /> : <Block title="No offboarding yet"><div className="p-5 text-sm text-muted">Choose the person who is leaving. The list is built from what the Locker records against them.</div></Block>}
      </div>
    );
  const items = sel.items.map((it, idx) => ({ it, idx }));
  const done = sel.items.filter((i) => i.done).length;
  const pct = sel.items.length ? Math.round((done / sel.items.length) * 100) : 100;
  const signed = !!sel.completedAt;
  const group = (kind: string) => items.filter((x) => x.it.kind === kind);
  const block = (title: string, sub: string, kind: string, wide = false) => {
    const list = group(kind);
    if (!list.length) return null;
    return (
      <Block key={kind} title={`${title} · ${list.filter((x) => !x.it.done).length} open`} sub={sub} wide={wide}>
        <LList
          items={list.map(({ it, idx }) => ({
            key: `${kind}${idx}`,
            t: it.title,
            sub: `${it.action}${it.to ? ` · to ${owners.find((o) => o.v === it.to)?.l ?? ""}` : ""}`,
            check: true,
            on: it.done,
            ro: signed,
            flip: () => {
              if (it.done) return tick(idx, false);
              if (kind === "asset")
                return modal({
                  title: `Reassign · ${it.title}`,
                  fields: [{ k: "p", l: "New owner", type: "select", req: true, opts: [{ v: "", l: "Choose a person" }, ...owners.filter((o) => o.v !== sel.userId)] }],
                  okL: "Reassign",
                  done: async (v) => {
                    const r = await completeOffItem(sel.id, idx, true, v.p);
                    if (!r.ok) return r.error;
                    router.refresh();
                  },
                });
              return tick(idx, true);
            },
            badge: it.done ? <Pill label="Done" tone="success" /> : undefined,
            btn: kind === "rotate" && !it.done ? "Open login" : kind === "asset" && !it.done ? "Open asset" : undefined,
            btnKind: "s" as const,
            run: () => router.push(kind === "rotate" ? `/locker/vault/${it.id}` : `/locker/assets/${it.id}`),
          }))}
        />
      </Block>
    );
  };
  const personal = group("identity").filter((x) => !x.it.done && /personal/.test(x.it.action));
  const cards = group("payment").filter((x) => !x.it.done);
  return (
    <div className="flex flex-col gap-5 px-6 pb-12">
      <div className="flex flex-wrap items-center gap-2">
        {picker}
        <span className="flex-1" />
        {signed ? (
          <Pill label={`Signed off ${when(sel.completedAt)}`} tone="success" />
        ) : (
          <button
            type="button"
            title={done < sel.items.length ? `Cannot be signed off with ${sel.items.length - done} open tasks` : ""}
            onClick={async () => {
              const r = await signOffOffboarding(sel.id);
              toast(r.ok ? "Offboarding signed off" : r.error);
              router.refresh();
            }}
            className={buttonClass({ variant: "primary" })}
            disabled={done < sel.items.length}
          >
            Sign off
          </button>
        )}
      </div>
      {personal.map(({ it }) => (
        <Alert key={it.id} tone="red" t={`CRITICAL · ${it.title} is a personal account holding company services`} m="Move every service off it to a company sign-in account before the last day — after it, access may be impossible to recover." />
      ))}
      {cards.map(({ it }) => (
        <Alert key={it.id} tone="red" t={`CRITICAL · subscriptions are paid on ${it.title}`} m="Move them to a company card before the card's holder leaves, or the next charge fails and the service lapses." />
      ))}
      <Alert tone="grey" t="Every login they could access is changed, not just removed" m="A rotate task is ticked only once a new value has been recorded on that login since this offboarding began." />
      <Stats
        items={[
          { l: "Complete", v: `${pct}%`, s: `${done} of ${sel.items.length} tasks · visible to management`, bar: pct },
          { l: "Owned assets", v: group("asset").length, s: "to reassign" },
          { l: "Passwords & keys", v: group("rotate").length, s: "to change" },
          { l: "Revealed in 90 days", v: revealed.length, s: "what they actually saw", red: revealed.length > 0 },
        ]}
      />
      <Grid cols={2}>
        {block("Owned assets", "Reassign each to a new primary or backup owner.", "asset")}
        {block("Passwords & keys", "Change every one — remove is not enough.", "rotate")}
        <Block vault title="Revealed in the last 90 days" sub="Flagged for the offboarding report">
          <GTable vault emptyLine="Nothing revealed in the last 90 days." cols={[["Login", "minmax(220px,2fr)"], ["Revealed", "140px"], ["Level", "100px"]]} rows={revealed.map((x, i) => ({ key: x.id + i, href: `/locker/vault/${x.id}`, cells: [<Cell key="a" t={x.title} className="text-ink" />, <Cell key="b" t={when(x.at)} />, <TierPill key="c" tier={x.tier as Tier} />] }))} />
        </Block>
        {block("Sign-in accounts and payment methods", "Transfer before the last day — after it, it may be impossible.", "identity")}
        {block("Payment methods", "Move every subscription off a card in their name.", "payment")}
        {block("Know-how to hand over", "What only they know how to do.", "playbook")}
      </Grid>
      {cases.length > 1 ? <CaseList cases={cases} /> : null}
    </div>
  );
}

function CaseList({ cases }: { cases: Case[] }) {
  return (
    <Block title="All offboardings">
      <GTable
        cols={[["Person", "minmax(200px,2fr)"], ["Started", "140px"], ["By", "150px"], ["Progress", "120px"], ["State", "120px"]]}
        rows={cases.map((c) => {
          const d = c.items.filter((i) => i.done).length;
          return { key: c.id, href: `/locker/offboard?id=${c.id}`, cells: [<Cell key="a" t={c.name} />, <Cell key="b" t={when(c.startedAt)} />, <Cell key="c" t={c.by} />, <Cell key="d" t={`${d} of ${c.items.length}`} />, c.completedAt ? <Pill key="e" label="Signed off" tone="success" /> : <Pill key="e" label="Open" tone="warn" />] };
        })}
      />
    </Block>
  );
}
