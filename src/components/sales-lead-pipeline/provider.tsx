"use client";

import * as React from "react";
import { useToast } from "@/components/ui/toast";
import { seedLeads } from "@/lib/sales-lead-pipeline/mock-data";
import { PEOPLE_LIST, PROSPECT_REASONS, QUALIFICATION_CONDITIONS, STAGE_LABEL, personName } from "@/lib/sales-lead-pipeline/reference";
import type { Lead, ModalKind } from "@/lib/sales-lead-pipeline/types";

/**
 * All state for the Sales Manager Lead Pipeline screens lives here, in
 * memory, for the lifetime of the browser tab. There is no persistence layer
 * yet — see the module doc-comment in `lib/sales-lead-pipeline/types.ts` —
 * so every action below mutates this in-memory list rather than calling a
 * server action. This is the isolation boundary: nothing in this file, or
 * anything it calls, touches `src/db` or a server action.
 */

type Modal = { kind: ModalKind; leadId: string | null };

/** One resolved field from a Confirm/Correct/Unable-To-Verify review row. */
export type FieldReview = {
  key: string;
  label: string;
  value: string;
  corrected: boolean;
  original?: string;
  reason?: string;
  firstCapture?: boolean;
};

type Ctx = {
  leads: Lead[];
  today: Date;
  modal: Modal;
  openModal: (kind: NonNullable<ModalKind>, leadId: string) => void;
  closeModal: () => void;
  getLead: (id: string) => Lead | undefined;
  doConvert: (id: string, reasonCode: string, fields: FieldReview[]) => void;
  doVerify: (
    id: string,
    result: string,
    corrections: FieldReview[],
    answers: {
      visitedConfirmed: boolean;
      explainedWell: boolean;
      impression: string;
      requirementGenuine: boolean;
      genuineInterest: boolean;
      realBuyingIntent: boolean;
      priceConcern: boolean;
      creditConcern: boolean;
      deliveryConcern: boolean;
      serviceConcern: boolean;
      competitorConcern: boolean;
      readyForTrial: boolean;
      readyForCommercial: boolean;
      readyForOrder: boolean;
    },
  ) => void;
  doQualifyToggle: (id: string, conditionId: string) => void;
  doRequestSample: (id: string, quantity: string, reason: string) => void;
  doMarkSampleDispatched: (id: string) => void;
  doMarkSampleReceived: (id: string) => void;
  doSampleReview: (
    id: string,
    feedback: { quality: string; performance: string; drying: string; vsCurrent: string; price: string },
    outcome: "approved" | "more_testing" | "rejected",
  ) => void;
  doMoveToNegotiation: (id: string) => void;
  doAskOrder: (id: string, quantity: string, expectedOrderDate: string, blocker: string) => void;
  doConfirmOrder: (id: string, product: string, quantity: string, amount: number, reference: string) => void;
  doConfirmAgreement: (id: string) => void;
  doRecordInitialStock: (id: string) => void;
  doLost: (id: string, reasonCode: string, note: string) => void;
  doReassign: (id: string, newOwner: string, reason: string) => void;
  doNextAction: (id: string, text: string, date: string, resp: string, outcome: string) => void;
};

const LeadPipelineContext = React.createContext<Ctx | null>(null);

export function useLeadPipeline() {
  const ctx = React.useContext(LeadPipelineContext);
  if (!ctx) throw new Error("useLeadPipeline must be used inside <LeadPipelineProvider>");
  return ctx;
}

function reasonLabel(list: { code: string; label: string }[], code: string) {
  return list.find((r) => r.code === code)?.label ?? code;
}

// The field a Confirm/Correct/Unable-To-Verify review key maps onto — one
// definition, shared by Convert and Verify, so a corrected "Competitor" can
// never land on the wrong column.
const FIELD_TO_LEAD_KEY: Record<string, keyof Lead> = {
  monthlyLitres: "monthlyLitres",
  potentialPaise: "potentialPaise",
  product: "product",
  competitor: "competitor",
  contact: "contact",
  decisionMaker: "decisionMaker",
  buyer: "buyer",
};

export function LeadPipelineProvider({ children }: { children: React.ReactNode }) {
  const [leads, setLeads] = React.useState<Lead[]>(() => seedLeads());
  const [today] = React.useState(() => new Date("2026-09-23T00:00:00"));
  const [modal, setModal] = React.useState<Modal>({ kind: null, leadId: null });
  const toast = useToast();

  const getLead = React.useCallback((id: string) => leads.find((l) => l.id === id), [leads]);

  const update = React.useCallback((id: string, fn: (l: Lead) => Lead) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? fn(l) : l)));
  }, []);

  const openModal = React.useCallback((kind: NonNullable<ModalKind>, leadId: string) => {
    setModal({ kind, leadId });
  }, []);
  const closeModal = React.useCallback(() => setModal({ kind: null, leadId: null }), []);

  const stamp = React.useCallback(
    () => today.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
    [today],
  );

  const doConvert = React.useCallback<Ctx["doConvert"]>(
    (id, reasonCode, fields) => {
      const captured: string[] = [];
      const corrected: { field: string; original: string; corrected: string }[] = [];

      update(id, (l) => {
        const next: Lead = { ...l };
        fields.forEach((f) => {
          if (!f.value) return;
          const key = FIELD_TO_LEAD_KEY[f.key];
          if (f.key === "monthlyLitres") {
            (next as Record<string, unknown>).monthlyLitres = parseInt(f.value.replace(/\D/g, ""), 10) || l.monthlyLitres;
          } else if (f.key === "potentialPaise") {
            // Free-text potential entered at conversion is kept as-is on the
            // field it maps from; there's no reliable paise parse from free
            // text, so it's only applied on a correction of an existing figure.
            if (f.corrected) (next as Record<string, unknown>)[key] = f.value;
          } else if (key) {
            (next as Record<string, unknown>)[key] = f.value;
          }
          if (f.corrected) corrected.push({ field: f.label, original: f.original ?? "", corrected: f.value });
          else if (f.firstCapture) captured.push(f.label + ": " + f.value);
        });

        next.stage = "prospect";
        next.customerType = next.customerType || "Hardware retailer";
        next.conversionReason = reasonCode;
        next.verification = { done: false, result: null };
        next.nextAction = "Manager verification call";
        next.nextActionDate = today.toISOString().slice(0, 10);
        next.nextActionResp = "amit";
        next.expectedOutcome = "Verify the visit and open qualification";

        const timeline = [...l.timeline, { d: stamp(), kind: "system" as const, title: "Converted to Prospect", meta: "Reason: " + reasonLabel(PROSPECT_REASONS, reasonCode) }];
        if (captured.length) timeline.push({ d: stamp(), kind: "sales_manager" as const, title: "Captured at conversion", meta: captured.join("; ") });
        corrected.forEach((c) => timeline.push({ d: stamp(), kind: "sales_manager" as const, title: "Corrected " + c.field + " at conversion", meta: c.original + " → " + c.corrected }));
        timeline.push({ d: stamp(), kind: "system" as const, title: "Sales Manager notified — became Lead Manager" });
        timeline.push({ d: stamp(), kind: "system" as const, title: "Customer verification call task raised" });
        timeline.push({ d: stamp(), kind: "system" as const, title: "GST collection/verification task raised" });
        next.timeline = timeline;
        return next;
      });
      closeModal();
      toast.push("Converted to Prospect — manager notified");
    },
    [update, today, stamp, closeModal, toast],
  );

  const doVerify = React.useCallback<Ctx["doVerify"]>(
    (id, result, corrections, answers) => {
      update(id, (l) => {
        const done = result === "verified" || result === "verified_with_corrections";

        // A field marked "Correct" is stored as a full before/after record —
        // never silently overwritten — and only then applied to the lead.
        // Confirm and Unable To Verify never touch the underlying value.
        //
        // Monthly Potential and Trial Interest are recorded in
        // `verificationCorrections` (so the summary can show them) but are
        // deliberately never written back onto the lead's own fields —
        // Potential has no reliable free-text-to-paise parse (same reasoning
        // `doConvert` already applies to it), and Trial Interest is derived
        // from the timeline, not a real column to write into.
        const next: Lead = { ...l, verificationCorrections: [...(l.verificationCorrections ?? [])] };
        corrections.forEach((c) => {
          next.verificationCorrections!.push({ field: c.label, original: c.original ?? "", corrected: c.value, reason: c.reason ?? "Not specified", changedBy: "amit", at: stamp() });
          if (c.key === "potentialPaise" || c.key === "trialInterest") return;
          const key = FIELD_TO_LEAD_KEY[c.key];
          if (c.key === "monthlyLitres") (next as Record<string, unknown>).monthlyLitres = parseInt(c.value.replace(/\D/g, ""), 10) || l.monthlyLitres;
          else if (key) (next as Record<string, unknown>)[key] = c.value;
        });

        next.stage = done ? "qualification" : l.stage;
        next.verification = {
          done,
          result: result as Lead["verification"]["result"],
          visitedConfirmed: answers.visitedConfirmed,
          explainedWell: answers.explainedWell,
          impression: answers.impression,
          requirementGenuine: answers.requirementGenuine,
          genuineInterest: answers.genuineInterest,
          realBuyingIntent: answers.realBuyingIntent,
          priceConcern: answers.priceConcern,
          creditConcern: answers.creditConcern,
          deliveryConcern: answers.deliveryConcern,
          serviceConcern: answers.serviceConcern,
          competitorConcern: answers.competitorConcern,
          readyForTrial: answers.readyForTrial,
          readyForCommercial: answers.readyForCommercial,
          readyForOrder: answers.readyForOrder,
          // Read AFTER corrections are applied — a corrected Competitor is
          // what the verification record should reflect too.
          currentProduct: next.competitor ? next.competitor + " (current)" : "Unbranded",
          competitor: next.competitor,
        };

        const timeline = [...l.timeline, { d: stamp(), kind: "sales_manager" as const, title: "Manager Verification" }];
        timeline.push({ d: stamp(), kind: "sales_manager" as const, title: "Verification Result: " + result.replace(/_/g, " ") });
        corrections.forEach((c) => timeline.push({ d: stamp(), kind: "sales_manager" as const, title: "Corrected " + c.label, meta: (c.original ?? "") + " → " + c.value + " (" + (c.reason || "Not specified") + ")" }));
        next.timeline = timeline;

        if (done) {
          next.nextAction = "Complete qualification visit";
          next.nextActionDate = today.toISOString().slice(0, 10);
          next.nextActionResp = l.owner;
        } else if (result === "followup_required") {
          next.nextAction = "Follow-up before qualification can open";
          next.nextActionDate = today.toISOString().slice(0, 10);
          next.nextActionResp = "amit";
        } else {
          next.nextAction = "Review with salesman — verification failed";
          next.nextActionDate = today.toISOString().slice(0, 10);
          next.nextActionResp = "amit";
        }
        return next;
      });
      closeModal();
      toast.push(done_message(result));
    },
    [update, today, stamp, closeModal, toast],
  );

  const doQualifyToggle = React.useCallback<Ctx["doQualifyToggle"]>(
    (id, conditionId) => {
      update(id, (l) => {
        const nowDone = !l.qualChecks[conditionId];
        const condition = QUALIFICATION_CONDITIONS.find((c) => c.id === conditionId);
        return {
          ...l,
          qualChecks: { ...l.qualChecks, [conditionId]: nowDone },
          timeline: [
            ...l.timeline,
            {
              d: stamp(),
              kind: "sales_manager" as const,
              title: (nowDone ? "Qualification condition marked done" : "Qualification condition unmarked"),
              meta: condition?.says ?? conditionId,
            },
          ],
        };
      });
    },
    [update, stamp],
  );

  const doRequestSample = React.useCallback<Ctx["doRequestSample"]>(
    (id, quantity, reason) => {
      update(id, (l) => ({
        ...l,
        stage: "sample_trial",
        sample: {
          state: "requested",
          quantity,
          reason,
          feedbackRecorded: false,
          trialOutcome: "pending",
          chase: [],
        },
        timeline: [...l.timeline, { d: stamp(), kind: "sales_manager", title: "Sample / Trial requested", meta: quantity + " — " + reason }],
      }));
      closeModal();
      toast.push("Sent for dispatch");
    },
    [update, stamp, closeModal, toast],
  );

  const doMarkSampleDispatched = React.useCallback<Ctx["doMarkSampleDispatched"]>(
    (id) => {
      update(id, (l) => ({
        ...l,
        sample: l.sample ? { ...l.sample, state: "dispatched", dispatchedAt: today.toISOString().slice(0, 10) } : l.sample,
        timeline: [...l.timeline, { d: stamp(), kind: "sales_manager", title: "Sample dispatched" }],
      }));
      toast.push("Marked dispatched");
    },
    [update, stamp, today, toast],
  );

  const doMarkSampleReceived = React.useCallback<Ctx["doMarkSampleReceived"]>(
    (id) => {
      update(id, (l) => ({
        ...l,
        stage: "sample_received",
        sample: l.sample ? { ...l.sample, state: "received", receivedAt: today.toISOString().slice(0, 10) } : l.sample,
        timeline: [...l.timeline, { d: stamp(), kind: "salesman", title: "Sample received, confirmed by customer" }],
      }));
      toast.push("Marked received");
    },
    [update, stamp, today, toast],
  );

  const doSampleReview = React.useCallback<Ctx["doSampleReview"]>(
    (id, feedback, outcome) => {
      const summary = `Quality: ${feedback.quality || "—"}. Performance: ${feedback.performance || "—"}. Drying: ${feedback.drying || "—"}. Vs current: ${feedback.vsCurrent || "—"}. Price: ${feedback.price || "—"}.`;
      update(id, (l) => ({
        ...l,
        stage: "sample_review",
        sample: l.sample ? { ...l.sample, state: "reviewed", feedbackRecorded: true, feedback: summary, trialOutcome: outcome } : l.sample,
        timeline: [...l.timeline, { d: stamp(), kind: "sales_manager", title: "Trial review recorded", meta: outcome }],
      }));
      closeModal();
      toast.push("Review saved");
    },
    [update, stamp, closeModal, toast],
  );

  const doMoveToNegotiation = React.useCallback<Ctx["doMoveToNegotiation"]>(
    (id) => {
      update(id, (l) => ({
        ...l,
        stage: "negotiation",
        negotiation: l.negotiation ?? { visitDone: false, blockers: [] },
        timeline: [...l.timeline, { d: stamp(), kind: "system", title: "Moved to " + STAGE_LABEL.negotiation }],
      }));
      toast.push("Moved to Negotiation");
    },
    [update, stamp, toast],
  );

  const doAskOrder = React.useCallback<Ctx["doAskOrder"]>(
    (id, quantity, expectedOrderDate, blocker) => {
      update(id, (l) => ({
        ...l,
        commitment: { quantity, expectedOrderDate, recordedBy: "amit", recordedAt: today.toISOString().slice(0, 10) },
        negotiation: { ...(l.negotiation ?? { visitDone: false, blockers: [] }), blockers: blocker === "No blocker" ? [] : [blocker] },
        timeline: [...l.timeline, { d: stamp(), kind: "sales_manager", title: "Commitment recorded", meta: `${quantity}, expected ${expectedOrderDate}` }],
      }));
      closeModal();
      toast.push("Commitment saved");
    },
    [update, today, stamp, closeModal, toast],
  );

  const doConfirmOrder = React.useCallback<Ctx["doConfirmOrder"]>(
    (id, product, quantity, amount, reference) => {
      const litres = parseInt(quantity.replace(/\D/g, ""), 10) || 0;
      update(id, (l) => ({
        ...l,
        stage: "first_order",
        product: product || l.product,
        order: { amount, litres, orderedAt: today.toISOString().slice(0, 10), reference },
        timeline: [...l.timeline, { d: stamp(), kind: "sales_manager", title: "Confirmed Actual Order → First Order", meta: reference }],
      }));
      closeModal();
      toast.push("Actual order confirmed");
    },
    [update, today, stamp, closeModal, toast],
  );

  const doConfirmAgreement = React.useCallback<Ctx["doConfirmAgreement"]>(
    (id) => {
      update(id, (l) => ({
        ...l,
        stage: "initial_stock_order",
        timeline: [...l.timeline, { d: stamp(), kind: "sales_manager", title: "Confirmed agreement signed", meta: "Moved to Initial Stock Order" }],
      }));
      toast.push("Agreement signed — moved to Initial Stock Order");
    },
    [update, stamp, toast],
  );

  const doRecordInitialStock = React.useCallback<Ctx["doRecordInitialStock"]>(
    (id) => {
      update(id, (l) => ({
        ...l,
        stage: "active_distributor",
        timeline: [...l.timeline, { d: stamp(), kind: "sales_manager", title: "Recorded initial stock order", meta: "Active distributor" }],
      }));
      toast.push("Active distributor — appears in the Distributors register");
    },
    [update, stamp, toast],
  );

  const doLost = React.useCallback<Ctx["doLost"]>(
    (id, reasonCode, note) => {
      update(id, (l) => ({
        ...l,
        lost: { reason: reasonCode, by: "amit", date: today.toISOString().slice(0, 10) },
        timeline: [...l.timeline, { d: stamp(), kind: "sales_manager", title: "Marked Lost", meta: "Reason: " + reasonCode + (note ? " — " + note : "") }],
      }));
      closeModal();
      toast.push("Marked Lost");
    },
    [update, today, stamp, closeModal, toast],
  );

  const doReassign = React.useCallback<Ctx["doReassign"]>(
    (id, newOwner, reason) => {
      update(id, (l) => {
        const fromName = personName(l.owner);
        const toName = personName(newOwner);
        return {
          ...l,
          owner: newOwner,
          timeline: [
            ...l.timeline,
            {
              d: stamp(),
              kind: "sales_manager" as const,
              title: "Reassigned",
              meta: `${fromName} → ${toName}` + (reason.trim() ? " — " + reason.trim() : ""),
            },
          ],
        };
      });
      closeModal();
      toast.push("Reassigned — both people notified.");
    },
    [update, stamp, closeModal, toast],
  );

  const doNextAction = React.useCallback<Ctx["doNextAction"]>(
    (id, text, date, resp, outcome) => {
      update(id, (l) => ({ ...l, nextAction: text, nextActionDate: date, nextActionResp: resp, expectedOutcome: outcome }));
      closeModal();
      toast.push("Next action saved");
    },
    [update, closeModal, toast],
  );

  const value: Ctx = {
    leads,
    today,
    modal,
    openModal,
    closeModal,
    getLead,
    doConvert,
    doVerify,
    doQualifyToggle,
    doRequestSample,
    doMarkSampleDispatched,
    doMarkSampleReceived,
    doSampleReview,
    doMoveToNegotiation,
    doAskOrder,
    doConfirmOrder,
    doConfirmAgreement,
    doRecordInitialStock,
    doLost,
    doReassign,
    doNextAction,
  };

  return <LeadPipelineContext.Provider value={value}>{children}</LeadPipelineContext.Provider>;
}

function done_message(result: string) {
  if (result === "verified") return "Verified — qualification opened";
  if (result === "verified_with_corrections") return "Verified With Corrections — qualification opened";
  if (result === "followup_required") return "Follow-Up Required";
  return "Verification Failed";
}

export function peopleForReassign() {
  return PEOPLE_LIST.filter((p) => p.role === "salesman");
}
