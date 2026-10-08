"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { confirmFieldsAction, documentStatusAction, unmaskAction, uploadDocumentAction } from "@/lib/hire/actions/onboarding";
import { AiField, Btn, Callout, Icon, Label, Locked, Pill, fd, type Tone } from "../_ui/kit";

export type DocView = {
  key: string;
  label: string;
  kind: string;
  mandatory: boolean;
  verify: boolean;
  pii: string;
  vaulted: boolean;
  docId: string | null;
  status: string | null;
  notes: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  uploadedAt: string | null;
  file: { id: string; filename: string; contentType: string; sizeKb: number } | null;
  masked: string | null;
  vaultId: string | null;
  extraction: { fields: { label: string; value: string; confidence: number }[]; signals: string[]; quality: string; ai: boolean } | null;
  confidence: number | null;
};

const STATUS: Record<string, [string, Tone]> = {
  pending: ["To verify", "warn"],
  manual_review: ["Manual review", "warn"],
  verified: ["Verified", "success"],
  failed: ["Failed — new one asked", "danger"],
  waived: ["Waived", "muted"],
};

const NUMBER_HINT: Record<string, string> = { aadhaar: "12 digits", pan: "5 letters, 4 digits, 1 letter", bank: "Account number, 9 to 18 digits" };
const DEFAULT_FIELDS: Record<string, string[]> = {
  aadhaar: ["Name", "Date of birth", "Address"],
  pan: ["Name", "Father’s name", "Date of birth"],
  bank: ["Account holder", "Bank", "IFSC", "Branch"],
  photo: ["Matches the candidate"],
  certificate: ["Name", "Licence class", "Valid until"],
  payslip: ["Employer", "Month", "Net pay"],
  address: ["Name", "Address"],
  other: ["Name"],
};

const inputCls = "h-8 w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-[13px] text-heading outline-none focus:border-brand";

export function DocumentsBoard({
  applicationId,
  docs,
  canDocuments,
  canUnmask,
  vaultReady,
  lockedDocuments,
  lockedUnmask,
  open,
}: {
  applicationId: string;
  docs: DocView[];
  canDocuments: boolean;
  canUnmask: boolean;
  vaultReady: boolean;
  lockedDocuments: string;
  lockedUnmask: string;
  open: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [review, setReview] = useState<string | null>(() => docs.find((d) => d.status === "manual_review" || (d.status === "pending" && d.extraction))?.key ?? null);
  const [reason, setReason] = useState<{ key: string; status: "failed" | "waived"; label: string } | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [unmaskAsk, setUnmaskAsk] = useState<DocView | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadKey, setUploadKey] = useState<string | null>(null);

  const pickFile = (key: string) => {
    setUploadKey(key);
    fileRef.current?.click();
  };
  const onFile = (f: File | undefined) => {
    if (!f || !uploadKey) return;
    const key = uploadKey;
    const fd0 = new FormData();
    fd0.set("applicationId", applicationId);
    fd0.set("requirementKey", key);
    fd0.set("file", f);
    start(async () => {
      const r = await uploadDocumentAction(fd0);
      toast.push(r.ok ? (r.message ?? "Uploaded.") : (r.error ?? "Upload failed."), r.ok ? "info" : "error");
      if (r.ok) setReview(key);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    });
  };

  const doUnmask = (d: DocView) =>
    start(async () => {
      const r = await unmaskAction(d.vaultId!);
      setUnmaskAsk(null);
      if (!r.ok) return toast.push(r.error, "error");
      setShown((s) => ({ ...s, [d.key]: r.data.value }));
      /* Re-masked after a minute, and on leaving the page — nothing keeps it. */
      setTimeout(() => setShown((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== d.key))), 60_000);
    });

  const sendReason = () => {
    if (!reason) return;
    const r0 = reason;
    start(async () => {
      const r = await documentStatusAction(applicationId, r0.key, r0.status, reasonText);
      toast.push(r.ok ? (r.message ?? "Saved.") : r.error, r.ok ? "info" : "error");
      if (r.ok) {
        setReason(null);
        setReasonText("");
        router.refresh();
      }
    });
  };

  const current = docs.find((d) => d.key === review) ?? null;

  return (
    <>
      <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
        {docs.map((d) => {
          const missing = d.mandatory && d.status !== "verified" && d.status !== "waived";
          const [sl, st] = d.status ? (STATUS[d.status] ?? [d.status, "neutral"]) : d.mandatory ? (["Missing", "danger"] as [string, Tone]) : (["Not collected", "muted"] as [string, Tone]);
          const restricted = d.vaulted || d.pii === "restricted";
          return (
            <div key={d.key} className={cx("grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto] items-center gap-3 border-t border-divider px-4 py-3 first:border-t-0", missing && open ? "shadow-[inset_3px_0_0_var(--color-danger)]" : "")}>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-heading">{d.label}</span>
                <span className="block truncate text-xs text-muted">
                  {d.mandatory ? "Mandatory" : "Optional"} · {d.pii === "none" ? "not personal" : d.pii}
                  {d.file ? ` · ${d.file.filename} · ${d.file.sizeKb} KB · ${fd(d.uploadedAt)}` : ""}
                  {d.verifiedBy && d.status !== "pending" ? ` · ${d.status === "verified" ? "verified" : d.status} by ${d.verifiedBy} ${fd(d.verifiedAt)}` : ""}
                </span>
                {d.notes && (d.status === "failed" || d.status === "waived") ? <span className="block text-xs text-muted">“{d.notes}”</span> : null}
              </span>
              <span className="min-w-0 text-[13px] tabular-nums">
                {d.vaulted ? (
                  shown[d.key] ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-medium text-heading">{shown[d.key]}</span>
                      <Pill tone="warn" title="Unmasked — this access is in the audit log">
                        <Icon n="eye" s={12} />
                        &nbsp;Unmasked · logged
                      </Pill>
                    </span>
                  ) : d.masked ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="text-body">{d.masked}</span>
                      {canUnmask ? (
                        <button onClick={() => setUnmaskAsk(d)} className="cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-brand-hover">
                          Unmask
                        </button>
                      ) : (
                        <span title={lockedUnmask} className="inline-flex items-center gap-1 text-xs text-faint">
                          <Icon n="lock" s={12} />
                          Unmask
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-faint">{d.file ? "Number not captured" : "—"}</span>
                  )
                ) : (
                  <span className="text-faint">{d.extraction?.fields[0] ? `${d.extraction.fields[0].label}: ${d.extraction.fields[0].value}` : "—"}</span>
                )}
              </span>
              <Pill tone={st}>{sl}</Pill>
              <span className="flex items-center justify-end gap-1.5">
                {d.file ? (
                  restricted && !canUnmask ? (
                    <span title={`An identity or bank document shows the number itself. ${lockedUnmask}`} className="inline-flex items-center gap-1 text-xs text-faint">
                      <Icon n="lock" s={12} />
                      View
                    </span>
                  ) : (
                    <a href={`/api/hire/files/${d.file.id}`} target="_blank" rel="noreferrer" className="text-[13px]" title={restricted ? "Opening it is logged" : undefined}>
                      View
                    </a>
                  )
                ) : null}
                {!canDocuments ? (
                  <Locked size="sm" why={lockedDocuments}>
                    Upload
                  </Locked>
                ) : open ? (
                  <>
                    <Btn size="sm" disabled={pending} onClick={() => pickFile(d.key)}>
                      {d.file ? "Replace" : "Upload"}
                    </Btn>
                    {d.status !== "verified" && d.status !== "waived" ? (
                      <Btn size="sm" kind="ghost" disabled={pending} onClick={() => setReview(d.key)}>
                        {d.docId ? "Review" : "Enter by hand"}
                      </Btn>
                    ) : null}
                    {!d.mandatory || d.status !== "waived" ? (
                      d.status !== "verified" && d.status !== "waived" ? (
                        <Btn size="sm" kind="ghost" disabled={pending} onClick={() => setReason({ key: d.key, status: "waived", label: d.label })}>
                          Waive
                        </Btn>
                      ) : null
                    ) : null}
                  </>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      {current && open && canDocuments ? (
        <ReviewPanel
          key={`${current.key}:${current.docId ?? "none"}`}
          doc={current}
          vaultReady={vaultReady}
          busy={pending}
          onClose={() => setReview(null)}
          onFail={() => setReason({ key: current.key, status: "failed", label: current.label })}
          onSave={(fields, idNumber, verify) => {
            if (!current.docId) {
              toast.push("Upload the document first — a person checks it against the original.", "error");
              return;
            }
            start(async () => {
              const r = await confirmFieldsAction(current.docId!, { fields, idNumber, verify });
              toast.push(r.ok ? (r.message ?? "Saved.") : r.error, r.ok ? "info" : "error");
              if (r.ok) {
                if (verify) setReview(null);
                router.refresh();
              }
            });
          }}
        />
      ) : null}

      <Modal
        open={Boolean(unmaskAsk)}
        onClose={() => setUnmaskAsk(null)}
        title={`Unmask ${unmaskAsk?.label ?? ""}?`}
        footer={
          <>
            <Btn onClick={() => setUnmaskAsk(null)}>Cancel</Btn>
            <Btn kind="primary" disabled={pending} onClick={() => unmaskAsk && doUnmask(unmaskAsk)}>
              Unmask and log it
            </Btn>
          </>
        }
      >
        <p className="m-0 text-sm text-body">
          The full number is shown to you for one minute. Your name, the time and which number you saw are written to the audit trail, and the candidate can ask to see who opened their documents.
        </p>
      </Modal>

      <Modal
        open={Boolean(reason)}
        onClose={() => setReason(null)}
        title={reason?.status === "failed" ? `Mark ${reason?.label} failed` : `Waive ${reason?.label}`}
        footer={
          <>
            <Btn onClick={() => setReason(null)}>Cancel</Btn>
            <Btn kind={reason?.status === "failed" ? "danger" : "primary"} disabled={pending || reasonText.trim().length < 10} onClick={sendReason}>
              {reason?.status === "failed" ? "Mark failed · ask for a new one" : "Waive"}
            </Btn>
          </>
        }
      >
        <label className="block">
          <Label className="mb-1.5">Reason · required</Label>
          <textarea value={reasonText} onChange={(e) => setReasonText(e.target.value)} rows={3} className={cx(inputCls, "h-auto py-2")} placeholder={reason?.status === "failed" ? "What is wrong with it — blurred, cut off, a different name…" : "Why this role can go without it for this person"} />
          <span className="mt-1 block text-xs text-muted">Kept on the record. At least 10 characters.</span>
        </label>
      </Modal>
    </>
  );
}

function ReviewPanel({
  doc,
  vaultReady,
  busy,
  onClose,
  onFail,
  onSave,
}: {
  doc: DocView;
  vaultReady: boolean;
  busy: boolean;
  onClose: () => void;
  onFail: () => void;
  onSave: (fields: { label: string; value: string }[], idNumber: string | undefined, verify: boolean) => void;
}) {
  const start = doc.extraction?.fields.length ? doc.extraction.fields.map((f) => ({ label: f.label, value: f.value, confidence: f.confidence as number | null })) : (DEFAULT_FIELDS[doc.kind] ?? DEFAULT_FIELDS.other).map((l) => ({ label: l, value: "", confidence: null as number | null }));
  const [fields, setFields] = useState(start);
  const [idNumber, setIdNumber] = useState("");
  const ai = Boolean(doc.extraction?.ai);
  const conf = doc.confidence;
  const confWord = conf == null ? null : conf >= 0.8 ? "High" : conf >= 0.55 ? "Moderate" : "Low";
  const needsNumber = doc.vaulted && !doc.vaultId;
  return (
    <div className={cx("overflow-hidden rounded-[6px] border bg-surface", ai ? (confWord === "Low" ? "border-warn-line" : "border-ai-line") : "border-line")}>
      <div className={cx("flex items-center justify-between px-4 py-2 text-[13px] font-medium", ai ? (confWord === "Low" ? "bg-warn-soft text-warn-ink" : "bg-ai-soft text-ai") : "bg-page text-body")}>
        <span>{ai ? `◈ Extracted from ${doc.label}` : `${doc.label} · entered by hand`}</span>
        <span className="flex items-center gap-3">
          {ai && confWord ? <span>Confidence: {confWord}{confWord === "Low" ? " · check every field against the document" : ""}</span> : null}
          <button onClick={onClose} aria-label="Close" className="cursor-pointer border-0 bg-transparent p-0 text-inherit">
            <Icon n="x" s={14} />
          </button>
        </span>
      </div>
      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-5 p-4">
        <div className="flex flex-col gap-2">
          {fields.map((f, i) => (
            <div key={i} className="grid grid-cols-[130px_minmax(0,1fr)_auto] items-center gap-2">
              <input value={f.label} onChange={(e) => setFields((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} className={cx(inputCls, "text-muted")} />
              <input value={f.value} onChange={(e) => setFields((x) => x.map((y, j) => (j === i ? { ...y, value: e.target.value, confidence: null } : y)))} className={inputCls} />
              {f.confidence != null && ai ? <AiField source="ai" confidence={f.confidence} /> : <Pill tone="neutral">Human</Pill>}
            </div>
          ))}
          <button onClick={() => setFields((x) => [...x, { label: "", value: "", confidence: null }])} className="w-fit cursor-pointer border-0 bg-transparent p-0 text-[13px] text-brand-hover">
            + Add a field
          </button>
          {doc.vaulted ? (
            <label className="mt-2 block">
              <Label className="mb-1">{doc.label} number {needsNumber ? "· required to verify" : "· stored — type only to replace it"}</Label>
              <input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} autoComplete="off" spellCheck={false} placeholder={NUMBER_HINT[doc.kind] ?? ""} className={cx(inputCls, "font-mono")} disabled={!vaultReady} />
              <span className="mt-1 block text-xs text-muted">{vaultReady ? "Goes straight to the encrypted vault. It is never kept with these fields or shown unmasked again without a logged unmask." : "No vault key is configured, so the number cannot be stored."}</span>
            </label>
          ) : null}
        </div>
        <div className="flex flex-col gap-3">
          {doc.file ? (
            doc.file.contentType.startsWith("image/") && !doc.vaulted ? (
              /* eslint-disable-next-line @next/next/no-img-element -- a private, scope-checked file, not an optimisable asset */
              <img src={`/api/hire/files/${doc.file.id}`} alt={doc.label} className="max-h-[260px] w-full rounded-[4px] border border-line object-contain" />
            ) : (
              <a href={`/api/hire/files/${doc.file.id}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-[4px] border border-line px-3 py-2.5 text-[13px]">
                <Icon n="doc" s={16} />
                Open {doc.file.filename} beside this form{doc.vaulted ? " (logged)" : ""}
              </a>
            )
          ) : (
            <Callout tone="warn">Nothing uploaded yet. Upload the document first, then confirm the fields against it.</Callout>
          )}
          {doc.extraction?.signals.length ? (
            <div>
              <Label className="mb-1">Noticed by the AI — for you to judge</Label>
              <ul className="m-0 pl-4 text-[13px] text-body">
                {doc.extraction.signals.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          ) : doc.extraction ? (
            <div className="text-[13px] text-muted">Quality: {doc.extraction.quality}. Nothing unusual noticed.</div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-divider px-4 py-3">
        <Btn kind="danger" size="sm" disabled={busy || !doc.docId} onClick={onFail}>
          Mark failed · ask for a new one
        </Btn>
        <span className="flex-1" />
        <Btn size="sm" disabled={busy} onClick={() => onSave(fields, idNumber || undefined, false)}>
          Save
        </Btn>
        <Btn kind="primary" size="sm" disabled={busy || !doc.docId || (needsNumber && !idNumber.trim())} onClick={() => onSave(fields, idNumber || undefined, true)} title={needsNumber && !idNumber.trim() ? "Enter the number first" : undefined}>
          Confirm fields and verify
        </Btn>
      </div>
    </div>
  );
}
