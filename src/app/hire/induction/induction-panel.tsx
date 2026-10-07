"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { setItemAction } from "@/lib/hire/actions/onboarding";
import type { CheckGroup, CheckItem } from "../_onboard/checks";
import { Icon, Pill, fd } from "../_ui/kit";

export function InductionPanel({ applicationId, kit, modules, editable, locked }: { applicationId: string; kit: CheckGroup; modules: CheckGroup[]; editable: boolean; locked: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [serials, setSerials] = useState<Record<string, string>>(() => Object.fromEntries(kit.items.map((i) => [i.item, i.serial ?? ""])));
  const flip = (i: CheckItem, serial?: string) =>
    start(async () => {
      const r = await setItemAction(applicationId, { kind: i.kind, group: i.group, item: i.item }, !i.done, serial ?? null);
      if (!r.ok) toast.push(r.error, "error");
      router.refresh();
    });
  const received = kit.items.filter((i) => i.done).length;

  return (
    <div className="flex flex-col gap-4">
      {locked ? <div className="text-[13px] text-muted">{locked} You can see the checklist but not tick it.</div> : null}
      <section className="rounded-[6px] border border-line bg-surface">
        <header className="flex items-center justify-between border-b border-divider px-5 py-3">
          <span className="text-[15px] font-semibold text-heading">Work kit</span>
          <span className="text-[13px] text-muted tabular-nums">
            {received} of {kit.items.length} received
          </span>
        </header>
        {kit.items.map((i) => (
          <div key={i.item} className="hire-row grid grid-cols-[24px_minmax(0,1fr)_200px_auto] items-center gap-3 border-t border-divider px-5 first:border-t-0">
            <input type="checkbox" checked={i.done} disabled={!editable || pending} onChange={() => flip(i, serials[i.item])} className="h-4 w-4 accent-[var(--color-brand)]" aria-label={i.label} />
            <span className="text-sm text-heading">{i.label}</span>
            {i.needsSerial ? (
              <input
                value={serials[i.item] ?? ""}
                disabled={!editable || i.done}
                onChange={(e) => setSerials((s) => ({ ...s, [i.item]: e.target.value }))}
                placeholder="Serial number — required"
                className="h-8 rounded-[4px] border border-line-strong px-2.5 text-[13px] outline-none focus:border-brand disabled:bg-page"
              />
            ) : (
              <span />
            )}
            <span title={i.by ? `${i.by} · ${fd(i.at)}` : undefined}>
              <Pill tone={i.done ? "success" : "warn"}>{i.done ? "Received" : "Pending"}</Pill>
            </span>
          </div>
        ))}
      </section>

      {modules.map((m) => {
        const ticked = m.items.filter((t) => t.done).length;
        const complete = ticked === m.items.length;
        return (
          <section key={m.key} className="rounded-[6px] border border-line bg-surface">
            <header className="flex items-center justify-between gap-3 border-b border-divider px-5 py-3">
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold text-heading">{m.label}</span>
                <span className="block text-[13px] text-muted tabular-nums">
                  {ticked} of {m.items.length} topics taught
                </span>
              </span>
              {/* Turns green ONLY when every topic is ticked — partial is not complete (spec §7.1). */}
              <span
                title={complete ? "Every topic is ticked" : `${m.items.length - ticked} topic${m.items.length - ticked === 1 ? "" : "s"} still to teach`}
                className={cx(
                  "inline-flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[13px] font-medium",
                  complete ? "border-transparent bg-success text-white" : "border-divider bg-page text-faint",
                )}
              >
                {complete ? <Icon n="check" s={14} /> : null}
                {complete ? "Module complete" : "Module incomplete"}
              </span>
            </header>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 px-5 py-3">
              {m.items.map((t) => (
                <label key={t.item} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm text-body" title={t.by ? `Taught · ticked by ${t.by}, ${fd(t.at)}` : undefined}>
                  <input type="checkbox" checked={t.done} disabled={!editable || pending} onChange={() => flip(t)} className="h-4 w-4 accent-[var(--color-brand)]" />
                  {t.label}
                </label>
              ))}
            </div>
          </section>
        );
      })}
      <div className="text-[13px] text-muted">Hire records that a topic was taught. The Training Portal records that it was learned — quizzes and assessments happen there after provisioning.</div>
    </div>
  );
}
