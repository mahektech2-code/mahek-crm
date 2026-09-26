/**
 * Types for the Sales Manager Lead Pipeline screen set.
 *
 * THESE ARE THE SHAPES THE SCREENS DRAW, not a second data model. Every value
 * is read off the real CRM records by `sales-manager-pipeline-service.ts`, which
 * is the one place a `customers` row, a sample, a verification call and a
 * timeline become a `Lead`. Nothing here is stored anywhere: the database is the
 * source of truth, and a screen holds only what it was handed plus the text
 * somebody is typing into a form.
 *
 * The shape is the prototype's on purpose (the UI is the design target); what
 * changed is where each field comes from. People are carried as a display NAME
 * and, where a form has to post it back, a real user ID beside it.
 */

export type SalesType = "direct" | "third_party" | "distributor";

/**
 * A lead's rung. The eighteen are the three ladders'; the five after them are
 * the LEGACY ladder a lead raised before the funnel existed still climbs (no
 * sales type chosen). `lost` is not a stage here: a lost lead keeps the rung it
 * was lost at and carries `lost`, exactly as the calling desk draws it.
 */
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
  | "active_distributor"
  | "new"
  | "contacted"
  | "qualified"
  | "won"
  | "on_hold";

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

export type TimelineEntry = {
  d: string;
  kind: "system" | "sales_manager" | "salesman";
  title: string;
  meta?: string;
};

export type ChaseStep = { label: string; d: string; done: boolean };

export type Sample = {
  /** The real `mbos_samples` id — what the sample actions are posted against. */
  id: string;
  state: SampleState;
  quantity?: string;
  reason?: string;
  courier?: string;
  docket?: string;
  promisedDeliveryAt?: string;
  requestedAt?: string;
  dispatchedAt?: string;
  receivedAt?: string;
  /** Where the approval stands: the sample cannot go out until it is approved. */
  approvalState?: string;
  feedbackRecorded: boolean;
  feedback?: string;
  trialOutcome: TrialOutcome;
  chase: ChaseStep[];
};

/**
 * A commitment is a FORECAST: a day, and a size (cans) or a value. Never a sale.
 * `confirmed` is the real §3.4 rule — a day with no size is a follow-up, not a
 * commitment.
 */
export type Commitment = {
  expectedOrderDate: string;
  cans?: number;
  valuePaise?: number;
  confirmed: boolean;
};

/** A real order on the account, as `orders` holds it. Status is Accounts', not ours. */
export type Order = {
  id: string;
  orderNo?: string;
  amountPaise: number;
  orderedAt: string;
  status: string;
  billNo?: string;
};

export type Lost = { reason: string; reasonLabel: string; by: string; date: string; note?: string };

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
  creditLimitRequestedPaise?: number;
  creditDaysRequired?: number;
  proposedTerritory?: string;
  /**
   * The AGREED commercial terms, recorded by `agreeCommercialTerms`. The profile
   * has no "discount requested" column — the terms are a single negotiated
   * figure — so this is what the prototype's "Discount" row now shows.
   */
  agreedDiscountPercent?: number;
  agreedCreditLimitPaise?: number;
  exclusivityGranted?: boolean;
  termsNote?: string;
  termsAgreedAt?: string;
};

/** One step of the two-step appointment chain, as `mbos_approvals` holds it. */
export type ApprovalStepView = {
  id: string;
  stepIndex: number;
  state: string;
  routeReason?: string;
  requestedBy?: string;
  requestedAt: string;
  approver?: string;
  decidedAt?: string;
  note?: string;
};

export type VerificationCorrection = {
  field: string;
  original: string;
  corrected: string;
  reason: string;
  changedBy?: string;
  at?: string;
};

export type Verification = {
  done: boolean;
  result: VerificationResult | null;
  visitedConfirmed?: boolean;
  explainedWell?: boolean;
  currentProduct?: string;
  competitor?: string;
  impression?: string;
  genuineInterest?: boolean;
  priceConcern?: boolean;
  qualityConcern?: boolean;
  creditConcern?: boolean;
  /** One real question covers both — "any concern about delivery or service?". */
  serviceConcern?: boolean;
  competitorConcern?: boolean;
  readyForTrial?: boolean;
  readyForCommercial?: boolean;
  readyForOrder?: boolean;
  /** Who rang, and when — from the call itself. */
  by?: string;
  at?: string;
  followUpNote?: string;
};

/** One line of the qualification checklist, read off the real gate engine. */
export type QualItem = {
  id: string;
  says: string;
  done: boolean;
  /**
   * True where the checklist stores a tick. False where the fact is a VALUE
   * elsewhere on the lead (the GST number, credit days, the application) —
   * ticking a box beside an empty field is the state the gate engine exists to
   * prevent, so those are shown as answered or not and never toggled.
   */
  tickable: boolean;
};

/** What the manager's review of the salesman's checklist says. */
export type QualReview = {
  verdict: "verified" | "incomplete" | "clarification";
  note?: string;
  by?: string;
  at?: string;
};

/**
 * What the Sales Manager can do next about this lead, decided on the SERVER
 * from the lead's real state and the real gate engine — never derived in the
 * browser from a stage name. A button is drawn from this and disabled from it,
 * and the action behind it re-checks everything, because a screen is not a rule.
 */
export type GateAction =
  | { kind: "visit"; label: string }
  | { kind: "verify"; label: string }
  | { kind: "awaitingVerification"; label: string }
  | { kind: "moveToQualification"; label: string; to: Stage; disabled: boolean; note?: string }
  | { kind: "qualify"; label: string; note?: string }
  | { kind: "requestSample"; label: string; disabled: boolean; note?: string }
  | { kind: "awaitingSampleApproval"; label: string }
  | { kind: "approveSample"; label: string; disabled: boolean; note?: string }
  | { kind: "markDispatched"; label: string; disabled: boolean; note?: string }
  | { kind: "markReceived"; label: string; disabled: boolean; note?: string }
  | { kind: "sampleReview"; label: string; disabled: boolean; note?: string }
  | { kind: "moveToNegotiation"; label: string; to: Stage; disabled: boolean; note?: string }
  | { kind: "askOrder"; label: string }
  | { kind: "confirmOrder"; label: string; note: string; disabled: boolean }
  | { kind: "submitManagement"; label: string; disabled: boolean; note?: string }
  | { kind: "agreeTerms"; label: string; disabled: boolean; note?: string }
  | { kind: "decideDistributor"; label: string; disabled: boolean; note?: string }
  | { kind: "awaitingManagement"; label: string }
  | { kind: "confirmAgreement"; label: string; disabled: boolean; note?: string }
  | { kind: "recordInitialStock"; label: string; to: Stage; disabled: boolean; note?: string }
  /** A plain move up a rung the back office or the ledger drives (dispatch, delivery, payment, second order). */
  | { kind: "moveOn"; label: string; to: Stage; disabled: boolean; note?: string }
  | { kind: "closed"; label: string }
  | { kind: "none"; label?: string };

/** What THIS viewer's existing capabilities let them do — the real ones, asked once on the server. */
export type Caps = {
  canWork: boolean;
  canVerify: boolean;
  canApproveSample: boolean;
  canCaptureOrder: boolean;
  /** `distributor.terms` — the sales manager's step: agree terms, clear or send back at step one. */
  canDistributorTerms: boolean;
  /** `distributor.approve` — management's step. A sales manager may recommend and may not appoint. */
  canApproveDistributor: boolean;
};

export type Lead = {
  /** The customer id: the real record, and what every action is posted against. */
  id: string;
  name: string;
  city?: string;
  contact?: string;
  phone?: string;
  email?: string;
  address?: string;
  source?: string;
  createdAt: string;
  /** Null is a lead raised before a ladder was chosen — drawn on the legacy ladder, never guessed. */
  salesType: SalesType | null;
  stage: Stage;
  priority: Priority;
  /** The salesman who owns it, by name; empty where nobody does. */
  owner: string;
  ownerId: string | null;
  /** The lead manager seat, by name; empty where nobody holds it. */
  manager: string;
  managerId: string | null;
  productId?: string;
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
  /** `leads.suspectMaxVisits` — the visits a Suspect gets before an answer is demanded. */
  suspectCap: number;
  /** §4 — the window has run out and Prospect-or-not is being DEMANDED. */
  mustDecide: boolean;
  /** The coded reason recorded on the transition that made this lead a Prospect. */
  conversionReason?: string;
  verification: Verification;
  verificationCorrections?: VerificationCorrection[];
  qualItems: QualItem[];
  qualReview?: QualReview;
  sample?: Sample;
  commitment?: Commitment;
  /** Real orders on this account, newest first. Empty until somebody has ordered. */
  orders: Order[];
  /** The salesman's own words (`customers.lead_notes`), read-only here. */
  salesmanNotes?: string;
  lost?: Lost;
  nextAction?: string;
  nextActionDate?: string;
  nextActionResp?: string;
  nextActionOwnerId?: string | null;
  expectedOutcome?: string;
  distributorProfile?: DistributorProfile;
  /** The open management approval on a distributor candidate, if one is waiting. */
  approval?: { id: string; stepIndex: number; state: string; reason?: string };
  /** Every step of the appointment chain, oldest first. Empty on a shop. */
  approvalSteps: ApprovalStepView[];
  /** Leads with the appointment thresholds: what forces a second signature. */
  approvalThresholds?: { discountPercent: number; creditLimitPaise: number };
  distributorSalesman?: string;
  distributor?: string;
  /** How often each communication action has gone, over the WHOLE history (a count from SQL, never from a capped list). */
  comms: Record<string, number>;
  /**
   * The current published document behind each "send" button, by action code. A
   * button whose category has nothing published is ABSENT here, and the screen
   * says so rather than drawing one that fails when pressed — `recordCommunication`
   * refuses a send that names no document.
   */
  commDocs: Record<string, { id: string; title: string }>;
  timeline: TimelineEntry[];
  /** True when the lead was raised by the calling desk and is waiting on this manager's verification. */
  deskRequest?: boolean;
  gate: GateAction;
  caps: Caps;
};

export type ModalKind =
  | "convert"
  | "verify"
  | "qualify"
  | "requestSample"
  | "approveSample"
  | "dispatchSample"
  | "sampleReview"
  | "askOrder"
  | "confirmOrder"
  | "lost"
  | "reassign"
  | "nextaction"
  | "distributorTerms"
  | "distributorDecide"
  | null;

/* ------------------------------------------------------------------ list */

/** One row of the lead list, dashboard focus and attention lists: the columns the screens draw, no more. */
export type PipelineRow = {
  id: string;
  name: string;
  city?: string;
  contact?: string;
  salesType: SalesType | null;
  /** Null for a lost lead: its rung is a per-lead read the list does not pay for, and a Lost badge replaces it. */
  stage: Stage | null;
  lost: boolean;
  priority: Priority;
  owner: string;
  product?: string;
  monthlyLitres?: number;
  potentialPaise?: number;
  nextAction?: string;
  nextActionDate?: string;
  nextActionResp?: string;
  /** What the manager can do next — a short label for the focus list. */
  gateLabel?: string;
};

export type BookTiles = {
  mine: number;
  today: number;
  overdue: number;
  suspects: number;
  prospects: number;
  sample: number;
  negotiation: number;
  expected: number;
  lost30: number;
};

export type ManagerKpis = {
  pendingVerification: number;
  verifiedProspects: number;
  verificationFailed: number;
  sampleReviewsPending: number;
  negotiationsPending: number;
  awaitingActualOrder: number;
  expectedThisWeek: number;
};

export type FunnelBar = { stage: Stage; label: string; count: number };

export type DashboardData = {
  today: string;
  greeting: string;
  book: BookTiles;
  manager: ManagerKpis;
  funnel: FunnelBar[];
  attention: PipelineRow[];
  focus: PipelineRow[];
};

export type ListData = {
  rows: PipelineRow[];
  total: number;
  listTotal: number;
  page: number;
  pageCount: number;
  perPage: number;
  book: BookTiles;
};

export type PipelineFunnelData = {
  direct: FunnelBar[];
  distributor: FunnelBar[];
};

/* ------------------------------------------------------- reference data */

export type Coded = { code: string; label: string };
export type Person = { id: string; name: string };

/**
 * The lists a dialog offers, read from configuration and the real user tables
 * on the server. A manager rewording a lost reason changes it here without a
 * deploy, which is why none of it is typed into a screen any more.
 */
export type PipelineRefs = {
  lostReasons: Coded[];
  /** What a verification call FOUND when it closes a lead — `leads.verificationFailureReasons`. */
  failureReasons: Coded[];
  prospectReasons: Coded[];
  sampleReasons: Coded[];
  orderBlockers: Coded[];
  /** Salesmen a lead can be given to — the people who hold the Salesman App. */
  salesmen: Person[];
  /** People a next action can be owed by. */
  actionOwners: Person[];
  /** The viewer, for the greeting and default owners. */
  me: Person;
};
