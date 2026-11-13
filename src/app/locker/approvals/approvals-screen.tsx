"use client";

import { useRouter } from "next/navigation";
import { decideBreakglass, decideReveal } from "@/lib/actions/locker-vault";
import type { Tier } from "@/lib/locker/engine";
import { C, Pill, nf, useModal, useToast } from "../_ui/kit";
import { Block, LList, type LItem } from "../_ui/vault-parts";

type Data = {
  approvalMinutes: number;
  reveals: { id: string; who: string; field: string; reason: string; credId: string; title: string; tier: string; leftMs: number; mine: boolean; previous: boolean }[];
  mine: { id: string; state: string; field: string; credId: string; title: string; decidedBy: string | null }[];
  breakglass: { id: string; by: string; mine: boolean; reason: string; items: number }[];
};

export function ApprovalsScreen({ data }: { data: Data }) {
  const router = useRouter();
  const modal = useModal();
  const toast = useToast();
  const mins = (ms: number) => `${Math.max(0, Math.ceil(ms / 60000))} min`;
  const items: LItem[] = [
    ...data.breakglass.map((b) => ({
      key: `bg${b.id}`,
      t: `Emergency access · ${b.by}`,
      sub: `${b.items} items · “${b.reason}”`,
      badge: <Pill label="Emergency access" tone="danger" />,
      edge: C.red,
      btn: b.mine ? "Yours — waiting" : "Approve",
      btnKind: "d" as const,
      off: b.mine,
      why: "The person who started it cannot approve it",
      run: async () => {
        const r = await decideBreakglass(b.id, true);
        toast(r.ok ? "Emergency access is active — everybody has been told" : r.error);
        router.refresh();
      },
      extra: b.mine ? null : (
        <button
          type="button"
          onClick={async () => {
            const r = await decideBreakglass(b.id, false);
            toast(r.ok ? "Declined" : r.error);
            router.refresh();
          }}
          className="mt-1.5 cursor-pointer p-0 text-[13px] font-medium text-danger hover:underline"
        >
          Decline
        </button>
      ),
    })),
    ...data.reveals.map((r) => ({
      key: r.id,
      t: `Reveal · ${r.title} · ${r.field}${r.previous ? " (previous value)" : ""}`,
      sub: `${r.who} · “${r.reason}” · lapses in ${mins(r.leftMs)}`,
      badge: <Pill label={r.mine ? "Your request" : (r.tier as Tier) === "restricted" ? "Restricted reveal" : "Reveal"} tone="brand" />,
      edge: C.ink,
      btn: r.mine ? "Waiting for someone else" : "Decide",
      btnKind: "v" as const,
      off: r.mine,
      why: "You cannot approve your own reveal",
      run: () =>
        modal({
          title: `Reveal of ${r.title}`,
          sub: `${r.who} asked to see ${r.field}: “${r.reason}”. Approving lets them reveal it once, within ${data.approvalMinutes} minutes, after confirming their password.`,
          vault: true,
          fields: [
            { k: "d", l: "Decision", type: "select", req: true, init: "approve", opts: [{ v: "approve", l: "Approve" }, { v: "decline", l: "Decline" }] },
            { k: "n", l: "Note to them", type: "area", hint: "Required when declining — they need to know what to do instead." },
          ],
          okL: "Record decision",
          done: async (v) => {
            const res = await decideReveal(r.id, v.d === "approve", v.n ?? "");
            if (!res.ok) return res.error;
            toast(v.d === "approve" ? `Approved · ${r.who} has been told` : "Declined");
            router.refresh();
          },
        }),
    })),
    ...data.mine
      .filter((m) => m.state === "approved")
      .map((m) => ({
        key: `m${m.id}`,
        t: `Your reveal is approved · ${m.title}`,
        sub: `Approved by ${m.decidedBy ?? "—"} · open the login and reveal ${m.field} before the approval lapses`,
        badge: <Pill label="Approved" tone="success" />,
        btn: "Open",
        btnKind: "v" as const,
        run: () => router.push(`/locker/vault/${m.credId}`),
      })),
  ];
  return (
    <div className="px-6 pb-12">
      <Block title="Waiting on you" sub={`${nf(items.length)} requests`}>
        <LList items={items} empty="Nothing is waiting for a decision." />
      </Block>
    </div>
  );
}
