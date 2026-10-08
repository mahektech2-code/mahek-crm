"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { overrideMoveCandidate, type MoveBlocked } from "@/lib/hire/actions/pipeline";
import { OVERRIDE_REASON_MIN } from "@/lib/hire/engines/gating";
import { BtnLink, Btn, Callout } from "../_ui/kit";

/**
 * A move the entry rule refused. It says WHY, points at where the work that
 * satisfies the rule is done, and — for a person allowed to — offers an
 * override that needs a written reason, recorded and marked on the record.
 * Never a silent failure.
 */
export function MoveModal({ appId, target, info, overrideWho, onClose }: { appId: string; target: string; info: MoveBlocked; overrideWho: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const short = reason.trim().length < OVERRIDE_REASON_MIN;

  const submit = () => {
    if (short) {
      setError(`At least ${OVERRIDE_REASON_MIN} characters — it is shown on the candidate and in the audit log.`);
      return;
    }
    start(async () => {
      const r = await overrideMoveCandidate(appId, target, reason);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.push(r.message ?? "Moved with an override.");
      onClose();
      router.refresh();
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Can’t move ${info.name} to ${info.targetName}`}
      footer={
        <>
          <Btn onClick={onClose}>Close</Btn>
          {info.route ? (
            <BtnLink href={info.route.href} kind={info.canOverride ? "secondary" : "primary"}>
              {info.route.label}
            </BtnLink>
          ) : null}
          {info.canOverride ? (
            <Btn kind="danger" disabled={pending || short} title={short ? "Write the reason first" : undefined} onClick={submit}>
              {pending ? "Moving…" : "Override and move"}
            </Btn>
          ) : null}
        </>
      }
    >
      <p className="m-0 text-sm leading-5 text-body">{info.why}</p>
      {info.overridable && !info.canOverride ? (
        <Callout tone="muted" className="mt-3">
          An override needs a {overrideWho}, with a written reason. It is recorded and marked on the candidate.
        </Callout>
      ) : null}
      {info.canOverride ? (
        <label className="mt-4 block">
          <span className="mb-1 flex justify-between text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Override reason <span className="tracking-normal normal-case">Required</span>
          </span>
          <Textarea
            rows={3}
            value={reason}
            invalid={Boolean(error)}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
            placeholder={`Why this candidate should enter ${info.targetName} without meeting the entry rule`}
          />
          <span className={error ? "mt-1 block text-[13px] text-danger" : "mt-1 block text-[13px] text-muted"}>
            {error ?? `At least ${OVERRIDE_REASON_MIN} characters. Shown on the candidate’s record and in the audit log.`}
          </span>
        </label>
      ) : null}
    </Modal>
  );
}
