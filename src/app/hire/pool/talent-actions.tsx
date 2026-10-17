"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { inviteToApply, setSilverMedallist, skipForRole } from "@/lib/hire/actions/talent";
import { Btn } from "../_ui/kit";

/**
 * The three things a person can do with somebody in the pool. Each opens a
 * small form, because each is a decision about a real person that goes on the
 * record with a reason — and "Invite to apply" re-records consent, since
 * agreeing to be considered last year is not agreeing now.
 */
export function TalentActions({
  candidateId,
  name,
  roles,
  defaultRole,
  silver,
  canAct,
  why,
  skipRole,
  primary = true,
  recordHref,
}: {
  candidateId: string;
  name: string;
  roles: { key: string; title: string }[];
  defaultRole?: string;
  silver: boolean;
  canAct: boolean;
  why?: string;
  skipRole?: { key: string; title: string };
  primary?: boolean;
  recordHref: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<null | "invite" | "silver" | "skip">(null);
  const [role, setRole] = useState(defaultRole ?? roles[0]?.key ?? "");
  const [consent, setConsent] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = (m: "invite" | "silver" | "skip") => {
    setText("");
    setConsent(false);
    setError("");
    setOpen(m);
  };
  const submit = async () => {
    setBusy(true);
    setError("");
    const r =
      open === "invite"
        ? await inviteToApply({ candidateId, blueprintKey: role, consent, note: text })
        : open === "silver"
          ? await setSilverMedallist(candidateId, !silver, text)
          : await skipForRole(candidateId, skipRole!.key, text);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setOpen(null);
    toast.push(r.message ?? "Done.");
    if (open === "invite" && r.ok && r.data && typeof r.data === "object" && "applicationId" in r.data) router.push(`/hire/c/${(r.data as { applicationId: string }).applicationId}`);
    else router.refresh();
  };
  const ready = open === "invite" ? consent && Boolean(role) : text.trim().length >= 10;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Btn kind={primary ? "primary" : "secondary"} size="sm" disabled={!canAct || !roles.length} title={!canAct ? why : !roles.length ? "No role is open to apply for." : undefined} onClick={() => start("invite")}>
          Invite to apply
        </Btn>
        <a href={recordHref} className="inline-flex h-[30px] items-center rounded-[4px] border border-line-strong bg-surface px-2.5 text-[13px] font-medium text-body no-underline hover:bg-canvas hover:no-underline">
          Past record
        </a>
        {skipRole ? (
          <Btn kind="ghost" size="sm" disabled={!canAct} title={!canAct ? why : undefined} onClick={() => start("skip")}>
            Not for this role
          </Btn>
        ) : null}
        <Btn kind="ghost" size="sm" disabled={!canAct} title={!canAct ? why : undefined} onClick={() => start("silver")}>
          {silver ? "Remove silver medallist" : "Mark silver medallist"}
        </Btn>
      </div>
      <Modal
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open === "invite" ? `Invite ${name} to apply` : open === "silver" ? (silver ? `${name} is no longer a silver medallist` : `Mark ${name} a silver medallist`) : `${name} is not for ${skipRole?.title ?? "this role"}`}
        footer={
          <>
            <Btn onClick={() => setOpen(null)}>Cancel</Btn>
            <Btn kind="primary" disabled={!ready || busy} title={!ready ? "Complete the required fields first" : undefined} onClick={submit}>
              {busy ? "Saving…" : open === "invite" ? "Create the application" : "Save"}
            </Btn>
          </>
        }
      >
        <div className="flex flex-col gap-4 text-sm">
          {open === "invite" ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Role</span>
                <select value={role} onChange={(e) => setRole(e.target.value)} className="h-9 rounded-[4px] border border-line-strong bg-surface px-2.5">
                  {roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Note · optional</span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="How they were contacted, what they said" className="rounded-[4px] border border-line-strong px-2.5 py-2" />
              </label>
              <label className="flex items-start gap-2.5 rounded-[4px] bg-canvas px-3 py-2.5">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
                <span>
                  {name} agreed to be considered again, and was told that AI assists the evaluation and a person makes every decision. <span className="text-danger">Required</span>
                </span>
              </label>
              <p className="m-0 text-[13px] text-muted">The new application goes through the same door as any other: the duplicate check and any cooling-off period still apply, and their earlier record stays linked.</p>
            </>
          ) : (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Why · required</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={open === "skip" ? "What makes them the wrong fit for this particular role" : "What makes them worth bringing back"} className="rounded-[4px] border border-line-strong px-2.5 py-2" />
              <span className="text-xs text-muted">At least 10 characters — it is kept on the record.</span>
            </label>
          )}
          {error ? <div className="text-[13px] text-danger">{error}</div> : null}
        </div>
      </Modal>
    </>
  );
}
