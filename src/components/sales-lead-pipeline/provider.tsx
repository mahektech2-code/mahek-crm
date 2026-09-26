"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useToast } from "@/components/ui/toast";
import {
  advanceLeadStage,
  askForFirstOrder,
  confirmFirstOrder,
  recordCommunication,
  saveLeadQualification,
  setLeadNextAction,
} from "@/lib/actions/leads";
import { reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import { decideSample, dispatchSample } from "@/lib/actions/lead-samples";
import {
  agreeCommercialTerms,
  decideDistributorAppointment,
  recordDistributorAgreement,
  sendBackForCorrection,
  submitForManagementReview,
} from "@/lib/actions/distributor-appointment";
import { reassignLead } from "@/lib/actions/sales";
import {
  convertProspect,
  markLeadLost,
  receiveSampleForLead,
  requestSampleForLead,
  reviewSampleForLead,
  verifyProspect,
  type ConvertProspectInput,
  type VerifyProspectInput,
} from "@/lib/actions/sales-manager-pipeline";
import type { Result } from "@/lib/result";
import { NETWORK_FAILURE, safeMessage } from "@/lib/sales-lead-pipeline/errors";
import type { Lead, ModalKind, PipelineRefs, Stage } from "@/lib/sales-lead-pipeline/types";

/**
 * The Sales Manager lead record's ONE client-side seam to the server.
 *
 * WHAT IS HELD HERE: which dialog is open, whether a save is in flight, and the
 * sentence the last refusal produced. Nothing else. The lead itself is a PROP —
 * whatever the server rendered — and every mutation below is a server action
 * followed by a refresh of that render, so what the screen shows after a save
 * is what the database holds and never what this file believes happened.
 *
 * NO SUCCESS WITHOUT A RESULT. A toast says "saved" only after an action has
 * answered `ok`; a refusal keeps the dialog open with the action's own sentence
 * (or, for anything that looks like the database talking, a plain one — see
 * `errors.ts`), and a request that never arrived says so rather than pretending.
 * Every outcome, success or not, refreshes the page, because a refusal is often
 * the news that somebody else got there first.
 */

type Modal = { kind: ModalKind; leadId: string | null };

type RunOptions = {
  /** Sentence for the toast on success. Falls back to the action's own message. */
  success?: string;
  /** Close the dialog on success. Default true. */
  close?: boolean;
};

type Ctx = {
  /** The business day, YYYY-MM-DD — resolved on the server, never read from a clock here. */
  today: string;
  todayDate: Date;
  refs: PipelineRefs;
  lead: Lead;
  modal: Modal;
  busy: boolean;
  /** The last refusal, shown inside whichever dialog is open. Cleared when one opens or closes. */
  error: string | null;
  openModal: (kind: NonNullable<ModalKind>, leadId: string) => void;
  closeModal: () => void;
  getLead: (id: string) => Lead | undefined;

  /* --- the two orchestrations --- */
  doConvert: (input: Omit<ConvertProspectInput, "customerId">) => Promise<boolean>;
  doVerify: (input: Omit<VerifyProspectInput, "customerId">) => Promise<boolean>;
  doLost: (reasonCode: string, note: string) => Promise<boolean>;

  /* --- qualification --- */
  doSaveChecklist: (answers: Record<string, boolean>) => Promise<boolean>;
  doReviewChecklist: (verdict: "verified" | "incomplete" | "clarification", note: string) => Promise<boolean>;

  /* --- samples --- */
  doRequestSample: (input: { productId: string; quantityCans: number; application: string; reasonCode: string }) => Promise<boolean>;
  doDecideSample: (approve: boolean, note: string) => Promise<boolean>;
  doDispatchSample: (input: { courierName: string; trackingNumber: string; expectedDeliveryDate: string }) => Promise<boolean>;
  doMarkSampleReceived: () => Promise<boolean>;
  doSampleReview: (fields: Record<string, string>, outcome: "approved" | "more_testing" | "rejected") => Promise<boolean>;

  /* --- ladder moves --- */
  doMoveTo: (to: Stage, success: string) => Promise<boolean>;

  /* --- negotiation and the first order --- */
  doAskOrder: (input: { answers: Record<string, string>; expectedDate: string; expectedCans?: number; expectedValuePaise?: number }) => Promise<boolean>;
  doConfirmOrder: (input: { orderedOn: string; valuePaise: number; reference: string; cans?: number }) => Promise<boolean>;

  /* --- the distributor track --- */
  doSubmitManagement: (note: string) => Promise<boolean>;
  doAgreeTerms: (input: { discountPercent: number; creditLimitPaise: number; exclusivity: boolean; note: string }) => Promise<boolean>;
  doDecideDistributor: (approvalId: string, approve: boolean, note: string) => Promise<boolean>;
  doSendBack: (approvalId: string, note: string) => Promise<boolean>;
  doConfirmAgreement: () => Promise<boolean>;

  /* --- people and next steps --- */
  doReassign: (salesmanId: string) => Promise<boolean>;
  doNextAction: (input: { action: string; date: string; ownerId: string; outcome?: string }) => Promise<boolean>;
  doCommunication: (actionCode: string, documentId?: string) => Promise<boolean>;
};

const LeadPipelineContext = React.createContext<Ctx | null>(null);

export function useLeadPipeline() {
  const ctx = React.useContext(LeadPipelineContext);
  if (!ctx) throw new Error("useLeadPipeline must be used inside <LeadPipelineProvider>");
  return ctx;
}

export function LeadPipelineProvider({
  lead,
  refs,
  today,
  children,
}: {
  lead: Lead;
  refs: PipelineRefs;
  today: string;
  children: React.ReactNode;
}) {
  const [modal, setModal] = React.useState<Modal>({ kind: null, leadId: null });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const router = useRouter();
  const toast = useToast();

  /* Constructing a Date from the server's day is not reading the clock. */
  const todayDate = React.useMemo(() => new Date(`${today}T00:00:00`), [today]);

  const getLead = React.useCallback((id: string) => (id === lead.id ? lead : undefined), [lead]);

  const openModal = React.useCallback((kind: NonNullable<ModalKind>, leadId: string) => {
    setError(null);
    setModal({ kind, leadId });
  }, []);
  const closeModal = React.useCallback(() => {
    setError(null);
    setModal({ kind: null, leadId: null });
  }, []);

  /*
   * ONE PLACE A SERVER ACTION IS CALLED FROM A BUTTON.
   *
   * `busy` stops a second press while the first is in flight — the double-click
   * that would otherwise record a commitment twice. The refresh happens on a
   * REFUSAL as well as on success: "that sample has already been decided" is
   * exactly the case where what is on screen is stale.
   */
  const run = React.useCallback(
    async <T,>(call: () => Promise<Result<T>>, options: RunOptions = {}): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      try {
        const result = await call();
        if (!result.ok) {
          const message = safeMessage(result.error);
          if (modal.kind) setError(message);
          else toast.push(message, "error");
          router.refresh();
          return false;
        }
        const extra = result.warnings?.length ? ` ${result.warnings.map(safeMessage).join(" ")}` : "";
        toast.push(`${options.success ?? result.message ?? "Saved."}${extra}`.trim());
        if (options.close !== false) closeModal();
        router.refresh();
        return true;
      } catch {
        /* The request itself failed: a dropped connection, or a deploy landing
           mid-click. Nothing is known to have been saved, and the page is
           refreshed so that it says what actually is. */
        if (modal.kind) setError(NETWORK_FAILURE);
        else toast.push(NETWORK_FAILURE, "error");
        router.refresh();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, modal.kind, toast, router, closeModal],
  );

  const id = lead.id;

  const value: Ctx = {
    today,
    todayDate,
    refs,
    lead,
    modal,
    busy,
    error,
    openModal,
    closeModal,
    getLead,

    doConvert: (input) => run(() => convertProspect({ customerId: id, ...input })),
    doVerify: (input) => run(() => verifyProspect({ customerId: id, ...input })),
    doLost: (reasonCode, note) => run(() => markLeadLost({ customerId: id, reasonCode, note: note.trim() || undefined })),

    doSaveChecklist: (answers) => run(() => saveLeadQualification(id, answers), { close: false, success: "Checklist saved." }),
    doReviewChecklist: (verdict, note) =>
      run(() => reviewLeadQualification({ customerId: id, verdict, note: note.trim() || undefined }), {
        success: verdict === "verified" ? "Checklist marked verified." : "Sent back to the salesman.",
      }),

    doRequestSample: (input) => run(() => requestSampleForLead({ customerId: id, ...input })),
    doDecideSample: (approve, note) => {
      const sampleId = lead.sample?.id;
      if (!sampleId) return Promise.resolve(false);
      return run(() => decideSample(sampleId, { approve, note: note.trim() || undefined }), {
        success: approve ? "Sample approved." : "Sample refused — the salesman has your reason.",
      });
    },
    doDispatchSample: (input) => {
      const sampleId = lead.sample?.id;
      if (!sampleId) return Promise.resolve(false);
      return run(() => dispatchSample(sampleId, input), { success: "Dispatch recorded." });
    },
    doMarkSampleReceived: () => {
      const sampleId = lead.sample?.id;
      if (!sampleId) return Promise.resolve(false);
      return run(() => receiveSampleForLead({ customerId: id, sampleId }));
    },
    doSampleReview: (fields, outcome) => {
      const sampleId = lead.sample?.id;
      if (!sampleId) return Promise.resolve(false);
      return run(() => reviewSampleForLead({ customerId: id, sampleId, fields, trialOutcome: outcome }));
    },

    doMoveTo: (to, success) => run(() => advanceLeadStage({ customerId: id, to }), { success }),

    doAskOrder: (input) => run(() => askForFirstOrder(id, input), { success: "Commitment saved — a forecast, not a sale." }),
    doConfirmOrder: (input) =>
      run(() => confirmFirstOrder(id, input), {
        success: "Order recorded and sent to Accounts for approval. It counts as a sale once they accept it.",
      }),

    doSubmitManagement: (note) =>
      run(() => submitForManagementReview(id, note.trim() || undefined), { success: "Put forward for appointment." }),
    doAgreeTerms: (input) => run(() => agreeCommercialTerms(id, input), { success: "Terms recorded." }),
    doDecideDistributor: (approvalId, approve, note) =>
      run(() => decideDistributorAppointment(approvalId, { approve, note: note.trim() || undefined }), {
        success: approve ? "Approved." : "Refused — the candidate has your reason.",
      }),
    doSendBack: (approvalId, note) => run(() => sendBackForCorrection(approvalId, { note }), { success: "Sent back for correction." }),
    doConfirmAgreement: () => run(() => recordDistributorAgreement(id, {}), { success: "Agreement recorded." }),

    doReassign: (salesmanId) => run(() => reassignLead({ leadId: id, salesmanId }), { success: "Reassigned — both people are notified." }),
    doNextAction: (input) => run(() => setLeadNextAction(id, input), { success: "Next action saved." }),
    doCommunication: (actionCode, documentId) =>
      run(() => recordCommunication(id, { actionCode, documentId }), { close: false, success: "Recorded on the timeline." }),
  };

  return <LeadPipelineContext.Provider value={value}>{children}</LeadPipelineContext.Provider>;
}
