/* ---------------------------------------------------------------------------
 * WHAT A PRICE BOOK SCREEN IS HANDED — view types only, pure and client-safe.
 *
 * The services that fill these are `server-only`; the screens that read them
 * run in a browser. Money is paise, dates are ISO strings.
 * ------------------------------------------------------------------------- */

import type { PriceFreightTerm, PriceChangeNotify, PriceChangeSource } from "@/db/schema";
import type { CellDiff, ChangeCounts, ChangeFlag, ChangeRate, ChangeStage, EffectRow } from "@/lib/engines/price-change";
import type { ValidityState } from "@/lib/engines/price-resolution";
import type { OverrideState } from "@/lib/engines/price-overrides";

export type BookState = "live" | "change_waiting" | "scheduled" | "expiring" | "expired" | "draft" | "retired";

export const BOOK_STATE_LABEL: Record<BookState, string> = {
  live: "Live",
  change_waiting: "Change waiting",
  scheduled: "Change scheduled",
  expiring: "Expiring",
  expired: "Past validity",
  draft: "Draft only",
  retired: "Retired",
};

export const BOOK_STATE_TONE: Record<BookState, "success" | "warning" | "info" | "neutral" | "danger"> = {
  live: "success",
  change_waiting: "warning",
  scheduled: "info",
  expiring: "warning",
  expired: "danger",
  draft: "neutral",
  retired: "neutral",
};

export type BookRevisionRef = { listId: string; version: number; effectiveFrom: string; effectiveTo: string | null };

export type BookRow = {
  id: string;
  name: string;
  kind: "standard" | "agreed";
  freightTerm: PriceFreightTerm;
  /** Who it covers, in words, off the revision in force (or the newest one). */
  scopeSummary: string;
  scopeCount: number;
  live: (BookRevisionRef & { expiresOn: string | null; validityState: ValidityState; rateCount: number }) | null;
  scheduled: BookRevisionRef | null;
  openChange: { id: string; stage: ChangeStage; title: string | null; makerName: string; goLive: string | null } | null;
  /** The newest version that is not withdrawn — what an edit starts from. */
  head: { listId: string; version: number; status: string } | null;
  revisions: number;
  /** Shops the book's revision in force prices today (it wins their resolution). */
  shops: number;
  state: BookState;
  updatedAt: string;
};

export type BookRevision = {
  listId: string;
  version: number;
  name: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  rateCount: number;
  documentId: string | null;
  createdByName: string | null;
  publishedAt: string | null;
  publishedByName: string | null;
  /** The change that made this revision, where it came through the book workflow. */
  change: { id: string; makerName: string | null; approverName: string | null; secondApproverName: string | null; reason: string | null } | null;
  /** live | scheduled | history | draft | withdrawn */
  role: "live" | "scheduled" | "history" | "draft" | "withdrawn";
};

export type BookEvent = {
  id: string;
  changeId: string;
  kind: string;
  actorName: string | null;
  note: string | null;
  at: string;
};

export type OverrideView = {
  id: string;
  customerId: string;
  customerName: string;
  productId: string;
  productName: string;
  rateExGstPaise: number;
  rateInclGstPaise: number;
  /** What the shop's book charges for it without the override, where known. */
  bookExGstPaise: number | null;
  bookName: string | null;
  validFrom: string;
  validTo: string | null;
  minCansPerMonth: number | null;
  /** Cans bought in the last whole month, against the condition. */
  lastMonthCans: number | null;
  state: OverrideState;
  requestId: string | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
};

export type ChangeSummaryRow = {
  id: string;
  bookId: string;
  bookName: string;
  title: string | null;
  stage: ChangeStage;
  makerName: string;
  goLive: string | null;
  changed: number;
  updatedAt: string;
};

export type BookDetail = {
  book: BookRow;
  revisions: BookRevision[];
  events: BookEvent[];
  changes: ChangeSummaryRow[];
  /** The revision drawn on the page: in force, else the newest. */
  shownListId: string | null;
};

export type ChangeAiReview = {
  provider: "openai" | "anthropic";
  label: string;
  ok: boolean;
  reason: string | null;
  summary: string | null;
  findings: ChangeFlag[];
  at: string | null;
};

export type ChangeView = {
  id: string;
  bookId: string;
  bookName: string;
  kind: "standard" | "agreed";
  status: string;
  stage: ChangeStage;
  source: PriceChangeSource;
  title: string | null;
  reason: string | null;
  goLive: string | null;
  notify: PriceChangeNotify;
  maker: { id: string; name: string };
  approver: { id: string; name: string } | null;
  secondApprover: { id: string; name: string } | null;
  needsSecond: boolean;
  approverNote: string | null;
  sendBackReason: string | null;
  cancelReason: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  baseList: { id: string; version: number; name: string; effectiveFrom: string; effectiveTo: string | null; status: string } | null;
  draftList: { id: string; version: number; name: string; status: string; effectiveFrom: string };
  gstBp: number;
  freightTerm: PriceFreightTerm;
  derived: boolean;
  base: ChangeRate[];
  draft: ChangeRate[];
  diffs: CellDiff[];
  counts: ChangeCounts;
  effect: { rows: EffectRow[]; totalPerMonthPaise: number; dropPerMonthPaise: number; months: number };
  /** Rules flags plus the AI reviewers' findings, as last checked. */
  flags: ChangeFlag[];
  acks: Record<string, { note: string; byName: string | null; at: string }>;
  checkedAt: string | null;
  checkStale: boolean;
  currentHash: string;
  reviews: ChangeAiReview[];
  secondOpinion: { provider: string; text: string; at: string } | null;
  events: BookEvent[];
  /** Shops the base revision prices today, and the team behind them. */
  shops: number;
  /** The families on the book, for the instruction box. */
  families: string[];
  /** Other books an edit may copy from. */
  otherBooks: Array<{ id: string; name: string; listId: string }>;
};

export const EVENT_LABEL: Record<string, string> = {
  created: "Started the change",
  edited: "Edited prices",
  instruction: "Applied an instruction",
  copied: "Copied prices from another book",
  checked: "Ran the check",
  ack: "Marked a flag as intended",
  submitted: "Sent for approval",
  sent_back: "Sent back",
  approved: "Approved",
  second_approved: "Approved (second)",
  scheduled: "Scheduled to go live",
  live: "Went live",
  date_moved: "Moved the go-live date",
  cancelled: "Cancelled",
  unscheduled: "Took a scheduled change off",
  notified: "Told the shops and the team",
  restored: "Started from an earlier revision",
  imported: "Started from an imported PDF",
  ai_review: "AI review",
  second_opinion: "Second opinion",
};
