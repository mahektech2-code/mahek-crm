/* ---------------------------------------------------------------------------
 * The shapes the factory app is drawn from. PURE and client-safe.
 *
 * The server builds these from the ERP's own masters, lots and orders
 * (`lib/factory/server.ts`), so nothing here is a second product master —
 * it is the ERP's answer, reshaped into what one phone screen needs.
 * ------------------------------------------------------------------------- */

export type Area = "head" | "mixing" | "filling" | "packing" | "dispatch" | "qc";
export type Proc = "mixing" | "filling" | "packing" | "dispatch";
export const PROCS: Proc[] = ["mixing", "filling", "packing", "dispatch"];

export type Emp = {
  /** The MahekOne user id. */
  key: string;
  n: string;
  /** Full mobile, digits only — only sent for the signed-in person's own record. */
  ph: string;
  /** "Mixing · machine operator" */
  role: string;
  area: Area;
  /** Employee code, e.g. MMI-0231. */
  id: string;
  /** What the badge QR says, when the person has one. */
  badge?: string;
  /** HR has not confirmed this name or role yet (PRD §5.1). */
  confirm?: boolean;
};

export type RawMaterial = { n: string; col: string; /** Short code drawn on the drum picture. */ code: string };
export type SfgProduct = {
  n: string;
  short: string;
  col: string;
  /** Litres one batch makes on the approved batch sheet. */
  batch: number;
  /** ± percent the output may differ before a supervisor has to look. */
  tol: number;
  /** [raw-material code, litres per batch] */
  recipe: [string, number][];
};
export type FgSku = {
  n: string;
  size: string;
  tag: string;
  /** Litres per can or drum. */
  l: number;
  kind: "can" | "drum";
  sfg: string;
  pm: string;
  col: string;
};
export type BoxSku = { sku: string; cpb: number; batch: number; type: string };
export type OrderLine = { sku: string; label: string; qty: number; unit: string; alloc: [string, number][] };
export type Order = { cust: string; city: string; vehicle: string; trans: string; blocked?: string; lines: OrderLine[] };

export type LotType = "rm" | "sfg" | "pm" | "fg" | "pb";
export type LotStatus = "ok" | "used" | "hold" | "shipped" | "incomplete";
export type Lot = {
  code: string;
  type: LotType;
  item: string;
  avail: number;
  loc: string;
  status: LotStatus;
  damaged?: boolean;
  order?: string;
};

export type Team = { owner: string | null; op: string | null; helpers: string[]; ver: string | null };

/** `held`: received from a phone but not in the ERP — with the Production Head. */
export type TaskStatus = "ready" | "pending" | "blocked" | "done" | "held";
export type TaskOut = { good: number; rej?: number; unit: string; lot?: string; at: string; open?: number };
export type Task = {
  id: string;
  proc: Proc;
  /** SFG code (mixing), FG SKU (filling), box SKU (packing). */
  item?: string;
  order?: string;
  batches?: number;
  target?: number;
  /** The SFG lot the filling sheet names. */
  sfg?: string;
  /** Boxes already in the open packing batch, and its code. */
  carry?: number;
  carryPb?: string;
  /** "HH:MM" */
  due: string;
  status: TaskStatus;
  team: Team;
  out?: TaskOut;
};

export type ReviewKind = "tolerance" | "manual" | "correction" | "attribution" | "issue" | "unposted";
export type ReviewItem = { id: string; kind: ReviewKind; task: string; title: string; text: string; meta: string; acts: string[] };
export type AuditRow = { task: string; at: string; who: string; t: string };

export type FactoryData = {
  /** "Ambernath Plant" */
  loc: string;
  locId: string | null;
  shift: string;
  /** "Friday, 9 October" */
  dateLine: string;
  /** When the server read this — the phone keeps the newest copy it has for working offline. */
  at: string;
  emp: Record<string, Emp>;
  teams: Record<Proc, Team>;
  hours: Record<string, number>;
  rm: Record<string, RawMaterial>;
  sfg: Record<string, SfgProduct>;
  sku: Record<string, FgSku>;
  pm: Record<string, string>;
  box: Record<string, BoxSku>;
  orders: Record<string, Order>;
  lots: Record<string, Lot>;
  tasks: Task[];
  review: ReviewItem[];
  audit: AuditRow[];
  down: Record<string, number>;
  dup: number;
  corr: number;
};

/* ------------------------------------------------------------ the draft */

export type RmLine = { item: string; per: number; lot: string | null; qty: number | null; manual?: boolean };
export type Draft = {
  team: Team;
  down: boolean | null;
  downR: string | null;
  downMin: number | null;
  batches?: number;
  rm?: RmLine[];
  out?: number | null;
  sku?: string;
  sfg?: string | null;
  sfgManual?: boolean;
  pm?: string | null;
  pmManual?: boolean;
  filled?: number | null;
  rej?: number;
  rejR?: string | null;
  box?: string;
  fg?: { lot: string; manual?: boolean }[];
  boxes?: number | null;
  loads?: Record<string, number | null>;
  /** Lots on the lorry that were picked from photos rather than scanned. */
  loadsManual?: Record<string, boolean>;
  checks?: Record<string, boolean>;
  photo?: string | null;
  photoId?: string | null;
};

/**
 * The shape the phone sends. Bumped whenever a field is added, renamed or
 * re-meant — and `normalizeDraft` (rules.ts) keeps reading EVERY version
 * there has been, because a phone that saved work on Monday on an old page
 * still sends it on Wednesday, after two deploys.
 */
export const SUBMISSION_VERSION = 2;

/** What the phone sends. `key` is the idempotency key: one key, one posting. */
export type Submission = {
  key: string;
  taskId: string;
  d: Draft;
  /** "HH:MM" on v1; an ISO instant from v2 — the moment the work was saved on the phone. */
  savedAt: string;
  v?: number;
  /** The page build that sent it. */
  build?: string;
  /** Sent from the phone's queue rather than by a person waiting on the screen. */
  queued?: boolean;
  /** The worker chose "Send to supervisor" over fixing it now. */
  toSupervisor?: boolean;
};

/** How long a phone keeps work it could not send, and the server still posts it as ordinary work. */
export const OFFLINE_HOURS = 48;

export type SubmitResult =
  | { kind: "done"; key: string; task: string; proc: Proc; rows: [string, string][]; label: { code: string; name: string; meta: string } | null; msg: string; replay?: boolean }
  /** Something the worker can put right now, on the screen, before it is saved. */
  | { kind: "failed"; key: string; title: string; text: string; fix: string; step: string | null }
  /** Received, safe, and with the Production Head — not in the ERP yet. */
  | { kind: "held"; key: string; task: string; proc: Proc; title: string; text: string; replay?: boolean }
  /** Not received: the phone keeps it and sends again by itself. Never shown as an error. */
  | { kind: "retry"; key: string; why: string };

/* The machine-stop reasons and damage reasons, as the design lists them. */
export const DOWN: [string, string][] = [
  ["Breakdown", "wrench"],
  ["No material", "box"],
  ["Power cut", "bolt"],
  ["Cleaning", "drop"],
  ["Changing product", "sync"],
  ["Waiting for quality", "clock"],
];
export const REJ = ["Leaking", "Dented", "Not full", "Label wrong"];
export const CHECK_ITEMS: [string, string][] = [
  ["seal", "Every drum and box is sealed"],
  ["labels", "Labels match the order"],
  ["clean", "No leaks, truck is clean and dry"],
  ["papers", "Bill and challan are in the truck"],
];

export const STEPS: Record<Proc, string[]> = {
  mixing: ["identify", "team", "materials", "output", "review"],
  filling: ["identify", "team", "sfg", "pack", "count", "review"],
  packing: ["identify", "team", "fglot", "boxes", "review"],
  dispatch: ["order", "load", "checklist", "team", "review"],
};
