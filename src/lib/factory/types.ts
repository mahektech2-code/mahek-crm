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
  /** Their home department. */
  area: Area;
  /** Every department they work in, when it is more than one. Absent on an older server, or for one department. */
  areas?: Area[];
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
/** `empty`: empty boxes one box takes (the ERP's empty_boxes_required); absent from an older server, read as 1. */
export type BoxSku = { sku: string; cpb: number; batch: number; type: string; empty?: number };
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
  /** SFG and FG lots: the day its newest entry was made (mixed, or filled), "YYYY-MM-DD". */
  made?: string;
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
  /** The transporters with goods to load at this godown, by lorry key. Absent from an older server. */
  lorries?: Record<string, Lorry>;
  /** Empty boxes at this godown, by box SKU — null where the ERP does not count that box type. Absent from an older server. */
  emptyBoxes?: Record<string, number | null>;
  tasks: Task[];
  review: ReviewItem[];
  audit: AuditRow[];
  down: Record<string, number>;
  dup: number;
  corr: number;
};

/* ------------------------------------------------------------ the draft */

/** One drum poured into a mixing batch. A material the sheet asks for more of than one drum holds is several lines of the same item, each its own lot — `extra` marks the ones the worker added, which are the only ones that can be taken off again. */
export type RmLine = { item: string; per: number; lot: string | null; qty: number | null; manual?: boolean; extra?: boolean };
export type Draft = {
  team: Team;
  down: boolean | null;
  downR: string | null;
  downMin: number | null;
  batches?: number;
  rm?: RmLine[];
  /** The worker replaced the batch sheet with his own recipe on the first step; `rm`'s `per` is then his, and the Production Head is told. */
  ownRecipe?: boolean;
  out?: number | null;
  sku?: string;
  sfg?: string | null;
  sfgManual?: boolean;
  /** The lot scanned on Home to start this job — the SFG tank of a filling, the first pallet of a packing. Phone-only. */
  fromLot?: string;
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
  /** The lorry this loading job is for — the job's own key, carried so a draft read on its own still says what it is. */
  lorry?: string;
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
  /* No "How much was made" step: the materials already match the sheet drum by drum, so what was made is what was poured. "output" stays a step key only so a draft from an older page still reads. */
  mixing: ["identify", "team", "materials", "review"],
  filling: ["identify", "team", "sfg", "pack", "count", "review"],
  packing: ["identify", "team", "fglot", "boxes", "review"],
  dispatch: ["order", "load", "checklist", "team", "review"],
};

/** A lorry's loading job: scan every box, who loaded, check and send — the transport was chosen on Home. */
export const LORRY_STEPS = ["load", "team", "review"];

/* ---------------------------------------------------------------- empty drums
 * EMPTY DRUM ENTRY: the phone scans a drum's GRN/lot label once the drum is
 * empty and sends its weight. The server decides everything — whose drum it
 * is, which drum of the lot, whether the weight is believable — and these are
 * the shapes it answers in (lib/erp/drums.ts does the work).
 * ------------------------------------------------------------------------- */

export type DrumLotView = {
  code: string;
  lotNo: string;
  material: string;
  supplier: string;
  pr: number;
  godown: string;
  ownership: "mahek" | "returnable" | null;
  ownershipLabel: string;
  declaredKg: number | null;
  /** Drums the GRN brought in; null where it recorded none. */
  drums: number | null;
  recorded: number;
  nextSeq: number;
  /** The last drum of this lot recorded empty, and whether that was recent enough to ask "a different drum?". */
  last: { seq: number | null; at: string; by: string | null } | null;
  recent: boolean;
};

export type DrumExisting = { label: string; seq: number | null; status: string; kg: number | null; at: string };

export type DrumLookup =
  | { ok: true; lot: DrumLotView; limits: { minKg: number; maxKg: number } }
  | { ok: false; title: string; text: string; fix: string; existing?: DrumExisting[] };

export type DrumSaved = {
  label: string;
  seq: number | null;
  drums: number | null;
  lotNo: string;
  material: string;
  supplier: string;
  statusLabel: string;
  ownership: "mahek" | "returnable" | null;
  declaredKg: number | null;
  actualKg: number;
  varianceKg: number | null;
  reviewReason: string | null;
};

export type DrumSave =
  | { ok: true; drum: DrumSaved; replay?: boolean }
  | { ok: false; kind: "confirm" | "weight" | "lot" | "notFound" | "signedOut" | "notAllowed"; title: string; text: string; fix: string; existing?: DrumExisting[] };

/* ---------------------------------------------------------------- loading boxes
 * A BOX LABEL ON THE LORRY. Packing prints a label per box (BX-…), and the
 * ERP's Dispatch desk counts a box onto an order only when it is scanned. The
 * loader scans it here instead of at the desk: the phone sends the code, the
 * ERP's own `scanOntoOrder` judges it and writes it (lib/factory/dispatch.ts),
 * so a box counted on the lorry is a box counted on the desk — one count.
 * ------------------------------------------------------------------------- */

export type LoadedBox = { id: string; lot: string; sku: string; at: string | null; by: string | null };

/** The order's boxes as the ERP holds them: every one scanned onto it, and how many per lot. */
export type LoadBoard = { order: string; boxes: LoadedBox[]; perLot: Record<string, number> };

/* ---------------------------------------------------------------- loading a lorry
 * LOADING IS BY TRANSPORTER, ITEM BY ITEM. A transporter's lorry takes the
 * goods of every Ready order typed with that transporter; the loader scans
 * what goes on and the server picks the order each box goes onto — one
 * whose allocated lot the box is from, then the soonest due — before the
 * ERP's Dispatch desk judges it there (lib/factory/lorry.ts). The loader
 * never picks an order and never sees one.
 * ------------------------------------------------------------------------- */

/** One item on a lorry: one SKU, added up over every order going with that transporter. */
export type LorryItem = {
  sku: string;
  label: string;
  /** "boxes" or "cans" — what is counted. */
  unit: string;
  target: number;
  loaded: number;
  /** How many orders want it. */
  orders: number;
  late: boolean;
  notBilled: boolean;
  /** Stock with no box ids: the lot label is scanned instead of each box. */
  byLot: boolean;
};

export type Lorry = {
  /** "L:" + the transporter's name folded (spacing and capitals ignored); "L:" alone is no transporter named. */
  key: string;
  /** As typed on the order; null when nobody typed one. */
  name: string | null;
  items: LorryItem[];
  target: number;
  loaded: number;
  /** Orders it covers — a count; the loader is never shown an order. */
  orders: number;
  /** Items late against their dispatch day. */
  late: number;
  /** The earliest dispatch day among its lines, YYYY-MM-DD. */
  due: string | null;
  /** The loading job already running for it, and who is in charge of it. */
  task: string | null;
  loader: string | null;
  /** Everything is on and the loading was sent today: waiting on the office to verify, nothing for a loader to do. */
  sent?: boolean;
};

/** A box on the lorry, with the dispatch sticker it was paired with where its order has stickers. */
export type LorryBox = { id: string; sku: string; lot: string; sticker?: string | null };
export type LorryOverride = { id: string; unit: string; ordered: string; scanned: string; reason: string; status: string; by: string | null; mine: boolean; decidedBy: string | null; note: string | null };
/**
 * An order on the lorry whose dispatch stickers carry ids: how many of its
 * stickers are on, and the numbers of the ones still off — "missing 4, 9" is
 * how a box left on the floor is found before the lorry goes.
 */
export type LorryStickers = { orderNo: number; party: string; total: number; loaded: number; missing: number[] };
export type LorryBoard = { lorry: Lorry | null; boxes: LorryBox[]; overrides: LorryOverride[]; canDecide: boolean; stickers?: LorryStickers[] };

/**
 * HALF A PAIR. An order with dispatch stickers is loaded by scanning a box AND
 * its sticker, in either order. The first of the two is held here — on the
 * phone, sent back with the next scan — and the server says what it is
 * waiting for. Nothing is written until both are in.
 */
export type LorryHalf = { kind: "box" | "sticker"; code: string; says: string };

export type LorryScan =
  /* `stale`: the scan changed what the phone's factory data says (a lot allocated, a job made), and the phone fetches it in the background rather than the scan waiting for it. */
  | { ok: true; code: string; tone: "ok" | "warn"; title: string; message: string; board: LorryBoard; task: string; data: FactoryData | null; stale?: boolean; half?: LorryHalf | null }
  | { ok: false; code: string; title: string; text: string; fix: string; board: LorryBoard | null; task: string | null; override: { sku: string; label: string }[] | null; repeat?: boolean; half?: LorryHalf | null };

/** A box scanned on Home: which lorries still need its item. */
export type LorryFind =
  | { ok: true; code: string; name: string; lorries: { key: string; name: string | null; need: number }[] }
  | { ok: false; title: string; text: string; fix: string };

export type BoxScan =
  | { ok: true; code: string; message: string; board: LoadBoard; data: FactoryData | null; stale?: boolean }
  | { ok: false; code: string; title: string; text: string; fix: string; board: LoadBoard | null; repeat?: boolean };

/** What a box label is, for the home scan. */
export type BoxInfo = { ok: true; line: string } | { ok: false; title: string; text: string; fix: string };

/* ---------------------------------------------------------------- the LRs
 * THE DISPATCH TEAM UPLOADS THE LR FROM THE PHONE IT IS STANDING WITH. The
 * same register the ERP's Upload LRs button writes (lib/erp/logistics.ts
 * `uploadLrs`): logistics attaches it to its bills on the LR desk, which is
 * where a customer is told — never from the floor.
 * ------------------------------------------------------------------------- */

export type LrFields = {
  lrNo: string | null;
  /** YYYY-MM-DD */
  lrDate: string | null;
  transporter: string | null;
  destination: string | null;
  packages: number | null;
  freightTerm: string | null;
  freightRupees: number | null;
};

export type LrRecent = { id: string; lrNo: string | null; lrDate: string | null; transporter: string | null; destination: string | null; packages: number | null; status: string; bills: number; uploadedBy: string | null };

export type LrKit = { ok: true; transporters: string[]; canRead: boolean; recent: LrRecent[]; terms: string[] } | { ok: false; title: string; text: string; fix: string };

/** Up to `LR_BATCH_MAX` photos stored in one press — each its own photo-only LR on the desk. */
export const LR_BATCH_MAX = 20;

/**
 * What the phone lets somebody pick for one upload (0296). Below the server's
 * ceiling on purpose: an APK already in the field still sends up to
 * LR_BATCH_MAX, and the server must go on taking it.
 */
export const LR_PICK_MAX = 10;

/** The most batches one mixing job can hold — Give a task, Start a mixing batch and the batch sheet alike. */
export const MIX_BATCH_MAX = 10;

export type LrBatchSave =
  | { ok: true; ids: string[]; stored: number; already: number; refused: number; reading: boolean; msg: string; recent: LrRecent[] }
  | { ok: false; title: string; text: string; fix: string };

export type LrReading =
  | { ok: true; readingId: string; fields: LrFields; check: boolean; notes: string[] }
  | { ok: false; text: string };

export type LrSave =
  | { ok: true; id: string; msg: string; replay?: boolean; recent: LrRecent[] }
  | { ok: false; title: string; text: string; fix: string; field?: string };

/* ---------------------------------------------------------------- stock checks
 * ANYBODY ON THE FLOOR CHECKS ANY STOCK, AT ANY TIME, BLIND. The phone lists
 * every item at the person's godown — raw materials, semi-finished, filled
 * cans, packed boxes — and the counts the office asked for on top. Nothing
 * about the book is sent before the figure: the server reads and snapshots
 * the book at the moment of saving (`lib/erp/floor-checks.ts`, and the ERP's
 * own `submitCount` for an office count), says whether the two match, and on
 * a mismatch asks — optionally — why. A mismatch waits for the office on the
 * ERP dashboard and on Stock accuracy → Stock checks.
 * ------------------------------------------------------------------------- */

export type CheckStage = "rm" | "sfg" | "fg" | "pack";
export type CheckUnit = "Ltr" | "Pcs" | "Cans" | "Boxes";

/** A count the office asked for (ERP → Stock accuracy → To count). */
export type CountTask = {
  id: string;
  /** SC-12 */
  no: string;
  item: string;
  godown: string;
  unit: CheckUnit;
  /** YYYY-MM-DD */
  due: string;
  overdue: boolean;
  kind: string;
  reason: string;
  /** An independent recount of a red flag. */
  recount: boolean;
  /** Opened because somebody asked to buy this item. */
  forPurchase: boolean;
  /** Why this person may not count it, said in words; null when they may. */
  blocked: string | null;
};

/** Any item the floor may check. `here` only orders the list — it never carries a quantity. */
export type CheckItem = {
  stage: CheckStage;
  id: string;
  name: string;
  unit: CheckUnit;
  here: boolean;
  checkedToday: { matched: boolean; by: string; at: string } | null;
};

export type StockKit =
  /** `stages` are the kinds this person's departments may check; absent from an older server, read as all four. */
  | { ok: true; godown: string; office: CountTask[]; items: CheckItem[]; stages?: CheckStage[] }
  | { ok: false; title: string; text: string; fix: string };

export type StockCheckInput = { stage: CheckStage; itemId: string; qty: number | null; bin?: string | null; key: string };
export type CountInput = { id: string; qty: number | null; bin?: string | null; lot?: string | null };

export type StockSave =
  | {
      ok: true;
      /** `check` — a check the person chose; `count` — a count the office asked for. */
      kind: "check" | "count";
      id: string;
      no: string | null;
      item: string;
      unit: CheckUnit;
      qty: number;
      /** The book it was held against, read when the figure arrived. */
      book: number | null;
      difference: number | null;
      matched: boolean;
      message: string;
      replay?: boolean;
    }
  | { ok: false; kind: "qty" | "notOpen" | "notAllowed" | "signedOut" | "item"; title: string; text: string; fix: string };

/* ---------------------------------------------------------------- SFG quality check
 *
 * Deciding an SFG lot's QC from the phone — the same decision as ERP → SFG
 * batches → Approve / Reject, with the same Testing-list checks
 * (lib/factory/qc.ts does the work). The phone draws the tests the server
 * sends; the server reads the answers against the list again.
 */
export type QcVerdict = "Pending" | "Approved" | "Rejected";
export type QcLot = {
  lot: string;
  product: string;
  /** The day the lot was made, "YYYY-MM-DD". */
  made: string;
  litres: number;
  godown: string;
  status: QcVerdict;
  /** The checks recorded with the last decision, by test name. */
  tests: Record<string, "Pass" | "Fail">;
  note: string | null;
  by: string | null;
};
export type QcKit =
  | { ok: true; tests: string[]; waiting: QcLot[]; decided: QcLot[] }
  | { ok: false; title: string; text: string; fix: string };
export type QcInput = { lot: string; verdict: "Approved" | "Rejected"; results: Record<string, string>; note: string | null };
export type QcSave =
  | { ok: true; msg: string; lot: QcLot }
  | { ok: false; title: string; text: string; fix: string; test?: string };

/* ---------------------------------------------------------------- purchase requirements
 *
 * The in-charge of Mixing, Refilling or Packing asks the office to buy what
 * the department needs, from the phone. Each item is COUNTED before it is
 * asked for: the phone never shows the book, and the figure goes to the ERP
 * as the requirement's blind stock check (`lib/factory/purchase.ts`).
 */

/** The three floor departments that buy anything. */
export const REQ_DEPTS = ["mixing", "filling", "packing"] as const;
export type ReqDept = (typeof REQ_DEPTS)[number];

export type ReqItem = {
  id: string;
  name: string;
  /** The item master's category: Chemical, Can, Drum, Box, Stationary. */
  cat: string;
  /** What a count is made in — litres or pieces. */
  countUnit: "L" | "pcs";
  /** What it is bought in. */
  buyUnit: string;
  /** How it is bought, in words: "On the Quotation manager", "Direct from Shree Chem". */
  how: string;
  /** Asked for by this department in the last 90 days — drawn first. */
  recent: boolean;
  /** An open requirement already asking for it here, e.g. "REQ-141". */
  openReq: string | null;
};

export type ReqLine = {
  id: string;
  item: string;
  qty: number;
  unit: string;
  /** The ERP's stage, in its words: "Count stock", "Waiting for PO number", "Waiting for goods", "Received". */
  stage: string;
  /** Index into `steps`; −1 cancelled; steps.length done. */
  step: number;
  /** What happens next, in a sentence. */
  next: string;
  /** What the requester counted, and what came of it — never the book. */
  counted: number | null;
  countUnit: "L" | "pcs";
  countState: "matched" | "flagged" | "waiting" | null;
  /** May the in-charge cancel it here; else why not. */
  cancel: { ok: true } | { ok: false; why: string } | null;
  /** The PO it is on, e.g. "PO-311", and who it is bought from — once there is one. */
  po: string | null;
  vendor: string | null;
  /** Received so far against the PO, in the requirement's unit. */
  received: number | null;
};

export type ReqCard = {
  no: string;
  dept: ReqDept;
  priority: "Urgent" | "Medium" | "For Stock";
  date: string;
  requiredBy: string | null;
  godown: string;
  by: string | null;
  remarks: string | null;
  state: "open" | "received" | "cancelled";
  lines: ReqLine[];
};

export type ReqKit =
  | {
      ok: true;
      godown: string;
      today: string;
      /** The steps every item goes through, in order. */
      steps: string[];
      depts: { key: ReqDept; label: string; items: ReqItem[] }[];
      reqs: ReqCard[];
    }
  | { ok: false; title: string; text: string; fix: string };

export type ReqInput = {
  /** Minted on the phone when the requirement is started; a resend answers from the first save. */
  key: string;
  dept: ReqDept;
  requiredBy: string;
  priority: "Urgent" | "Medium" | "For Stock";
  remarks?: string | null;
  lines: { itemId: string; counted: number; need: number }[];
};

export type ReqSave =
  | {
      ok: true;
      no: string;
      lines: { item: string; qty: number; unit: string; counted: number; countUnit: "L" | "pcs"; verdict: "matched" | "flagged" | "skipped" }[];
      next: string[];
      replay?: boolean;
    }
  | { ok: false; title: string; text: string; fix: string; line?: number };
