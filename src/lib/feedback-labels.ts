/* ---------------------------------------------------------------------------
 * The vocabulary of feedback: pure, and client-safe.
 *
 * A stored enum is not a label. `in_progress` reaching a screen unchanged is
 * the same fault `packaging_damage` was, and the form that WRITES these runs
 * in the browser — so the way from a stored value to a sentence cannot live
 * beside a `server-only` import.
 * ------------------------------------------------------------------------- */

export const FEEDBACK_KINDS = ["bug", "suggestion", "feature", "question"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_STATUSES = ["new", "in_progress", "done", "declined"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** What each kind is called on a form, where the person is choosing one. */
export const KIND_LABELS: Record<FeedbackKind, string> = {
  bug: "Something is broken",
  suggestion: "Suggestion",
  feature: "Feature request",
  question: "Question",
};

/** The short form, for a badge in a table where the row says the rest. */
export const KIND_SHORT: Record<FeedbackKind, string> = {
  bug: "Bug",
  suggestion: "Suggestion",
  feature: "Feature",
  question: "Question",
};

export const STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: "New",
  in_progress: "Being looked at",
  done: "Done",
  declined: "Not doing",
};

/** What the reporter reads under each kind on the form. */
export const KIND_HINTS: Record<FeedbackKind, string> = {
  bug: "Wrong number, an error, or a button that won't work",
  suggestion: "It works, but it could be quicker",
  feature: "MahekOne doesn't do it yet",
  question: "How do I… / why does it…",
};

/** The form's titles for each kind — shorter than KIND_LABELS reads in a tile. */
export const KIND_TILES: Record<FeedbackKind, string> = {
  bug: "Something is broken",
  suggestion: "An idea to make it easier",
  feature: "Something new",
  question: "A question",
};

/* -------------------------------------------------------------------- impact */

/**
 * How much it is getting in the way, in the reporter's own judgement. Asked
 * for a fault only: an idea does not stop anybody working.
 */
export const FEEDBACK_IMPACTS = ["blocking", "slows", "minor"] as const;
export type FeedbackImpact = (typeof FEEDBACK_IMPACTS)[number];

export const IMPACT_LABELS: Record<FeedbackImpact, string> = {
  blocking: "I can't do my work",
  slows: "It slows me down",
  minor: "A small thing",
};

export const IMPACT_SHORT: Record<FeedbackImpact, string> = {
  blocking: "Can't work",
  slows: "Slows them down",
  minor: "Small thing",
};

/* ------------------------------------------------------------------- verdict */

/** The reporter's answer once triage says Done. */
export const FEEDBACK_VERDICTS = ["fixed", "still_happening"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

/** "FB-1042" — the number people say out loud. */
export function feedbackRef(n: number): string {
  return `FB-${n}`;
}

/**
 * Where a report stands from the REPORTER's side, in the order the progress
 * line draws it: sent, seen, being looked at, done, and — the step that only
 * they can take — confirmed. Pure, so the menu, the page and the console draw
 * the same step from the same fields.
 */
export type FeedbackStage = "sent" | "seen" | "looking" | "done" | "confirmed" | "declined";

export function feedbackStage(r: {
  status: FeedbackStatus;
  /** Anybody on the team has said or done anything on it. */
  seen: boolean;
  verdict: FeedbackVerdict | null;
}): FeedbackStage {
  if (r.status === "declined") return "declined";
  // Done CLOSES it — Mahek's decision, Nov 2026: nobody waits on the reporter
  // to confirm. Their "yes" is recorded as thanks; their "still happening"
  // reopens it (`answerFix`), which is the only answer that changes anything.
  if (r.status === "done") return r.verdict === "fixed" ? "confirmed" : "done";
  if (r.status === "in_progress") return "looking";
  return r.seen ? "seen" : "sent";
}

/** The pill the reporter sees — what they would say the report is doing. */
export const STAGE_LABELS: Record<FeedbackStage, string> = {
  sent: "Sent",
  seen: "Seen",
  looking: "Being looked at",
  done: "Done",
  confirmed: "Fixed — you confirmed",
  declined: "Not doing",
};

/* ------------------------------------------------------------- triage queues */

/**
 * The console's queues, in the order they are worked. Each report sits in
 * exactly one of the first four; "all" is every report.
 *
 * - reply:   open, and the last word the reporter can read is theirs (or
 *            nobody has said anything) — triage owes them.
 * - waiting: open, and the last word is a REPLY from triage — the reporter owes
 *            us an answer.
 * - looking: open, and the last thing triage did was move it along without
 *            asking anything — the work is ours, nobody owes a message.
 * - closed:  Done or Not doing. Done closes a report outright; a reporter who
 *            says it is still happening reopens it, and it comes back as owed.
 */
export const TRIAGE_QUEUES = ["reply", "waiting", "looking", "closed", "all"] as const;
export type TriageQueue = (typeof TRIAGE_QUEUES)[number];

export const QUEUE_LABELS: Record<TriageQueue, string> = {
  reply: "Needs a reply",
  waiting: "Waiting on them",
  looking: "Being looked at",
  closed: "Closed",
  all: "Everything",
};

export function triageQueue(r: {
  status: FeedbackStatus;
  /** The last line the REPORTER can read came from them, or there is none. */
  awaitingReply: boolean;
  /** That last line is a written reply from triage, not only a status change. */
  teamAsked: boolean;
}): Exclude<TriageQueue, "all"> {
  if (r.status === "declined" || r.status === "done") return "closed";
  if (r.awaitingReply) return "reply";
  return r.teamAsked ? "waiting" : "looking";
}

/**
 * The first line of what somebody said, as a heading. The form no longer asks
 * for a title separately — "the first line becomes the title" — and an empty
 * line, a heading made of a bullet, or a 3,000-character first line all have to
 * come out as something a list can show.
 */
export function titleFromBody(body: string): string {
  const line =
    body
      .split(/\r?\n/)
      .map((l) => l.replace(/^[\s\-*•·#>]+/, "").trim())
      .find((l) => l.length > 0) ?? "";
  if (line.length <= 90) return line;
  const cut = line.slice(0, 90);
  const space = cut.lastIndexOf(" ");
  return `${(space > 50 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/* ------------------------------------------------------- where it is read */

/**
 * The apps with a Feedback page of their own, under Support (or the app's
 * last group). Reading the answer happens INSIDE the app somebody is working
 * in — it used to be a page of its own outside every app, with nothing around
 * it, which read as having been thrown out of MahekOne.
 */
export const FEEDBACK_APP_PATHS = {
  crm: "/crm/feedback",
  accounts: "/accounts/feedback",
  sales: "/sales/feedback",
  erp: "/erp/feedback",
  hrms: "/hrms/feedback",
  founder: "/founder/feedback",
} as const;
export type FeedbackApp = keyof typeof FEEDBACK_APP_PATHS;

/**
 * Where "Your feedback" opens from the screen somebody is on: that app's own
 * Feedback page where it has one, and `/feedback` — which forwards to one of
 * theirs — anywhere else.
 */
export function feedbackHomeFor(pathname: string | null | undefined, rowId?: string): string {
  const first = (pathname ?? "").split("/").filter(Boolean)[0] as FeedbackApp | undefined;
  const base = first && first in FEEDBACK_APP_PATHS ? FEEDBACK_APP_PATHS[first] : "/feedback";
  return rowId ? `${base}?r=${rowId}` : base;
}
