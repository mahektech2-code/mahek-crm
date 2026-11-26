"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { issueAssetAction, returnAssetAction, setAssetApplicableAction, setItemAction } from "@/lib/hire/actions/onboarding";
import type { CheckGroup, CheckItem } from "../_onboard/checks";
import { Btn, Callout, Label, Panel, Pill, fd, type Tone } from "../_ui/kit";

export type AssetView = {
  key: string;
  label: string;
  serialNeeded: boolean;
  acknowledge: boolean;
  applicable: boolean;
  notApplicableReason: string | null;
  serial: string | null;
  issuedOn: string | null;
  issuedBy: string | null;
  acknowledgedAt: string | null;
  ackMethod: string | null;
  ackFileId: string | null;
  problem: string | null;
  returnedOn: string | null;
  history: number;
};

export type AssetEvent = { id: string; label: string; what: string; by: string | null; at: string };

export type TrainingSummary = {
  track: string;
  trainer: string | null;
  passed: number;
  required: number;
  percent: number;
  current: string | null;
  lastScore: number | null;
  passMark: number | null;
  next: string | null;
  retraining: string[];
} | null;

const inputCls = "h-8 w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-[13px] text-heading outline-none focus:border-brand";

function ack(a: AssetView): [string, Tone] {
  if (!a.applicable) return ["Not applicable", "muted"];
  if (!a.issuedOn) return [a.returnedOn ? `Returned ${fd(a.returnedOn)}` : "Not issued", "neutral"];
  if (a.problem) return [`Problem: ${a.problem}`, "danger"];
  if (!a.acknowledge) return ["No acknowledgement asked", "muted"];
  if (a.acknowledgedAt) return [`Acknowledged ${fd(a.acknowledgedAt)} · ${a.ackMethod === "signed_slip" ? "signed slip" : "in app"}`, "success"];
  return ["Waiting for the employee", "warn"];
}

export function AssetsPanel({
  applicationId,
  assets,
  history,
  intros,
  setup,
  training,
  today,
  canAssets,
  canOnboard,
  open,
  lockedAssets,
  lockedOnboard,
  why,
}: {
  applicationId: string;
  assets: AssetView[];
  history: AssetEvent[];
  intros: (CheckItem & { who: string | null })[];
  setup: CheckGroup[];
  training: TrainingSummary;
  today: string;
  canAssets: boolean;
  canOnboard: boolean;
  open: boolean;
  lockedAssets: string;
  lockedOnboard: string;
  why: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<{ key: string; mode: "issue" | "na" | "slip" | "return" } | null>(null);
  const [serial, setSerial] = useState("");
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const run = (p: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await p();
      if (!r.ok) return toast.push(r.error ?? "That did not save.", "error");
      toast.push(r.message ?? "Saved.");
      setEditing(null);
      router.refresh();
    });
  const begin = (key: string, mode: "issue" | "na" | "slip" | "return", a?: AssetView) => {
    setEditing({ key, mode });
    setSerial(a?.serial ?? "");
    setDate(today);
    setReason("");
    setFile(null);
  };
  const flip = (i: CheckItem) => run(() => setItemAction(applicationId, { kind: i.kind, group: i.group, item: i.item }, !i.done));

  const applicable = assets.filter((a) => a.applicable);
  const issued = applicable.filter((a) => a.issuedOn).length;
  const acked = applicable.filter((a) => a.acknowledge && a.acknowledgedAt).length;
  const canEditAssets = open && canAssets;
  const canEditItems = open && canOnboard;

  return (
    <div className="flex flex-col gap-4">
      {why ? <Callout tone="neutral">{why}</Callout> : null}
      <Panel
        title="Company assets"
        sub={`${applicable.length} applicable · ${issued} issued · ${acked} acknowledged by the employee`}
        actions={
          <Btn size="sm" kind="ghost" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Hide history" : `History (${history.length})`}
          </Btn>
        }
        pad={false}
      >
        {!canAssets ? <div className="px-5 pt-3 text-[13px] text-muted">{lockedAssets}</div> : null}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-divider text-left text-[11px] tracking-[0.04em] text-muted uppercase">
                <th className="px-4 py-2.5 font-medium">Asset</th>
                <th className="px-4 py-2.5 font-medium">Applicable</th>
                <th className="px-4 py-2.5 font-medium">Serial / reference</th>
                <th className="px-4 py-2.5 font-medium">Issued</th>
                <th className="px-4 py-2.5 font-medium">Issued by</th>
                <th className="px-4 py-2.5 font-medium">Acknowledged</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => {
                const [l, t] = ack(a);
                const ed = editing?.key === a.key ? editing.mode : null;
                return (
                  <Fragment key={a.key}>
                    <tr className="border-b border-canvas">
                      <td className="px-4 py-2.5 font-medium text-heading">{a.label}</td>
                      <td className="px-4 py-2.5 text-body" title={a.notApplicableReason ?? undefined}>
                        {a.applicable ? "Yes" : "No"}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-body">{a.serial ?? "—"}</td>
                      <td className="px-4 py-2.5 text-body tabular-nums">{a.issuedOn ? fd(a.issuedOn) : "—"}</td>
                      <td className="px-4 py-2.5 text-body">{a.issuedBy ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <Pill tone={t} title={a.problem ?? undefined}>
                          {l.length > 48 ? `${l.slice(0, 46)}…` : l}
                        </Pill>
                        {a.ackFileId ? (
                          <a className="ml-2 text-xs" href={`/api/hire/files/${a.ackFileId}`} target="_blank" rel="noreferrer">
                            Slip
                          </a>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        {canEditAssets ? (
                          <span className="inline-flex gap-1">
                            {a.applicable && !a.issuedOn ? (
                              <Btn size="sm" kind="primary" onClick={() => begin(a.key, "issue", a)}>
                                Issue
                              </Btn>
                            ) : null}
                            {a.applicable && a.issuedOn && a.acknowledge && !a.acknowledgedAt ? (
                              <Btn size="sm" onClick={() => begin(a.key, "slip")}>
                                Signed slip
                              </Btn>
                            ) : null}
                            {a.issuedOn ? (
                              <Btn size="sm" kind="ghost" onClick={() => begin(a.key, "return")}>
                                Return
                              </Btn>
                            ) : null}
                            {a.applicable && !a.issuedOn ? (
                              <Btn size="sm" kind="ghost" onClick={() => begin(a.key, "na")}>
                                Not applicable
                              </Btn>
                            ) : null}
                            {!a.applicable ? (
                              <Btn size="sm" kind="ghost" disabled={pending} onClick={() => run(() => setAssetApplicableAction(applicationId, a.key, true, ""))}>
                                Applies
                              </Btn>
                            ) : null}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                    {ed ? (
                      <tr className="border-b border-divider bg-page">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="flex flex-wrap items-end gap-3">
                            {ed === "issue" ? (
                              <>
                                <label className="block w-[220px]">
                                  <Label className="mb-1">Serial / reference{a.serialNeeded ? " · required" : " · optional"}</Label>
                                  <input value={serial} onChange={(e) => setSerial(e.target.value)} className={inputCls} />
                                </label>
                                <label className="block w-[160px]">
                                  <Label className="mb-1">Issued on</Label>
                                  <input type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
                                </label>
                                <Btn size="sm" kind="primary" disabled={pending || (a.serialNeeded && !serial.trim())} title={a.serialNeeded && !serial.trim() ? "Enter the serial first" : undefined} onClick={() => run(() => issueAssetAction(applicationId, a.key, { serial, issuedOn: date }))}>
                                  Issue {a.label}
                                </Btn>
                              </>
                            ) : ed === "na" ? (
                              <>
                                <label className="block min-w-[320px] flex-1">
                                  <Label className="mb-1">Why it does not apply · kept on the record</Label>
                                  <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
                                </label>
                                <Btn size="sm" kind="primary" disabled={pending || reason.trim().length < 10} title={reason.trim().length < 10 ? "At least 10 characters" : undefined} onClick={() => run(() => setAssetApplicableAction(applicationId, a.key, false, reason))}>
                                  Mark not applicable
                                </Btn>
                              </>
                            ) : ed === "slip" ? (
                              <>
                                <label className="block">
                                  <Label className="mb-1">Signed acknowledgement slip · PDF or photo</Label>
                                  <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[13px]" />
                                </label>
                                <Btn
                                  size="sm"
                                  kind="primary"
                                  disabled={pending || !file}
                                  title={!file ? "Choose the file first" : undefined}
                                  onClick={() =>
                                    run(() => {
                                      const fd0 = new FormData();
                                      fd0.set("op", "asset-slip");
                                      fd0.set("applicationId", applicationId);
                                      fd0.set("key", a.key);
                                      fd0.set("file", file!);
                                      /* A route handler, not a server action: a photo of a slip is often over 1 MB. */
                                      return fetch("/api/hire/upload", { method: "POST", body: fd0 })
                                        .then((r) => r.json())
                                        .catch(() => ({ ok: false, error: "The upload did not reach the server. Try again." }));
                                    })
                                  }
                                >
                                  Upload and acknowledge
                                </Btn>
                              </>
                            ) : (
                              <>
                                <label className="block w-[160px]">
                                  <Label className="mb-1">Returned on</Label>
                                  <input type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
                                </label>
                                <Btn size="sm" kind="primary" disabled={pending} onClick={() => run(() => returnAssetAction(applicationId, a.key, date))}>
                                  Record return
                                </Btn>
                              </>
                            )}
                            <Btn size="sm" onClick={() => setEditing(null)}>
                              Cancel
                            </Btn>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {showHistory ? (
          <ol className="m-0 flex list-none flex-col gap-2 border-t border-divider px-5 py-3">
            {history.map((h) => (
              <li key={h.id} className="text-[13px] leading-[19px] text-body">
                <b className="font-medium text-heading">{h.label}</b> · {h.what}
                <span className="text-muted">
                  {" "}
                  · {h.by ?? "System"}, {fd(h.at)}
                </span>
              </li>
            ))}
            {!history.length ? <li className="text-[13px] text-muted">Nothing issued yet.</li> : null}
          </ol>
        ) : null}
        <div className="border-t border-divider px-5 py-2.5 text-xs text-muted">Acknowledgement comes from the employee in the Training app, or a signed slip uploaded here. Returns and replacements are new rows — nothing is overwritten.</div>
      </Panel>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-4">
        <Panel title="Department introductions" sub="The onboarding owner introduces them to each desk" actions={<Pill>{`${intros.filter((i) => i.done).length} of ${intros.length}`}</Pill>} pad={false}>
          {!canOnboard ? <div className="px-5 pt-3 text-[13px] text-muted">{lockedOnboard}</div> : null}
          <ul className="m-0 list-none px-5 py-2">
            {intros.map((i) => (
              <li key={i.item} className="flex items-center gap-2.5 border-b border-canvas py-2 last:border-b-0">
                <input type="checkbox" checked={i.done} disabled={!canEditItems || pending} onChange={() => flip(i)} className="h-4 w-4 accent-[var(--color-brand)]" aria-label={`Introduced to ${i.label}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-heading">{i.label}</span>
                  <span className="block text-xs text-muted">{i.who ?? "Nobody named in the directory"}</span>
                </span>
                <span className="text-xs text-muted">{i.done ? fd(i.at) : "—"}</span>
              </li>
            ))}
            {!intros.length ? <li className="py-2 text-[13px] text-muted">This role lists no introductions.</li> : null}
          </ul>
        </Panel>
        <Panel title="Training" sub={training ? `${training.track}${training.trainer ? ` · trainer ${training.trainer}` : ""}` : "Not enrolled"}>
          {training ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-baseline gap-2">
                <span className="text-[28px] leading-[34px] font-semibold text-heading tabular-nums">{training.percent}%</span>
                <span className="text-[13px] text-muted">
                  {training.passed} of {training.required} required modules passed
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-divider">
                <div className="h-full bg-brand" style={{ width: `${training.percent}%` }} />
              </div>
              <div className="flex flex-col gap-1.5 text-[13px]">
                <div className="flex justify-between gap-3">
                  <span className="text-muted">Current</span>
                  <span className="font-medium text-heading">{training.current ?? "—"}</span>
                </div>
                {training.lastScore != null ? (
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Last attempt</span>
                    <span className={cx("font-medium", training.passMark != null && training.lastScore < training.passMark ? "text-danger" : "text-heading")}>
                      {training.lastScore}%{training.passMark != null ? ` · pass mark ${training.passMark}%` : ""}
                    </span>
                  </div>
                ) : null}
                <div className="flex justify-between gap-3">
                  <span className="text-muted">Next</span>
                  <span className="text-muted">{training.next ? `${training.next} · locked` : "—"}</span>
                </div>
              </div>
              {training.retraining.length ? <Callout tone="danger">Retraining required on {training.retraining.join(", ")} — the retake opens once the trainer signs the review off.</Callout> : null}
            </div>
          ) : (
            <div className="text-[13px] text-muted">They are enrolled when their account is created on Provision.</div>
          )}
        </Panel>
      </div>

      {setup.map((g) => {
        const done = g.items.filter((i) => i.done).length;
        return (
          <Panel key={g.key} title={g.label} sub="Set up once the account exists" actions={<Pill tone={done === g.items.length ? "success" : "warn"}>{done === g.items.length ? "Done" : `${done} of ${g.items.length}`}</Pill>}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              {g.items.map((i) => (
                <label key={i.item} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm text-body" title={i.by ? `${i.by}, ${fd(i.at)}` : undefined}>
                  <input type="checkbox" checked={i.done} disabled={!canEditItems || pending} onChange={() => flip(i)} className="h-4 w-4 accent-[var(--color-brand)]" />
                  {i.label}
                </label>
              ))}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

