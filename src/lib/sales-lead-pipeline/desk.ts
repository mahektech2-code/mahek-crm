import type { DeskQueue, DeskRow } from "./types";

/* ---------------------------------------------------------------------------
 * THE SALES MANAGER DESK'S ARITHMETIC — pure and client-safe.
 *
 * The server sends every live lead in the book once, lean, and the browser
 * filters and groups what it was sent, exactly as the Telecaller's desk does.
 * Because the tiles, the salesman sections and the list are all computed from
 * the same rows by the same functions here, "a tile that says 14 opens a list
 * of 14" stays true after any filter changes.
 *
 * It decides no business rule. Which queue a lead is in was decided on the
 * server from the real queue readers; this only counts and groups.
 * ------------------------------------------------------------------------- */

export type DeskView = "all" | DeskQueue;

export const DESK_VIEWS: DeskView[] = ["all", "verify", "review", "sample", "order", "overdue", "nurture"];

export const QUEUE_LABEL: Record<DeskQueue, string> = {
  verify: "Verify prospect",
  review: "Qualification review",
  sample: "Sample",
  order: "Order confirmation",
  overdue: "Overdue",
  nurture: "Nurture task",
};

export const QUEUE_HELP: Record<DeskQueue, string> = {
  verify: "Prospects, and calling-desk requests, waiting for your verification call.",
  review: "Qualifications the Telecaller has completed and asked you to review.",
  sample:
    "Sample requests to approve, approved samples to dispatch, samples on the road to chase, and trials the shop has but nobody has reviewed.",
  order: "Expected orders on file that have not become an actual order yet.",
  overdue: "Leads whose next action date has passed.",
  nurture: "Leads with a nurture task due today or past its day — what the sequence has asked you to do.",
};

export function parseDeskView(raw: string | null | undefined): DeskView {
  return DESK_VIEWS.includes(raw as DeskView) ? (raw as DeskView) : "all";
}

export function inView(row: DeskRow, view: DeskView): boolean {
  return view === "all" || row.queues.includes(view);
}

export function queueCounts(rows: DeskRow[]): Record<DeskQueue, number> & { all: number } {
  const counts = { all: rows.length, verify: 0, review: 0, sample: 0, order: 0, overdue: 0, nurture: 0 };
  for (const r of rows) for (const q of r.queues) counts[q] += 1;
  return counts;
}

export type DeskFilter = { view: DeskView; q: string; salesmanId: string };

function matches(row: DeskRow, q: string): boolean {
  if (!q) return true;
  const hay = [row.name, row.city, row.contact, row.owner, row.product, row.nextAction, row.nextActionResp]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/** The sentinel group for a lead nobody owns: said in words, never dropped. */
export const NO_SALESMAN = "none";

export type SalesmanGroup = {
  /** `owner_id`, or {@link NO_SALESMAN}. */
  id: string;
  name: string;
  rows: DeskRow[];
  counts: Record<DeskQueue, number> & { all: number };
};

/** Overdue and queued work first, then by the day the next action is due, undated last. */
function byUrgency(a: DeskRow, b: DeskRow): number {
  const qa = a.queues.length ? 0 : 1;
  const qb = b.queues.length ? 0 : 1;
  if (qa !== qb) return qa - qb;
  const da = a.nextActionDate ?? "9999-99-99";
  const db = b.nextActionDate ?? "9999-99-99";
  return da === db ? a.name.localeCompare(b.name) : da < db ? -1 : 1;
}

/**
 * Group the rows that pass the filter by the salesman who owns them. The
 * counts on each group are over what the group holds AFTER the filter, so a
 * section header never promises more than its list shows.
 */
export function groupBySalesman(rows: DeskRow[], filter: DeskFilter): SalesmanGroup[] {
  const groups = new Map<string, SalesmanGroup>();
  for (const row of rows) {
    if (!inView(row, filter.view) || !matches(row, filter.q)) continue;
    const id = row.ownerId ?? NO_SALESMAN;
    if (filter.salesmanId && filter.salesmanId !== id) continue;
    let g = groups.get(id);
    if (!g) {
      g = { id, name: row.ownerId ? row.owner || "Unnamed salesman" : "No salesman yet", rows: [], counts: queueCounts([]) };
      groups.set(id, g);
    }
    g.rows.push(row);
  }
  const list = [...groups.values()];
  for (const g of list) {
    g.rows.sort(byUrgency);
    g.counts = queueCounts(g.rows);
  }
  const work = (g: SalesmanGroup) => g.counts.verify + g.counts.review + g.counts.sample + g.counts.order + g.counts.overdue;
  return list.sort((a, b) => {
    if (a.id === NO_SALESMAN) return 1;
    if (b.id === NO_SALESMAN) return -1;
    return work(b) - work(a) || a.name.localeCompare(b.name);
  });
}

/** The salesmen present in the book, for the filter box — independent of the current filter. */
export function salesmenIn(rows: DeskRow[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    const id = r.ownerId ?? NO_SALESMAN;
    if (!seen.has(id)) seen.set(id, r.ownerId ? r.owner || "Unnamed salesman" : "No salesman yet");
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------------------------------------------------------------------
 * WHY AN ACTION IS SWITCHED OFF — said in words, from the capabilities the
 * server already resolved (`Lead.caps`).
 *
 * This grants nothing and decides nothing: every action behind a button still
 * asks `requireCapability` for itself. It exists so that a Sales Manager whose
 * account lacks `lead.verify` or `sample.approve` is told so on the screen,
 * instead of pressing a button and being refused by the server.
 * ------------------------------------------------------------------------- */

export type DeskCaps = {
  canWork: boolean;
  canVerify: boolean;
  canApproveSample: boolean;
  canCaptureOrder: boolean;
};

export type DeskReasonFacts = {
  stage: string;
  lost: boolean;
  deskRequest: boolean;
  verified: boolean;
  sampleState: string | null;
  gateKind: string;
};

export function disabledReasons(caps: DeskCaps, f: DeskReasonFacts): string[] {
  if (f.lost) return [];
  const out: string[] = [];
  if (!caps.canVerify) {
    if (f.gateKind === "awaitingVerification" || ((f.stage === "prospect" || f.stage === "contacted") && !f.verified)) {
      out.push("Verify prospect is switched off: it needs the lead.verify permission, or to be the Sales Manager this lead is under, which your account is not.");
    }
    if (f.stage === "qualification" || f.stage === "qualified") {
      out.push("Reviewing the qualification is switched off: it needs the lead.verify permission, which your account does not hold.");
    }
  }
  if (!caps.canApproveSample && f.sampleState === "requested") {
    out.push("Approving the sample is switched off: it needs the sample.approve permission, which your account does not hold.");
  }
  if (!caps.canCaptureOrder && f.gateKind === "confirmOrder") {
    out.push("Confirming the actual order is switched off: it needs the order.capture permission, which your account does not hold.");
  }
  if (!caps.canWork) {
    out.push("You can read this lead, but changing it needs the lead.work permission, which your account does not hold.");
  }
  return out;
}
