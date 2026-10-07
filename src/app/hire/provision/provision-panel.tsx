"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { provisionAction, setItemAction } from "@/lib/hire/actions/onboarding";
import type { CheckGroup, CheckItem } from "../_onboard/checks";
import { Btn, BtnLink, Callout, Label, Locked, Pill, fd } from "../_ui/kit";

export function ProvisionPanel({
  applicationId,
  groups,
  editable,
  what,
  blockers,
  canProvision,
  lockedProvision,
  lockedOnboard,
}: {
  applicationId: string;
  groups: CheckGroup[];
  editable: boolean;
  what: [string, string][];
  blockers: string[];
  canProvision: boolean;
  lockedProvision: string;
  lockedOnboard: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [ask, setAsk] = useState(false);
  const [note, setNote] = useState("");
  const flip = (i: CheckItem) =>
    start(async () => {
      const r = await setItemAction(applicationId, { kind: i.kind, group: i.group, item: i.item }, !i.done);
      if (!r.ok) toast.push(r.error, "error");
      router.refresh();
    });
  const go = () =>
    start(async () => {
      const r = await provisionAction(applicationId, note);
      setAsk(false);
      if (!r.ok) return toast.push(r.error, "error");
      toast.push(r.message ?? "Provisioned.");
      router.refresh();
    });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-4">
      <section className="rounded-[6px] border border-line bg-surface">
        <header className="border-b border-divider px-5 py-3 text-[15px] font-semibold text-heading">Field setup</header>
        {lockedOnboard ? <div className="px-5 pt-3 text-[13px] text-muted">{lockedOnboard}</div> : null}
        {groups.map((g) => {
          const done = g.items.filter((i) => i.done).length;
          return (
            <div key={g.key} className="border-t border-divider px-5 py-3 first:border-t-0">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium text-heading">{g.label}</span>
                <Pill tone={done === g.items.length ? "success" : "warn"}>{done === g.items.length ? "Done" : `${done} of ${g.items.length}`}</Pill>
              </div>
              {g.items.map((i) => (
                <label key={i.item} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm text-body" title={i.by ? `${i.by}, ${fd(i.at)}` : undefined}>
                  <input type="checkbox" checked={i.done} disabled={!editable || pending} onChange={() => flip(i)} className="h-4 w-4 accent-[var(--color-brand)]" />
                  {i.label}
                </label>
              ))}
            </div>
          );
        })}
      </section>

      <section className="rounded-[6px] border border-line bg-surface p-5">
        <div className="mb-3 text-[18px] leading-6 font-semibold text-heading">Provision MahekOne account</div>
        <div className="mb-4 flex flex-col gap-2">
          {what.map(([l, v]) => (
            <div key={l} className="grid grid-cols-[130px_minmax(0,1fr)] gap-2.5 text-[13px] leading-[19px]">
              <span className="text-muted">{l}</span>
              <span className="font-medium text-heading">{v}</span>
            </div>
          ))}
        </div>
        {blockers.length ? (
          <div className="mb-4 flex flex-col gap-2">
            {blockers.map((b) => (
              <Callout key={b} tone="warn">
                {b}
              </Callout>
            ))}
          </div>
        ) : null}
        {canProvision ? (
          <Btn kind="primary" disabled={pending || blockers.length > 0} title={blockers[0]} onClick={() => setAsk(true)}>
            Provision account and mark hired
          </Btn>
        ) : (
          <Locked why={lockedProvision}>Provision account and mark hired</Locked>
        )}
        <p className="mt-3 mb-0 text-xs text-muted">This creates or links the account, grants the apps above, and sets the candidate to Hired. It is the end of the pipeline.</p>
      </section>

      <Modal
        open={ask}
        onClose={() => setAsk(false)}
        title="Provision and mark hired?"
        footer={
          <>
            <Btn onClick={() => setAsk(false)}>Cancel</Btn>
            <Btn kind="primary" disabled={pending} onClick={go}>
              {pending ? "Provisioning…" : "Provision"}
            </Btn>
          </>
        }
      >
        <p className="mt-0 text-sm text-body">The account gets exactly what is listed. The decision is recorded with your name.</p>
        <label className="block">
          <Label className="mb-1.5">A note for the record · optional</Label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="w-full rounded-[4px] border border-line-strong px-2.5 py-2 text-sm outline-none focus:border-brand" />
        </label>
      </Modal>
    </div>
  );
}

/** The end of the pipeline — said plainly, without celebration. */
export function HiredCard({ name, lines, recordHref }: { name: string; lines: string[]; recordHref: string }) {
  return (
    <section className="max-w-[720px] rounded-[6px] border border-line bg-surface p-6">
      <Pill tone="success">Hired</Pill>
      <div className="mt-3 mb-4 text-[22px] leading-7 font-semibold text-heading">{name} has a MahekOne account.</div>
      <div className="flex flex-col gap-1.5">
        {lines.map((l) => (
          <div key={l} className="text-sm leading-[21px] text-body">
            {l}
          </div>
        ))}
      </div>
      <div className="mt-5 flex gap-2">
        <BtnLink href={recordHref} size="sm">
          Open record
        </BtnLink>
        <BtnLink href="/admin" size="sm" kind="ghost">
          Admin Console → Access
        </BtnLink>
      </div>
    </section>
  );
}
