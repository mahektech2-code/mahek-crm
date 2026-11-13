"use client";

import { buttonClass } from "@/components/ui/primitives";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { decideReview, openReview, remindReviewer } from "@/lib/actions/locker-admin";
import { C, Pill, nf, useToast } from "../_ui/kit";
import { BarCell, Block, Cell, GTable, LList, Stats } from "../_ui/vault-parts";

type Item = { id: string; userId: string; name: string; moduleKey: string; decision: string | null; decidedBy: string | null };

export function ReviewScreen({ period, me, labels, items }: { period: string; me: string; labels: Record<string, string>; items: Item[] }) {
  const router = useRouter();
  const toast = useToast();
  const [sel, setSel] = useState<string | null>(null);
  if (!items.length)
    return (
      <div className="px-6 pb-12">
        <Block title={`The ${period} review has not been opened`}>
          <div className="flex items-center gap-3 px-5 py-4">
            <span className="flex-1 text-sm text-body">Opening it lists every person holding the Locker and each part of it they hold, as it stands today.</span>
            <button
              type="button"
              onClick={async () => {
                const r = await openReview(period);
                toast(r.ok ? `${r.data.rows} grants to review` : r.error);
                router.refresh();
              }}
              className={buttonClass({ variant: "primary" })}
            >
              Open the review
            </button>
          </div>
        </Block>
      </div>
    );
  const people = [...new Set(items.map((i) => i.userId))].map((u) => {
    const mine = items.filter((i) => i.userId === u);
    return { userId: u, name: mine[0].name, total: mine.length, done: mine.filter((i) => i.decision).length, removed: mine.filter((i) => i.decision === "remove").length };
  });
  const tot = items.length;
  const dn = items.filter((i) => i.decision).length;
  const pct = tot ? Math.round((dn / tot) * 100) : 0;
  const cur = people.find((p) => p.userId === sel) ?? people.find((p) => p.done < p.total) ?? people[0];
  return (
    <div className="flex flex-col gap-5 px-6 pb-12">
      <Stats
        items={[
          { l: "Confirmed", v: `${pct}%`, s: `${nf(dn)} of ${nf(tot)} grants`, bar: pct },
          { l: "People", v: people.length, s: "holding the Locker" },
          { l: "Not started", v: people.filter((p) => !p.done).length, s: "people", red: people.some((p) => !p.done) },
          { l: "Removed so far", v: items.filter((i) => i.decision === "remove").length, s: "grants taken away" },
        ]}
      />
      <Block title="By person" sub="Click a person to confirm or remove each grant. Nudge anybody not started.">
        <GTable
          cols={[["Person", "minmax(200px,1.5fr)"], ["Grants", "90px"], ["Progress", "minmax(180px,1.4fr)"], ["", "140px"]]}
          rows={people.map((p) => ({
            key: p.userId,
            edge: !p.done ? "var(--color-warn)" : cur?.userId === p.userId ? C.brand : null,
            onClick: () => setSel(p.userId),
            cells: [
              <Cell key="a" t={p.name} sub={p.removed ? `${p.removed} removed` : undefined} />,
              <Cell key="b" t={p.total} />,
              <BarCell key="c" t={`${p.done} of ${p.total}`} pct={(p.done / p.total) * 100} col={p.done === p.total ? "var(--color-success)" : C.brand} />,
              p.done === p.total ? (
                <Pill key="d" label="Complete" tone="success" />
              ) : p.userId === me ? (
                <span key="d" className="text-xs text-muted">Your own — review below</span>
              ) : (
                <button
                  key="d"
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const r = await remindReviewer(p.userId, period);
                    toast(r.ok ? `Reminder sent to ${p.name}` : r.error);
                  }}
                  className={buttonClass({ variant: "secondary", size: "sm" })}
                >
                  Send reminder
                </button>
              ),
            ],
          }))}
        />
      </Block>
      {cur ? (
        <Block title={`${cur.name} · ${cur.total} grants`} sub="Keep what they still need. Remove takes it away now and is recorded.">
          <LList
            items={items
              .filter((i) => i.userId === cur.userId)
              .map((i) => ({
                key: i.id,
                t: labels[i.moduleKey] ?? i.moduleKey,
                sub: i.decision ? `${i.decision === "keep" ? "Kept" : "Removed"} by ${i.decidedBy ?? ""}` : "Not reviewed yet",
                badge: i.decision === "keep" ? <Pill label="Kept" tone="success" /> : i.decision === "remove" ? <Pill label="Removed" tone="danger" /> : undefined,
                extra: i.decision ? null : (
                  <span className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const r = await decideReview(i.id, "keep");
                        if (!r.ok) toast(r.error);
                        router.refresh();
                      }}
                      className={buttonClass({ variant: "secondary", size: "sm" })}
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const r = await decideReview(i.id, "remove");
                        toast(r.ok ? "Removed — they no longer hold it" : r.error);
                        router.refresh();
                      }}
                      className={buttonClass({ variant: "danger", size: "sm" })}
                    >
                      Remove
                    </button>
                  </span>
                ),
              }))}
          />
        </Block>
      ) : null}
    </div>
  );
}
