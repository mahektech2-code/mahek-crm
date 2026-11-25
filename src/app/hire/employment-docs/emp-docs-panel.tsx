"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { approveEmploymentDocAction, prepareEmploymentDocsAction, sendEmploymentDocsAction } from "@/lib/hire/actions/onboarding";

/** Uploads go to a route handler — a server action refuses a body over 1 MB, and a scanned contract is bigger. */
const upload = (f: FormData): Promise<{ ok: boolean; message?: string; error?: string }> =>
  fetch("/api/hire/upload", { method: "POST", body: f })
    .then((r) => r.json())
    .catch(() => ({ ok: false, error: "The upload did not reach the server. Try again." }));
import { EMP_DOC_LABEL, EMP_DOC_STEPS, type EmpDocStep } from "@/lib/hire/engines/onboarding";
import { Btn, Label, Locked, Panel, fd } from "../_ui/kit";

export type EmpDocView = {
  key: string;
  label: string;
  required: boolean;
  hardCopy: boolean;
  template: string;
  templateReady: boolean;
  id: string | null;
  status: string | null;
  preparedBy: string | null;
  preparedByMe: boolean;
  preparedAt: string | null;
  approvedBy: string | null;
  sentAt: string | null;
  signedOn: string | null;
  filedAt: string | null;
  signedFile: { id: string; filename: string } | null;
  body: string | null;
};

const inputCls = "h-9 w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm text-heading outline-none focus:border-brand";

/** The five steps as dots: done green, waiting amber, not yet grey. */
function Steps({ status }: { status: string | null }) {
  const at = status ? EMP_DOC_STEPS.indexOf(status as EmpDocStep) : -1;
  const done = status === "filed" ? EMP_DOC_STEPS.length : at + 1;
  return (
    <span className="flex items-center" aria-label={status ? EMP_DOC_LABEL[status as EmpDocStep] : "Not prepared"}>
      {EMP_DOC_STEPS.map((s, i) => (
        <span key={s} className="flex items-center">
          {i > 0 ? <span className={cx("h-0.5 w-[18px]", i < done ? "bg-success" : "bg-line")} /> : null}
          <span title={EMP_DOC_LABEL[s]} className={cx("h-2.5 w-2.5 rounded-full", i < done ? "bg-success" : i === done && status ? "bg-warn" : "bg-line")} />
        </span>
      ))}
    </span>
  );
}

function stateLine(d: EmpDocView): string {
  switch (d.status) {
    case "prepared":
      return "Waiting for approval";
    case "approved":
      return "Approved · ready to send";
    case "sent":
      return `Sent ${fd(d.sentAt)}`;
    case "signed":
      return `Signed ${fd(d.signedOn)}`;
    case "filed":
      return `Filed ${fd(d.filedAt)}`;
    default:
      return "Not prepared";
  }
}

export function EmpDocsPanel({ applicationId, docs, open, canEdit, editWhy, todayYmd, summary }: { applicationId: string; docs: EmpDocView[]; open: boolean; canEdit: boolean; editWhy: string; todayYmd: string; summary: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [signing, setSigning] = useState<EmpDocView | null>(null);
  const [filing, setFiling] = useState<EmpDocView | null>(null);
  const [reading, setReading] = useState<EmpDocView | null>(null);
  const [signedOn, setSignedOn] = useState(todayYmd);
  const [file, setFile] = useState<File | null>(null);

  const run = (p: Promise<{ ok: boolean; message?: string; error?: string }>, after?: () => void) =>
    start(async () => {
      const r = await p;
      toast.push(r.ok ? (r.message ?? "Saved.") : (r.error ?? "That did not save."), r.ok ? "info" : "error");
      if (r.ok) {
        after?.();
        router.refresh();
      }
    });

  const unprepared = docs.filter((d) => !d.id && d.templateReady);
  const approved = docs.filter((d) => d.status === "approved" && d.id);
  const signed = docs.filter((d) => d.status === "signed" || d.status === "filed").length;
  const can = open && canEdit;

  const submitSigned = () => {
    if (!signing?.id) return;
    const f = new FormData();
    f.set("op", "doc-signed");
    f.set("docId", signing.id);
    f.set("signedOn", signedOn);
    if (file) f.set("file", file);
    run(upload(f), () => {
      setSigning(null);
      setFile(null);
    });
  };
  const submitFiled = () => {
    if (!filing?.id) return;
    const f = new FormData();
    f.set("op", "doc-filed");
    f.set("docId", filing.id);
    if (file) f.set("file", file);
    run(upload(f), () => {
      setFiling(null);
      setFile(null);
    });
  };

  return (
    <Panel
      title="Document pack"
      sub={`${docs.length} document${docs.length === 1 ? "" : "s"} · ${signed} signed${summary ? ` · ${summary}` : ""}`}
      pad={false}
      actions={
        can ? (
          <>
            {unprepared.length ? (
              <Btn size="sm" disabled={pending} onClick={() => run(prepareEmploymentDocsAction(applicationId))}>
                Prepare {unprepared.length === docs.length ? "all" : unprepared.length} from templates
              </Btn>
            ) : null}
            <Btn size="sm" kind="primary" disabled={pending || !approved.length} title={approved.length ? undefined : "Only approved documents are sent"} onClick={() => run(sendEmploymentDocsAction(applicationId, approved.map((d) => d.id!)))}>
              Send approved{approved.length ? ` (${approved.length})` : ""}
            </Btn>
          </>
        ) : !canEdit ? (
          <Locked size="sm" why={editWhy}>
            Prepare
          </Locked>
        ) : null
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              <th className="border-b border-divider px-3 py-2.5 font-medium">Document</th>
              <th className="border-b border-divider px-3 py-2.5 font-medium">Template</th>
              <th className="border-b border-divider px-3 py-2.5 font-medium">Progress</th>
              <th className="border-b border-divider px-3 py-2.5 font-medium">Hard copy</th>
              <th className="border-b border-divider px-3 py-2.5 font-medium">Signed copy</th>
              <th className="border-b border-divider px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.key} className="border-b border-canvas">
                <td className="px-3 py-3 align-middle">
                  <div className="font-medium text-heading">{d.label}</div>
                  <div className="text-xs text-muted">
                    {d.required ? "Required" : "Optional"}
                    {d.preparedBy ? ` · prepared by ${d.preparedByMe ? "you" : d.preparedBy}` : ""}
                    {d.approvedBy ? ` · approved by ${d.approvedBy}` : ""}
                  </div>
                </td>
                <td className={cx("px-3 py-3 text-xs", d.templateReady || d.id ? "text-body" : "text-danger")}>{d.template}</td>
                <td className="px-3 py-3">
                  <span className="flex items-center gap-2.5">
                    <Steps status={d.status} />
                    <span className="text-xs font-medium whitespace-nowrap text-heading">{stateLine(d)}</span>
                  </span>
                </td>
                <td className="px-3 py-3 text-xs text-body">{d.hardCopy ? "Yes · by courier" : "No"}</td>
                <td className="px-3 py-3 text-xs">
                  {d.signedFile ? (
                    <a href={`/api/hire/files/${d.signedFile.id}`} target="_blank" rel="noreferrer">
                      {d.signedFile.filename}
                    </a>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-3 py-3 text-right whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    {d.body ? (
                      <Btn size="sm" kind="ghost" onClick={() => setReading(d)}>
                        Read
                      </Btn>
                    ) : null}
                    {!can ? null : d.status === "prepared" ? (
                      d.preparedByMe ? (
                        <Locked size="sm" why="You prepared it — a second person approves it.">
                          Approve
                        </Locked>
                      ) : (
                        <Btn size="sm" disabled={pending} onClick={() => run(approveEmploymentDocAction(d.id!))}>
                          Approve
                        </Btn>
                      )
                    ) : d.status === "sent" ? (
                      <Btn size="sm" disabled={pending} onClick={() => setSigning(d)}>
                        Mark signed
                      </Btn>
                    ) : d.status === "signed" ? (
                      <Btn size="sm" disabled={pending} onClick={() => setFiling(d)}>
                        File it
                      </Btn>
                    ) : !d.id && d.templateReady ? (
                      <Btn size="sm" disabled={pending} onClick={() => run(prepareEmploymentDocsAction(applicationId, [d.key]))}>
                        Prepare
                      </Btn>
                    ) : null}
                    {can && d.id && (d.status === "prepared" || d.status === "approved") ? (
                      <Btn size="sm" kind="ghost" disabled={pending} title="Prepare it again from the current template and offer" onClick={() => run(prepareEmploymentDocsAction(applicationId, [d.key]))}>
                        Re-prepare
                      </Btn>
                    ) : null}
                    {!open && canEdit && !d.status ? (
                      <Btn size="sm" disabled title="Not yet — see what is still open above">
                        Prepare
                      </Btn>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-4 border-t border-divider px-5 py-2.5 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-success" />
          Done
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-warn" />
          Waiting here
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-line" />
          Not yet
        </span>
        <span>Steps: Prepared → Approved → Sent → Signed → Filed</span>
      </div>

      <Modal
        open={Boolean(signing)}
        onClose={() => setSigning(null)}
        title={`${signing?.label ?? ""} — signed`}
        footer={
          <>
            <Btn onClick={() => setSigning(null)}>Cancel</Btn>
            <Btn kind="primary" disabled={pending || !signedOn} onClick={submitSigned}>
              Record signature
            </Btn>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="block">
            <Label className="mb-1.5">Signed on</Label>
            <input type="date" max={todayYmd} value={signedOn} onChange={(e) => setSignedOn(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <Label className="mb-1.5">Signed copy · optional now, needed to file it</Label>
            <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[13px]" />
          </label>
          {signing?.hardCopy ? <span className="text-xs text-muted">The paper copy still has to come back by courier — record it on the Courier panel.</span> : null}
        </div>
      </Modal>

      <Modal
        open={Boolean(filing)}
        onClose={() => setFiling(null)}
        title={`File ${filing?.label ?? ""}`}
        footer={
          <>
            <Btn onClick={() => setFiling(null)}>Cancel</Btn>
            <Btn kind="primary" disabled={pending || (!filing?.signedFile && !file)} title={!filing?.signedFile && !file ? "Upload the signed copy first" : undefined} onClick={submitFiled}>
              File in the employee record
            </Btn>
          </>
        }
      >
        <label className="block">
          <Label className="mb-1.5">{filing?.signedFile ? `Signed copy · ${filing.signedFile.filename} — choose a file only to replace it` : "Signed copy · required"}</Label>
          <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[13px]" />
        </label>
      </Modal>

      <Modal open={Boolean(reading)} onClose={() => setReading(null)} title={reading?.label ?? ""} footer={<Btn onClick={() => setReading(null)}>Close</Btn>}>
        <pre className="m-0 max-h-[60vh] overflow-y-auto font-[family-name:var(--font-evidence)] text-[14px] leading-6 whitespace-pre-wrap text-heading">{reading?.body}</pre>
      </Modal>
    </Panel>
  );
}
