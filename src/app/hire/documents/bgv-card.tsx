"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { addBgvRemarkAction, revealBgvRemarksAction, saveBgvAction } from "@/lib/hire/actions/onboarding";
import { Btn, Callout, Icon, Label, Locked, Panel, Pill, type Tone } from "../_ui/kit";

export type BgvView = {
  required: boolean;
  status: string;
  method: string | null;
  vendor: string | null;
  initiatedOn: string | null;
  completedOn: string | null;
  checkedBy: string | null;
  remarks: number;
} | null;

const STATUSES: [string, string][] = [
  ["not_started", "Not started"],
  ["in_progress", "In progress"],
  ["clear", "Clear"],
  ["concern", "Concern"],
];
const TONE: Record<string, Tone> = { not_started: "neutral", in_progress: "info", clear: "success", concern: "danger", not_applicable: "muted" };
const LABEL: Record<string, string> = { not_started: "Not started", in_progress: "In progress", clear: "Clear", concern: "Concern", not_applicable: "Not applicable" };

const inputCls = "h-9 w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm text-heading outline-none focus:border-brand disabled:bg-canvas";

/** PRD §8 — the background check, on the application. It records the check; it does not run one. */
export function BgvCard({ applicationId, bgv, open, canEdit, editWhy, canRemarks, remarksWhy }: { applicationId: string; bgv: BgvView; open: boolean; canEdit: boolean; editWhy: string; canRemarks: boolean; remarksWhy: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [required, setRequired] = useState(bgv?.required ?? true);
  const [status, setStatus] = useState(bgv && bgv.status !== "not_applicable" ? bgv.status : "not_started");
  const [method, setMethod] = useState(bgv?.method ?? "");
  const [vendor, setVendor] = useState(bgv?.vendor ?? "");
  const [initiated, setInitiated] = useState(bgv?.initiatedOn ?? "");
  const [completed, setCompleted] = useState(bgv?.completedOn ?? "");
  const [remarkOpen, setRemarkOpen] = useState(false);
  const [remark, setRemark] = useState("");
  const [shown, setShown] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ro = !open || !canEdit;
  const shownStatus = bgv ? (bgv.required ? bgv.status : "not_applicable") : null;

  const save = () =>
    start(async () => {
      const r = await saveBgvAction(applicationId, { required, status: required ? status : "not_applicable", method, vendor, initiatedOn: initiated || null, completedOn: completed || null });
      if (!r.ok) {
        setErrors(Object.fromEntries((r.fieldErrors ?? []).map((f) => [f.field, f.message])));
        return toast.push(r.error, "error");
      }
      setErrors({});
      toast.push(r.message ?? "Saved.");
      router.refresh();
    });
  const addRemark = () =>
    start(async () => {
      const r = await addBgvRemarkAction(applicationId, remark);
      toast.push(r.ok ? (r.message ?? "Saved.") : r.error, r.ok ? "info" : "error");
      if (r.ok) {
        setRemark("");
        setRemarkOpen(false);
        setShown(null);
        router.refresh();
      }
    });
  const reveal = () =>
    start(async () => {
      const r = await revealBgvRemarksAction(applicationId);
      if (!r.ok) return toast.push(r.error, "error");
      setShown(r.data.remarks);
    });

  return (
    <Panel
      title="Background verification"
      sub="Records the check and what it found — it does not run one"
      actions={shownStatus ? <Pill tone={TONE[shownStatus] ?? "neutral"}>{LABEL[shownStatus] ?? shownStatus}</Pill> : <Pill tone="warn">Not recorded</Pill>}
    >
      <div className="grid grid-cols-2 gap-3.5">
        <div>
          <Label className="mb-1.5">Required</Label>
          <span role="group" aria-label="Background verification required" className="inline-flex gap-0.5 rounded-[6px] border border-line p-[3px]">
            {([true, false] as const).map((v) => (
              <button
                key={String(v)}
                type="button"
                disabled={ro}
                onClick={() => setRequired(v)}
                className={cx("h-7 cursor-pointer rounded-[4px] border-0 px-3.5 text-xs font-medium disabled:cursor-default", required === v ? "bg-heading text-white" : "bg-transparent text-body")}
              >
                {v ? "Yes" : "No"}
              </button>
            ))}
          </span>
        </div>
        <label>
          <Label className="mb-1.5">Status</Label>
          <select disabled={ro || !required} value={required ? status : "not_applicable"} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
            {required ? (
              STATUSES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))
            ) : (
              <option value="not_applicable">Not applicable</option>
            )}
          </select>
        </label>
        <label>
          <Label className="mb-1.5">Method</Label>
          <input disabled={ro || !required} value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Previous-employer call, address check" className={inputCls} />
        </label>
        <label>
          <Label className="mb-1.5">Vendor · optional</Label>
          <input disabled={ro || !required} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="None — done in house" className={inputCls} />
        </label>
        <label>
          <Label className="mb-1.5">Initiated</Label>
          <input type="date" disabled={ro || !required} value={initiated} onChange={(e) => setInitiated(e.target.value)} className={inputCls} />
        </label>
        <label>
          <Label className="mb-1.5">Completed</Label>
          <input type="date" disabled={ro || !required} value={completed} onChange={(e) => setCompleted(e.target.value)} className={cx(inputCls, errors.completedOn ? "border-danger" : "")} />
        </label>
        <div>
          <Label className="mb-1.5">Checked by</Label>
          <div className="pt-2 text-sm text-heading">{bgv?.checkedBy ?? "—"}</div>
        </div>
        <div>
          <Label className="mb-1.5">Remarks · restricted</Label>
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[13px] text-muted">{bgv?.remarks ? `${bgv.remarks} remark${bgv.remarks === 1 ? "" : "s"} · ••••••••` : "None"}</span>
            {bgv?.remarks ? (
              canRemarks ? (
                <Btn size="sm" disabled={pending} onClick={reveal} title="Opening them is logged as PII access">
                  <Icon n="eye" s={14} />
                  Show
                </Btn>
              ) : (
                <Locked size="sm" why={`${remarksWhy} Opening them is logged as PII access.`}>
                  Show
                </Locked>
              )
            ) : null}
          </div>
        </div>
        {shown ? (
          <div className="col-span-2 rounded-[4px] border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
            <div className="mb-1 font-medium">Shown to you · this access is logged</div>
            {shown.length ? (
              <ul className="m-0 pl-4">
                {shown.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : (
              "No remark could be read with the current key."
            )}
          </div>
        ) : null}
        <div className="col-span-2 flex flex-wrap gap-2">
          {canEdit ? (
            <>
              <Btn kind="primary" disabled={pending || !open} onClick={save} title={open ? undefined : "The application is not open"}>
                Save check
              </Btn>
              <Btn disabled={pending || !open} onClick={() => setRemarkOpen(true)} title={open ? undefined : "The application is not open"}>
                Add remark
              </Btn>
            </>
          ) : (
            <Locked why={editWhy}>Save check</Locked>
          )}
        </div>
      </div>
      {open ? <Callout tone="info" className="mt-4">Employment documents can be prepared once this is Clear or Not applicable.</Callout> : null}
      <Modal
        open={remarkOpen}
        onClose={() => setRemarkOpen(false)}
        title="Add a restricted remark"
        footer={
          <>
            <Btn onClick={() => setRemarkOpen(false)}>Cancel</Btn>
            <Btn kind="primary" disabled={pending || remark.trim().length < 10} title={remark.trim().length < 10 ? "Write it in a sentence" : undefined} onClick={addRemark}>
              Store, restricted
            </Btn>
          </>
        }
      >
        <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={4} className={cx(inputCls, "h-auto py-2")} placeholder="What the check found, in a sentence or two" />
        <span className="mt-1 block text-xs text-muted">Encrypted in the vault. Only HR Head and Admin can read it, and each reading is logged.</span>
      </Modal>
    </Panel>
  );
}
