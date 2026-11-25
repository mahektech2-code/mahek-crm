/* ---------------------------------------------------------------------------
 * ONBOARDING — the rules the PRD adds, PURE (no I/O, no clock of its own).
 *
 *  - when a negotiated basic needs an approver;
 *  - what a courier shipment's status means and when the paper is back;
 *  - which step an employment document is at, and what comes next;
 *  - the PRD's fourteen statuses, DERIVED from the records — nobody types one;
 *  - filling a document template from the accepted offer.
 * ------------------------------------------------------------------------- */

/* --------------------------------------------------------- compensation */

/**
 * A negotiated basic needs approval when it is more than `abovePercent` over
 * the basic first proposed. A figure at or under the proposal never does: the
 * company offering less than it first said is not the risk being guarded.
 */
export function needsApproval(proposedBasicPaise: number | null, basicPaise: number, abovePercent: number): boolean {
  if (!proposedBasicPaise || proposedBasicPaise <= 0) return false;
  return basicPaise > proposedBasicPaise * (1 + abovePercent / 100);
}

/** "+₹1,500 · +7.7%" pieces, for the screen. */
export function basicDelta(proposedBasicPaise: number | null, basicPaise: number): { paise: number; percent: number } | null {
  if (!proposedBasicPaise) return null;
  return { paise: basicPaise - proposedBasicPaise, percent: Math.round(((basicPaise - proposedBasicPaise) / proposedBasicPaise) * 1000) / 10 };
}

/* -------------------------------------------------------------- courier */

export const COURIER_STATUSES = ["to_be_sent", "sent", "delivered", "awaited", "return_sent", "received", "issue"] as const;
export type CourierStatus = (typeof COURIER_STATUSES)[number];

export const COURIER_STATUS_LABEL: Record<CourierStatus, string> = {
  to_be_sent: "Courier to be sent",
  sent: "Sent",
  delivered: "Delivered to candidate",
  awaited: "Signed documents awaited",
  return_sent: "Return courier sent",
  received: "Received by company",
  issue: "Issue / delay",
};

/** The statuses each direction moves through, in order. */
export const COURIER_FLOW: Record<"outbound" | "return", CourierStatus[]> = {
  outbound: ["to_be_sent", "sent", "delivered"],
  return: ["awaited", "return_sent", "received"],
};

/**
 * PRD §10's single courier status for an application, from its shipments:
 * "Not required" with no hard copy, "Completed" once every return is received.
 */
export function courierOverall(hardCopyNeeded: boolean, shipments: { direction: string; status: string }[]): "not_required" | "completed" | CourierStatus {
  if (!hardCopyNeeded) return "not_required";
  if (shipments.some((s) => s.status === "issue")) return "issue";
  const ret = shipments.filter((s) => s.direction === "return");
  if (ret.length && ret.every((s) => s.status === "received")) return "completed";
  if (ret.length) return (ret.find((s) => s.status !== "received")?.status as CourierStatus) ?? "awaited";
  const out = shipments.filter((s) => s.direction === "outbound");
  if (!out.length) return "to_be_sent";
  if (out.every((s) => s.status === "delivered")) return "awaited";
  return (out.find((s) => s.status !== "delivered")?.status as CourierStatus) ?? "sent";
}

/* ------------------------------------------------- employment documents */

export const EMP_DOC_STEPS = ["prepared", "approved", "sent", "signed", "filed"] as const;
export type EmpDocStep = (typeof EMP_DOC_STEPS)[number];
export const EMP_DOC_LABEL: Record<EmpDocStep, string> = { prepared: "Prepared", approved: "Approved", sent: "Sent", signed: "Signed", filed: "Filed" };

/** The one step a document may move to next, or null at the end. */
export function nextEmpDocStep(status: string): EmpDocStep | null {
  const i = EMP_DOC_STEPS.indexOf(status as EmpDocStep);
  return i >= 0 && i < EMP_DOC_STEPS.length - 1 ? EMP_DOC_STEPS[i + 1] : null;
}

/** A document is done when it is signed (or filed) — filing is housekeeping, not the candidate's act. */
export const empDocSigned = (status: string) => status === "signed" || status === "filed";

/* --------------------------------------------------- template rendering */

/** Fill {{placeholders}}. An unknown one is left visible, so a missing figure is seen, not silently blank. */
export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k: string) => (k in values ? values[k] : m));
}

export const TEMPLATE_FIELDS = [
  ["name", "Candidate’s full name"],
  ["first_name", "First name"],
  ["role", "Role title"],
  ["grade", "Grade"],
  ["location", "Location"],
  ["basic", "Basic a month"],
  ["ctc", "Total CTC a year"],
  ["components", "Other pay items, one per line"],
  ["incentive", "Incentive, in words"],
  ["incentive_slabs", "Incentive slabs, one per line"],
  ["growth_plan", "Growth ladder, one step per line"],
  ["joining_date", "Joining date"],
  ["effective_date", "Salary effective from"],
  ["today", "Today’s date"],
] as const;

/** Placeholders a body uses that the renderer does not know. */
export function unknownPlaceholders(body: string): string[] {
  const known = new Set<string>(TEMPLATE_FIELDS.map(([k]) => k));
  return [...new Set([...body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1]))].filter((k) => !known.has(k));
}

/* -------------------------------------------------------------- statuses */

export const ONBOARDING_STATUSES = [
  "selected",
  "compensation_discussion",
  "awaiting_acceptance",
  "accepted",
  "document_collection",
  "verification",
  "employment_documents",
  "courier_pending",
  "ready_to_provision",
  "assets_pending",
  "training",
  "training_completed",
  "onboarding_completed",
  "on_hold",
  "closed",
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_LABEL: Record<OnboardingStatus, string> = {
  selected: "Selected",
  compensation_discussion: "Compensation discussion",
  awaiting_acceptance: "Awaiting acceptance",
  accepted: "Accepted",
  document_collection: "Document collection",
  verification: "Verification",
  employment_documents: "Employment documents",
  courier_pending: "Courier pending",
  ready_to_provision: "Ready to provision",
  assets_pending: "Assets pending",
  training: "Training",
  training_completed: "Training completed",
  onboarding_completed: "Onboarding completed",
  on_hold: "On hold",
  closed: "Rejected / withdrawn",
};

/** The columns the onboarding board draws, in order. */
export const BOARD_COLUMNS: OnboardingStatus[] = [
  "compensation_discussion",
  "awaiting_acceptance",
  "document_collection",
  "verification",
  "employment_documents",
  "courier_pending",
  "ready_to_provision",
  "assets_pending",
  "training",
  "training_completed",
];

export type OnboardingFacts = {
  appStatus: string;
  /** The type of the stage they are at. */
  stageType: string;
  /** The application passed the gate (or is past it). */
  pastGate: boolean;
  offer: { status: string; approvalStatus: string } | null;
  docs: { mandatoryOpen: number; requestedOpen: number; underReview: number };
  bgv: { required: boolean; status: string } | null;
  empDocs: { required: number; signed: number };
  courier: ReturnType<typeof courierOverall>;
  assets: { applicable: number; issued: number; acknowledgedNeeded: number; acknowledged: number };
  training: { enrolled: boolean; required: number; passed: number } | null;
  onboardingCompleted: boolean;
};

/**
 * Where somebody is in the PRD's flow, read off their records. The order of
 * the checks is the order of the flow, so the first unmet step is the answer.
 */
export function onboardingStatus(f: OnboardingFacts): OnboardingStatus {
  if (f.appStatus === "on_hold") return "on_hold";
  if (!["in_progress", "hired"].includes(f.appStatus)) return "closed";
  if (f.onboardingCompleted) return "onboarding_completed";
  if (f.appStatus === "hired") {
    if (f.assets.issued < f.assets.applicable || f.assets.acknowledged < f.assets.acknowledgedNeeded) return "assets_pending";
    if (f.training && f.training.enrolled) return f.training.passed >= f.training.required ? "training_completed" : "training";
    return "assets_pending";
  }
  if (!f.pastGate) return "selected";
  if (!f.offer || f.offer.status === "draft" || f.offer.status === "withdrawn") return f.offer ? "compensation_discussion" : "selected";
  if (f.offer.status === "issued") return "awaiting_acceptance";
  if (f.offer.status !== "accepted") return "closed";
  if (f.stageType === "compensation") return "accepted";
  if (f.docs.mandatoryOpen > 0 && f.docs.underReview === 0) return "document_collection";
  if (f.docs.mandatoryOpen > 0 || (f.bgv?.required && !["clear", "not_applicable"].includes(f.bgv.status))) return "verification";
  if (f.empDocs.signed < f.empDocs.required) return "employment_documents";
  if (f.courier !== "not_required" && f.courier !== "completed") return "courier_pending";
  return "ready_to_provision";
}
