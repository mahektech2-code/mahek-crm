"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { Result } from "@/lib/result";
import {
  changeStatus,
  confirmSentFromPhone,
  correctProfileField,
  draftMessageAction,
  generateSummary,
  logReply,
  openCurrentInterview,
  parseCvAction,
  resolveDuplicateAction,
  runConsistencyCheck,
  screenInAction,
  sendEmail,
  setDoNotContact,
  uploadCv,
} from "@/lib/hire/actions/candidate";
import { AiField, Btn, Callout, Icon, Label, Pill } from "../../_ui/kit";

/* ---------------------------------------------------------------------------
 * The candidate record's interactive pieces. Each one calls a server action
 * that checks for itself; these only collect input and say what happened.
 * ------------------------------------------------------------------------- */

const field = "w-full min-h-9 rounded-[4px] border border-line-strong bg-surface px-2.5 py-2 text-sm leading-5 text-heading outline-none focus:border-brand";

function useRun() {
  const toast = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T,>(p: () => Promise<Result<T>>, after?: (r: Result<T>) => void) =>
    start(async () => {
      const r = await p();
      if (r.ok) {
        if (r.message) toast.push(r.message);
        router.refresh();
      } else toast.push(r.error, "error");
      after?.(r);
    });
  return { run, pending };
}

/** A button that runs one action and refreshes. */
export function RunButton({ action, label, kind = "secondary", size = "md", title }: { action: () => Promise<Result<unknown>>; label: string; kind?: "primary" | "secondary" | "ghost"; size?: "md" | "sm"; title?: string }) {
  const { run, pending } = useRun();
  return (
    <Btn kind={kind} size={size} title={title} disabled={pending} onClick={() => run(action)}>
      {pending ? "Working…" : label}
    </Btn>
  );
}

export function AiRunButton({ applicationId, what, label }: { applicationId: string; what: "summary" | "consistency"; label: string }) {
  return <RunButton size="sm" label={label} action={() => (what === "summary" ? generateSummary(applicationId) : runConsistencyCheck(applicationId))} />;
}

/** An action that needs a written reason, in a modal. */
export function ReasonButton({
  label,
  title,
  sub,
  okLabel,
  min = 20,
  danger,
  kind = "secondary",
  onSubmit,
}: {
  label: string;
  title: string;
  sub: string;
  okLabel: string;
  min?: number;
  danger?: boolean;
  kind?: "primary" | "secondary" | "ghost";
  onSubmit: (reason: string) => Promise<Result<unknown>>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { run, pending } = useRun();
  const short = reason.trim().length < min;
  return (
    <>
      <Btn kind={kind} onClick={() => setOpen(true)}>
        {label}
      </Btn>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        footer={
          <>
            <Btn onClick={() => setOpen(false)}>Cancel</Btn>
            <Btn kind={danger ? "danger" : "primary"} disabled={short || pending} title={short ? `At least ${min} characters — it is kept on the record` : undefined} onClick={() => run(() => onSubmit(reason), (r) => r.ok && setOpen(false))}>
              {pending ? "Saving…" : okLabel}
            </Btn>
          </>
        }
      >
        <p className="mt-0 text-sm text-body">{sub}</p>
        <Label className="mb-1.5">Reason · required</Label>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} className={field} placeholder="Kept on the record and in the audit trail" />
        <div className={short ? "mt-1 text-xs text-muted" : "mt-1 text-xs text-success"}>
          {reason.trim().length} / {min} characters minimum
        </div>
      </Modal>
    </>
  );
}

export function StatusButtons({ applicationId, status }: { applicationId: string; status: string }) {
  return (
    <>
      {status === "in_progress" ? (
        <ReasonButton label="Put on hold" title="Put on hold" sub="Holding stops the pipeline for this candidate until somebody resumes them. Say why — the next person to open this record will read it." okLabel="Put on hold" onSubmit={(r) => changeStatus(applicationId, "hold", r)} />
      ) : null}
      {status === "on_hold" ? <ReasonButton label="Resume" title="Resume the application" sub="They return to the stage they were held at." okLabel="Resume" onSubmit={(r) => changeStatus(applicationId, "resume", r)} /> : null}
      {status === "in_progress" || status === "on_hold" ? (
        <ReasonButton label="Withdraw" danger title="Record a withdrawal" sub="Use this when the candidate has withdrawn. It is not a rejection — rejecting is a decision at a gate or the rejection queue." okLabel="Record withdrawal" onSubmit={(r) => changeStatus(applicationId, "withdraw", r)} />
      ) : null}
    </>
  );
}

export function ScreenInButton({ applicationId }: { applicationId: string }) {
  return <RunButton kind="primary" label="Screen in" action={() => screenInAction(applicationId)} />;
}

export function OpenInterviewButton({ applicationId, label }: { applicationId: string; label: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Btn
      kind="primary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await openCurrentInterview(applicationId);
          if (r.ok) router.push(r.data.href);
          else toast.push(r.error, "error");
        })
      }
    >
      {pending ? "Opening…" : label}
    </Btn>
  );
}

export function DuplicateDecide({ applicationId }: { applicationId: string }) {
  return (
    <div className="flex flex-none gap-2">
      <ReasonButton label="Same person" title="The same person" sub="Their earlier application is linked to this one and shown throughout. Nothing is merged. Inside the cooling-off period, continuing needs a Hiring Manager, HR Head or Admin." okLabel="Confirm same person" min={10} onSubmit={(r) => resolveDuplicateAction(applicationId, true, r)} />
      <ReasonButton label="Different person" title="A different person" sub="The two records stay separate, and this application continues." okLabel="Confirm different" min={10} onSubmit={(r) => resolveDuplicateAction(applicationId, false, r)} />
    </div>
  );
}

/* ----------------------------------------------------------------- profile */

export function ProfileField({ applicationId, label, value, source, confidence, editable }: { applicationId: string; label: string; value: string; source: "ai" | "human"; confidence: number | null; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const { run, pending } = useRun();
  const low = source === "ai" && (confidence ?? 0) < 0.8;
  return (
    <div className={`flex min-h-11 items-center gap-3 border-b border-divider px-5 py-2 ${low ? "bg-warn-soft/40" : ""}`}>
      <span className="w-[180px] flex-none text-[13px] text-muted">{label}</span>
      {editing ? (
        <span className="flex flex-1 items-center gap-2">
          <input value={v} onChange={(e) => setV(e.target.value)} className={field} autoFocus />
          <Btn size="sm" kind="primary" disabled={pending} onClick={() => run(() => correctProfileField(applicationId, label, v), (r) => r.ok && setEditing(false))}>
            Save
          </Btn>
          <Btn size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Btn>
        </span>
      ) : (
        <>
          <span className={`flex-1 text-sm ${value === "—" ? "text-faint" : "text-heading"}`}>{value}</span>
          {value === "—" ? <Pill tone="muted">Not entered</Pill> : <AiField source={source} confidence={confidence} />}
          {editable ? (
            <Btn size="sm" kind="ghost" onClick={() => setEditing(true)}>
              Correct
            </Btn>
          ) : null}
        </>
      )}
    </div>
  );
}

export function CvPanel({ applicationId, files, editable }: { applicationId: string; files: { id: string; filename: string; uploadedAt: string }[]; editable: boolean }) {
  const { run, pending } = useRun();
  const [file, setFile] = useState<File | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {files.length ? (
        files.map((f, i) => (
          <div key={f.id} className="flex items-center gap-3 text-sm">
            <Icon n="doc" />
            <span className="flex-1 truncate">{f.filename}</span>
            {i === 0 ? <Pill tone="neutral">Latest</Pill> : null}
            {editable ? (
              <Btn size="sm" disabled={pending} onClick={() => run(() => parseCvAction(applicationId, f.id), (r) => setParseErr(r.ok ? null : r.error))}>
                <span className="text-ai-mid">◈</span> {pending ? "Reading…" : "Parse with AI"}
              </Btn>
            ) : null}
          </div>
        ))
      ) : (
        <div className="text-[13px] text-muted">No CV on file yet.</div>
      )}
      {parseErr ? <Callout tone="warn">{parseErr}</Callout> : null}
      {editable ? (
        <div className="flex items-center gap-2">
          <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[13px]" />
          <Btn
            size="sm"
            disabled={!file || pending}
            onClick={() => {
              if (!file) return;
              const fdata = new FormData();
              fdata.set("file", file);
              run(() => uploadCv(applicationId, fdata), (r) => r.ok && setFile(null));
            }}
          >
            <Icon n="upload" s={14} /> Upload CV
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- communication */

type Channel = "whatsapp" | "sms" | "email";
const PURPOSES: [string, string][] = [
  ["interview", "Interview details"],
  ["documents", "Documents still needed"],
  ["follow_up", "Following up"],
  ["custom", "Something else"],
];

export function Composer({
  applicationId,
  languages,
  defaultLanguage,
  phone,
  email,
  aiOn,
}: {
  applicationId: string;
  languages: string[];
  defaultLanguage: string;
  phone: string;
  email: string | null;
  aiOn: boolean;
}) {
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [language, setLanguage] = useState(languages.includes(defaultLanguage) ? defaultLanguage : languages[0] ?? "English");
  const [purpose, setPurpose] = useState("interview");
  const [note, setNote] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState<{ ai: boolean; notice: string | null; taskId: string | null } | null>(null);
  const [opened, setOpened] = useState(false);
  const { run, pending } = useRun();
  const [drafting, startDraft] = useTransition();
  const toast = useToast();

  const digits = phone.replace(/\D/g, "");
  const link = channel === "whatsapp" ? `https://wa.me/${digits}?text=${encodeURIComponent(body)}` : channel === "sms" ? `sms:+${digits}?body=${encodeURIComponent(body)}` : null;

  const reset = () => {
    setBody("");
    setSubject("");
    setDraft(null);
    setOpened(false);
    setNote("");
  };

  return (
    <div className="rounded-[6px] border border-line bg-surface p-5">
      <div className="mb-3 text-[15px] font-semibold text-heading">Write to the candidate</div>
      <div className="mb-3 grid grid-cols-3 gap-3">
        <label>
          <Label className="mb-1">Channel</Label>
          <select value={channel} onChange={(e) => { setChannel(e.target.value as Channel); setOpened(false); }} className={field}>
            <option value="whatsapp">WhatsApp</option>
            <option value="sms">SMS</option>
            <option value="email" disabled={!email}>
              Email{email ? "" : " — no address"}
            </option>
          </select>
        </label>
        <label>
          <Label className="mb-1">Language</Label>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={field}>
            {languages.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <label>
          <Label className="mb-1">About</Label>
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)} className={field}>
            {PURPOSES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="mb-3 block">
        <Label className="mb-1">What you want to say · optional</Label>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={field} placeholder="e.g. bring the last three payslips" />
      </label>
      <div className="mb-3">
        <Btn
          size="sm"
          disabled={drafting}
          onClick={() =>
            startDraft(async () => {
              const r = await draftMessageAction(applicationId, { purpose: purpose as never, channel, language, note });
              if (!r.ok) return toast.push(r.error, "error");
              setSubject(r.data.subject);
              setBody(r.data.body);
              setDraft({ ai: r.data.ai, notice: r.data.notice, taskId: r.data.taskId });
              setOpened(false);
            })
          }
        >
          {aiOn ? (
            <>
              <span className="text-ai-mid">◈</span> {drafting ? "Drafting…" : "Draft with AI"}
            </>
          ) : drafting ? (
            "Filling…"
          ) : (
            "Fill from template"
          )}
        </Btn>
      </div>
      {draft?.ai ? <Callout tone="ai" className="mb-3">◈ Drafted by AI in {language}. Read it before it goes — it is sent by you, not by the AI.</Callout> : null}
      {draft?.notice ? <Callout tone="warn" className="mb-3">{draft.notice}</Callout> : null}
      {channel === "email" ? (
        <label className="mb-3 block">
          <Label className="mb-1">Subject</Label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className={field} />
        </label>
      ) : null}
      <label className="mb-3 block">
        <Label className="mb-1">Message</Label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} className={field} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {channel === "email" ? (
          <Btn kind="primary" disabled={pending || !body.trim()} onClick={() => run(() => sendEmail(applicationId, { subject, body, language, aiDrafted: Boolean(draft?.ai), aiTaskId: draft?.taskId ?? null }), (r) => r.ok && reset())}>
            Send email
          </Btn>
        ) : (
          <>
            <a
              href={body.trim() ? (link ?? "#") : undefined}
              target="_blank"
              rel="noreferrer"
              onClick={() => body.trim() && setOpened(true)}
              className={`inline-flex h-9 items-center rounded-[4px] border px-3.5 text-sm font-medium no-underline hover:no-underline ${body.trim() ? "border-transparent bg-brand text-white" : "pointer-events-none border-divider bg-canvas text-faint"}`}
            >
              Open {channel === "whatsapp" ? "WhatsApp" : "SMS"} on this device
            </a>
            <Btn disabled={!opened || pending} title={opened ? undefined : "Send it first — it is recorded only when you confirm it went"} onClick={() => run(() => confirmSentFromPhone(applicationId, { channel: channel as "whatsapp" | "sms", body, language, aiDrafted: Boolean(draft?.ai), aiTaskId: draft?.taskId ?? null }), (r) => r.ok && reset())}>
              I sent it
            </Btn>
            <span className="text-xs text-muted">Recorded only when you confirm it went.</span>
          </>
        )}
      </div>
    </div>
  );
}

export function LogReplyButton({ applicationId, languages }: { applicationId: string; languages: string[] }) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<"whatsapp" | "sms" | "email" | "phone">("whatsapp");
  const [language, setLanguage] = useState(languages[0] ?? "English");
  const [body, setBody] = useState("");
  const { run, pending } = useRun();
  return (
    <>
      <Btn size="sm" onClick={() => setOpen(true)}>
        Log a reply
      </Btn>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Log the candidate's reply"
        footer={
          <>
            <Btn onClick={() => setOpen(false)}>Cancel</Btn>
            <Btn kind="primary" disabled={pending || body.trim().length < 2} onClick={() => run(() => logReply(applicationId, { channel, body, language }), (r) => r.ok && (setOpen(false), setBody("")))}>
              Log reply
            </Btn>
          </>
        }
      >
        <div className="mb-3 grid grid-cols-2 gap-3">
          <select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} className={field}>
            <option value="whatsapp">WhatsApp</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
            <option value="phone">Phone call</option>
          </select>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={field}>
            {languages.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} className={field} placeholder="What they said, in their words" />
      </Modal>
    </>
  );
}

export function DncButton({ applicationId, on }: { applicationId: string; on: boolean }) {
  if (on) return <RunButton size="sm" label="Allow contact again" action={() => setDoNotContact(applicationId, false, "")} />;
  return <ReasonButton label="Do not contact" title="Mark do not contact" sub="Every composer and search respects this. Say why." okLabel="Mark do not contact" min={10} danger onSubmit={(r) => setDoNotContact(applicationId, true, r)} />;
}

/** Expand / collapse every competency in the Evidence tab. */
export function EvidenceGroup({ name, weight, score, def, quotes, defaultOpen }: { name: string; weight: string; score: string; def: string; quotes: { text: string; source: string; criterion: string; tier: string }[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-divider py-5 last:border-0">
      <button onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-baseline gap-3 border-0 bg-transparent p-0 text-left">
        <span className="text-[18px] font-semibold text-heading">{name}</span>
        <span className="text-xs text-muted">weight {weight}</span>
        <span className="flex-1" />
        <span className="text-[18px] font-semibold tabular-nums text-heading">{score}</span>
        <Icon n={open ? "chevronDown" : "chevron"} className="text-muted" />
      </button>
      <div className="mt-1 text-[13px] text-muted">{def}</div>
      {open ? (
        <div className="mt-4 flex flex-col gap-4">
          {quotes.length ? (
            quotes.map((q, i) => (
              <figure key={i} className="m-0">
                <blockquote className="m-0 border-l-2 border-line-strong pl-3.5 font-evidence text-base leading-[26px] text-heading">“{q.text}”</blockquote>
                <figcaption className="mt-1 pl-3.5 text-xs text-muted">
                  {q.source}
                  {q.criterion ? ` · ${q.tier === "partial" ? "partial: " : ""}${q.criterion}` : ""}
                </figcaption>
              </figure>
            ))
          ) : (
            <div className="text-[13px] text-muted">No confirmed evidence on this competency yet.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
