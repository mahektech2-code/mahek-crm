/**
 * Types for the Sales Manager Lead Pipeline screen set.
 *
 * This module is entirely isolated from the real `customers`/leads schema in
 * `src/db/schema.ts`. It exists to back a mock, in-memory implementation of
 * the Sales Manager experience shown in the prototype
 * (https://claude.ai/artifact/55h5EhgTReQbiThhdhPxRU) while the real
 * data-model question is decided separately. Nothing here reads or writes
 * the database — see `mock-data.ts` for the seed data this feature runs on.
 */

export type SalesType = "direct" | "third_party" | "distributor";

export type Stage =
  | "suspect"
  | "prospect"
  | "qualification"
  | "sample_trial"
  | "sample_received"
  | "sample_review"
  | "negotiation"
  | "first_order"
  | "delivery"
  | "payment"
  | "second_order"
  | "customer"
  | "management_review"
  | "commercial_discussion"
  | "distributor_approval"
  | "distributor_agreement"
  | "initial_stock_order"
  | "active_distributor";

export type Priority = "high" | "medium" | "low" | null;

export type VerificationResult =
  | "verified"
  | "verified_with_corrections"
  | "followup_required"
  | "verification_failed";

export type TrialOutcome = "pending" | "approved" | "rejected" | "more_testing";

export type SampleState =
  | "requested"
  | "approved"
  | "rejected"
  | "dispatched"
  | "received"
  | "trial_done"
  | "reviewed"
  | "cancelled";

export type Person = {
  id: string;
  name: string;
  initials: string;
  role: "salesman" | "sales_manager" | "management";
};

export type TimelineEntry = {
  d: string;
  kind: "system" | "sales_manager" | "salesman";
  title: string;
  meta?: string;
};

export type ChaseStep = { label: string; d: string; done: boolean };

export type Sample = {
  state: SampleState;
  quantity?: string;
  reason?: string;
  courier?: string;
  docket?: string;
  promisedDeliveryAt?: string;
  dispatchedAt?: string;
  receivedAt?: string;
  feedbackRecorded: boolean;
  feedback?: string;
  trialOutcome: TrialOutcome;
  chase: ChaseStep[];
};

export type Negotiation = {
  quantity?: string;
  visitDone: boolean;
  blockers: string[];
  objection?: string;
};

export type Commitment = {
  quantity: string;
  expectedOrderDate: string;
  recordedBy: string;
  recordedAt: string;
};

export type Order = {
  amount: number;
  litres: number;
  orderedAt: string;
  reference?: string;
};

export type Lost = { reason: string; by: string; date: string };

export type DistributorProfile = {
  gstVerified: boolean;
  panVerified: boolean;
  addressVerified: boolean;
  businessType?: string;
  yearsInBusiness?: number;
  decisionMaker?: string;
  hasDealerNetwork: boolean;
  activeDealers?: number;
  territoryCovered?: string;
  salesTeamSize?: number;
  warehouse: boolean;
  storageCapacityLitres?: number;
  exclusivityRequested: boolean;
  discountRequested?: string;
  creditLimitRequestedPaise?: number;
};

export type VerificationCorrection = {
  field: string;
  original: string;
  corrected: string;
  reason: string;
  changedBy?: string;
  at?: string;
};

/**
 * The full set of answers behind a verification, not just its verdict —
 * matches the approved Verify modal (the salesman-findings review row per
 * field, then sections A/B/C/D) so the Overview tab's Verification Summary
 * can show what was actually established on the call, not only the
 * one-word result.
 */
export type Verification = {
  done: boolean;
  result: VerificationResult | null;
  visitedConfirmed?: boolean;
  explainedWell?: boolean;
  currentProduct?: string;
  competitor?: string;
  impression?: string;
  requirementGenuine?: boolean;
  genuineInterest?: boolean;
  realBuyingIntent?: boolean;
  priceConcern?: boolean;
  qualityConcern?: boolean;
  creditConcern?: boolean;
  deliveryConcern?: boolean;
  serviceConcern?: boolean;
  competitorConcern?: boolean;
  readyForTrial?: boolean;
  readyForCommercial?: boolean;
  readyForOrder?: boolean;
};

export type Lead = {
  id: string;
  name: string;
  city?: string;
  contact?: string;
  phone?: string;
  email?: string;
  address?: string;
  source?: string;
  createdAt: string;
  salesType: SalesType;
  stage: Stage;
  priority: Priority;
  owner: string; // salesman person id
  manager: string; // sales manager person id
  product?: string;
  application?: string;
  monthlyLitres?: number;
  potentialPaise?: number;
  competitor?: string;
  decisionMaker?: string;
  customerType?: string;
  gstin?: string;
  gstVerified: boolean;
  creditDaysWanted?: number;
  buyer?: string;
  visits: number;
  conversionReason?: string;
  verification: Verification;
  verificationCorrections?: VerificationCorrection[];
  qualChecks: Record<string, boolean>;
  sample?: Sample;
  negotiation?: Negotiation;
  commitment?: Commitment;
  order?: Order;
  lost?: Lost;
  nextAction?: string;
  nextActionDate?: string;
  nextActionResp?: string;
  expectedOutcome?: string;
  distributorProfile?: DistributorProfile;
  distributorSalesman?: string;
  distributor?: string;
  comms: Record<string, boolean>;
  timeline: TimelineEntry[];
};

export type ModalKind =
  | "convert"
  | "verify"
  | "qualify"
  | "requestSample"
  | "sampleReview"
  | "askOrder"
  | "confirmOrder"
  | "lost"
  | "reassign"
  | "nextaction"
  | null;
