"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { draftRejectionMessage, recordRejectionMessage } from "@/lib/hire/actions/decisions";
import { AiMark, Btn, Callout, Label } from "../_ui/kit";

const field = "w-full rounded-[4px] border border-line-strong bg-surface px-2.5 py-2 text-sm leading-5 text-heading outline-none focus:border-brand";

/** A decision that needs words: the button stays disabled until the reasoning is long enough. */
export function ReasonDialog({
  title,
  sub,
  okLabel,
  danger,
  placeholder,
  min = 20,
  onClose,
  onSubmit,
}: {
  title: string;
  sub: string;
  okLabel: string;
  danger?: boolean;
  placeholder: string;
  min?: number;
  onClose: () => void;
  onSubmit: (reasoning: string) => Promise<string | null>;
}) {
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const len = why.trim().length;
  const ready = len >= min && !busy;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width={560}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            kind={danger ? "danger" : "primary"}
            disabled={!ready}
            title={ready ? undefined : `Write at least ${min} characters of reasoning first`}
            onClick={async () => {
              setBusy(true);
              setError(await onSubmit(why));
              setBusy(false);
            }}
          >
            {busy ? "Saving…" : okLabel}
          </Btn>
        </>
      }
    >
      <p className="mt-0 mb-4 text-sm text-body">{sub}</p>
      <label className="block">
        <span className="mb-1.5 flex justify-between text-xs font-medium tracking-[0.04em] text-muted uppercase">
          <span>Your reasoning</span>
          <span>Required</span>
        </span>
        <textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={5} placeholder={placeholder} className={field} autoFocus />
        <span className={cx("mt-1 block text-xs", len >= min ? "text-muted" : "text-warn-ink")}>{len >= min ? `${len} characters` : `${min - len} more characters needed — it stays on the record`}</span>
      </label>
      {error ? <Callout tone="danger" className="mt-3">{error}</Callout> : null}
    </Modal>
  );
}

/**
 * The message to a rejected candidate. AI drafts it; a person reads, edits and
 * records it. Nothing is sent by the system — an email or WhatsApp goes from
 * the person, and is logged here once it has.
 */
export function RejectionMessageDialog({ applicationId, name, languages, onClose }: { applicationId: string; name: string; languages: string[]; onClose: () => void }) {
  const toast = useToast();
  const [language, setLanguage] = useState(languages[0] ?? "English");
  const [feedback, setFeedback] = useState("");
  const [channel, setChannel] = useState<"email" | "whatsapp" | "sms">("whatsapp");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [meta, setMeta] = useState<{ aiDrafted: boolean; aiTaskId: string | null; note: string | null } | null>(null);
  const [busy, setBusy] = useState<"draft" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const draft = async () => {
    setBusy("draft");
    setError(null);
    const r = await draftRejectionMessage(applicationId, { feedback, language });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setSubject(r.data.subject);
    setBody(r.data.body);
    setMeta({ aiDrafted: r.data.aiDrafted, aiTaskId: r.data.aiTaskId, note: r.data.note });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Write to ${name}`}
      width={640}
      footer={
        <>
          <Btn onClick={onClose}>Not now</Btn>
          {channel === "whatsapp" && body ? (
            <a className="text-[13px] text-brand-hover" href={`https://wa.me/?text=${encodeURIComponent(body)}`} target="_blank" rel="noreferrer">
              Open in WhatsApp
            </a>
          ) : null}
          <Btn
            kind="primary"
            disabled={body.trim().length < 20 || busy !== null}
            title={body.trim().length < 20 ? "Draft or write the message first" : undefined}
            onClick={async () => {
              setBusy("save");
              const r = await recordRejectionMessage(applicationId, { channel, subject, body, language, aiDrafted: Boolean(meta?.aiDrafted), aiTaskId: meta?.aiTaskId ?? null });
              setBusy(null);
              if (!r.ok) return setError(r.error);
              toast.push(r.message ?? "Recorded.");
              onClose();
            }}
          >
            {busy === "save" ? "Saving…" : "I have sent it — record it"}
          </Btn>
        </>
      }
    >
      <p className="mt-0 mb-4 text-sm text-body">Rejected candidates are most of the people who apply, and this is often all they hear from us. Clear, respectful, no false encouragement — and nothing that reads as a judgement about who they are.</p>
      <div className="grid grid-cols-3 gap-3">
        <label className="block">
          <Label className="mb-1.5">Language</Label>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={cx(field, "h-9 py-0")}>
            {languages.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <Label className="mb-1.5">Channel</Label>
          <select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} className={cx(field, "h-9 py-0")}>
            <option value="whatsapp">WhatsApp</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
        </label>
        <div className="flex items-end">
          <Btn onClick={draft} disabled={busy !== null}>
            <AiMark /> {busy === "draft" ? "Drafting…" : body ? "Draft again" : "Draft it"}
          </Btn>
        </div>
      </div>
      <label className="mt-3 block">
        <Label className="mb-1.5">Developmental feedback · optional</Label>
        <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} placeholder="Something specific they could work on, e.g. give an example with the result when describing a sale." className={field} />
      </label>
      {meta ? (
        <div className="mt-4">
          {meta.aiDrafted ? (
            <div className="mb-2 text-[12px] text-ai">
              <AiMark /> AI draft — read it and change anything before it goes.
            </div>
          ) : meta.note ? (
            <Callout tone="warn" className="mb-2">{meta.note}</Callout>
          ) : null}
          {channel === "email" ? <input value={subject} onChange={(e) => setSubject(e.target.value)} className={cx(field, "mb-2")} aria-label="Subject" /> : null}
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9} className={cx(field, meta.aiDrafted ? "border-ai-line" : "")} aria-label="Message" />
        </div>
      ) : null}
      {error ? <Callout tone="danger" className="mt-3">{error}</Callout> : null}
    </Modal>
  );
}
