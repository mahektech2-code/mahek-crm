/* ---------------------------------------------------------------------------
 * The contract between an ERP screen's server loader and the generic client
 * screens (list, record drawer, form drawer, prompt, confirm).
 *
 * The server decides EVERYTHING that is a rule — which rows, which columns a
 * person's powers reveal, which actions a record offers and why one is not
 * available yet — and sends plain data. The client only draws it and asks the
 * server to act. That is what keeps a hidden button from being a permission.
 *
 * PURE and client-safe.
 * ------------------------------------------------------------------------- */

import { groupIndian } from "@/lib/format";

/** Column types, from the design: bold, text, number, money, date, status, flags, phone, email, map, mono. */
export type ColType = "b" | "t" | "n" | "m" | "d" | "s" | "f" | "ph" | "em" | "map" | "mono";

export type ColSpec = {
  k: string;
  l: string;
  t: ColType;
  /** Unit suffix for numbers, e.g. "%". */
  u?: string;
  /** Minimum width override in px. */
  w?: number;
};

/** A cell value. Money is PAISE; dates are ISO `YYYY-MM-DD`. */
export type CellValue = string | number | null;

export type RowField = {
  l: string;
  /** Display-ready text. */
  v: string;
  /** Calculated rather than typed. */
  der?: boolean;
};

export type Contact = { l: string; href: string };

/* ----------------------------------------------------------- form fields */

export type FieldType =
  | "text" | "num" | "date" | "select" | "area" | "derived" | "photo" | "video"
  | "multi" | "suggest"
  /** Free text that a barcode scanner types into, offering its options as it goes. */
  | "scan"
  /** A CSV file, read in the browser: the field's value is the file's text. */
  | "csv"
  /** A time of day, "HH:MM". */
  | "time"
  /** A map pin, "lat, lng": typed, picked on a map, or taken from here. */
  | "pin";

/** A condition on another field of the same form: shown only while it holds. */
export type When =
  | { k: string; eq: string }
  | { k: string; in: string[] }
  | { k: string; notEmpty: true }
  | { k: string; includes: string }
  /** The value of `k`, looked up in the form's `data[map]`, is a list containing `has`. */
  | { k: string; map: string; has: string };

export type FieldSpec = {
  k: string;
  l: string;
  t: FieldType;
  /** A section heading, drawn where it first changes down the form. */
  sec?: string;
  req?: boolean;
  /** Required only while this holds — "weight with drum" is needed for a kg item, not a litre one. */
  reqWhen?: When;
  /** Fixed options. */
  opts?: string[];
  /** Options that depend on other fields' values: `{ by: "type", map: { Chemical: [...] } }`; a list of fields keys the map by their values joined with "|". */
  optsBy?: { by: string | string[]; map: Record<string, string[]> };
  hint?: string;
  /** Default value on open. */
  def?: string;
  /**
   * Filled in when a field it depends on changes: `{ by: ["product", "item"],
   * map: { "Nano|Toluene": "200" } }` — header and line values both count, keys
   * joined with "|". No entry leaves the value as it was; whatever is filled
   * stays editable. The SFG batch's quantity per batch reads the recipe this way.
   */
  fillBy?: { by: string[]; map: Record<string, string> };
  when?: When;
  /** Numeric bounds, checked in the browser and again on the server. */
  min?: number;
  max?: number;
  /** For `derived`: a named calculator in `lib/erp/calc.ts`. */
  calc?: string;
  /** Multiline dictation microphone (AI-3). */
  mic?: boolean;
  /** Field may not be edited (shown for context). */
  readOnly?: boolean;
  /** Takes the whole row of the form rather than one column. */
  wide?: boolean;
  /** How sure an AI reading is of this value: high, check, or not found. */
  conf?: "high" | "check" | "not found";
};

export type FormSpec = {
  /** The screen key the form writes to; the server action re-checks it. */
  screen: string;
  /** Which form on the screen, for screens with several (`new`, `edit`). */
  id: string;
  title: string;
  sub?: string;
  submit: string;
  header: FieldSpec[];
  /** Multi-line documents (a PR, an SFG batch, an order). */
  line?: FieldSpec[];
  lineLabel?: string;
  /**
   * How the lines are drawn. `cards` (the default) is a block of fields per
   * line, right for a document of a few lines; `table` is one compact row per
   * line, for a document that runs to hundreds — a requirement of every item a
   * department needs. A table starts empty and drops rows left blank.
   */
  lineLayout?: "cards" | "table";
  /**
   * A table's way to add many lines at once: a search box that adds the item
   * picked as a new line, and a box to paste a list into ("Toluene, 200" a
   * row), matched against the same options. `field` is the line field picked
   * by; `qty` the one a pasted quantity fills.
   */
  lineAdd?: { field: string; qty?: string; placeholder?: string; pasteHint?: string };
  /** Data the calculators read (stock maps, rates). */
  data?: Record<string, unknown>;
  /** Initial values when opened from an action ("Add more" keeps the header). */
  init?: Record<string, string>;
  /** Record being edited, if any. */
  recordId?: string;
  /** Asks "are you sure" with this text (placeholders `{field}` filled). */
  confirm?: string;
  /** Lines to start with (an AI draft, a copied document). */
  initLines?: Record<string, string>[];
  /**
   * Lines that a header field brings with it: picking `by` replaces the lines
   * with `map[value]`, the way picking an SFG product lays out its recipe. Lines
   * nobody has touched are replaced without a word; lines somebody typed into
   * are replaced only after a confirm. `set` fills header fields still empty
   * (one batch) when a list is laid out. A value with no entry leaves the lines.
   */
  linesFrom?: { by: string; map: Record<string, Record<string, string>[]>; set?: Record<string, string> };
  /** What an AI reading was read from, shown beside the proposed values. */
  evidence?: { images?: string[]; text?: string; flags?: { tone: Tone; text: string }[]; note?: string };
};

/* ---------------------------------------------------------------- actions */

export type PromptSpec = {
  title: string;
  sub?: string;
  submit: string;
  fields: FieldSpec[];
  init?: Record<string, string>;
};

export type ActionSpec = {
  /** Stable id the server dispatches on. */
  id: string;
  l: string;
  primary?: boolean;
  /** An AI action (drawn distinctly; absent when AI is off). */
  ai?: boolean;
  /** Why it is not available yet; drawn disabled with this reason. */
  why?: string;
  /** "Are you sure" text, when the act needs one. */
  confirm?: string;
  /** Values to collect before acting. */
  prompt?: PromptSpec;
  /** Opens a form instead of acting directly (e.g. "Add more"). */
  form?: FormSpec;
  /**
   * Opens a form the server builds for this record on demand (an Edit whose
   * initial values are the record's own). The screen module's `formLoaders`
   * answers it under the same id.
   */
  loadsForm?: boolean;
  /** Navigates to a screen (e.g. "Open record"). */
  href?: string;
};

/**
 * A button in the list's header that acts on the screen rather than on a
 * record ("Take my task", "Run now", "Import CSV"). It runs on the server
 * through the kit's `runTool`, perhaps after a prompt, and may answer with a
 * dialog (`ToolResult`) — the EOD message to send, an import preview.
 */
export type ToolSpec = {
  id: string;
  l: string;
  primary?: boolean;
  confirm?: string;
  prompt?: PromptSpec;
  /** Navigates instead of acting. */
  href?: string;
  /** Why it is not available (drawn disabled). */
  why?: string;
};

/** What a tool may answer with, beside a toast. Carried as the Result's data. */
export type ToolResult = {
  dialog?: {
    title: string;
    sub?: string;
    /** Preformatted text (a message to send, a report). */
    text?: string;
    /** Lines drawn one under another, each optionally toned (an import preview). */
    lines?: { text: string; tone?: Tone }[];
    /** A button that opens a link (WhatsApp, a file). */
    open?: { label: string; href: string };
    /** Offer to copy `text`. */
    copy?: boolean;
    /** A follow-up tool the dialog's primary button runs, with values. */
    next?: { tool: string; label: string; values?: Record<string, string> };
  };
  /** Navigate after success. */
  navigate?: string;
};

export type BulkSpec = { id: string; l: string; confirm?: string; /** Values to collect once for the whole selection. */ prompt?: PromptSpec };

/* -------------------------------------------------------------------- rows */

export type ListRow = {
  id: string;
  v: Record<string, CellValue>;
  flags: string[];
  /** Record drawer. */
  title?: string;
  header?: string;
  fields?: RowField[];
  contacts?: Contact[];
  actions?: ActionSpec[];
  /** "Created by X · 27 Sep, 10:14". */
  by?: string;
  /** Fields hidden by powers, as a count, so the drawer can say so. */
  hiddenFields?: number;
  /** Free-form panels a screen draws in the drawer (allocation, evidence…). */
  panel?: { kind: string; data: unknown };
};

export type ListSpec = {
  screen: string;
  cols: ColSpec[];
  /**
   * Draw the rows as image cards instead of table rows: the same rows,
   * search, chips and paging, and a card opens the same record. `img` names
   * the row value holding the image's URL (empty draws a placeholder),
   * `title` the bold line, `lines` the muted ones beneath.
   */
  cards?: { img: string; title: string; lines: string[]; empty: string };
  /** Columns withheld by a power, named so the screen can say which. */
  hidden: { l: string; power: string }[];
  groups?: string[];
  /** Aggregate on each group. */
  agg?: { k: string; l: string; t?: "avg" };
  groupSel?: boolean;
  chips?: string;
  sortDefault?: [string, 1 | -1];
  bulk?: BulkSpec[];
  /** Key of the godown column the godown filter applies to. */
  godownKey?: string;
  /** Line under the toolbar when the list is scoped to the working godown. */
  scopedLine?: string;
  newForm?: FormSpec;
  newLabel?: string;
  /** Header buttons that act on the screen (see ToolSpec). */
  tools?: ToolSpec[];
  download?: boolean;
  readOnly?: boolean;
  noDataLine?: string;
};

/* ------------------------------------------------------------------ tones */

export type Tone = "success" | "danger" | "warn" | "info" | "brand" | "neutral" | "muted";

export const TONES: Record<Tone, [string, string]> = {
  success: ["#E9F5EE", "#1D7A45"],
  danger: ["#FCECEC", "#B3261E"],
  warn: ["#FDF6E7", "#8A5C05"],
  info: ["#EDF2FC", "#2B5CBF"],
  brand: ["#F1ECFF", "#5223E0"],
  neutral: ["#EDEFF3", "#3D4453"],
  muted: ["#F7F8FA", "#6B7385"],
};

/** The tone a status value is drawn in, wherever it appears. */
export const ST_TONE: Record<string, Tone> = {
  "Under Process": "info", Ready: "success", Today: "brand", Tomorrow: "neutral", Delay: "danger",
  "Hold From Office": "warn", Cancel: "muted", Pending: "warn", Verified: "success", Verify: "success",
  "Not Verified": "danger", "Not verified": "warn", "Not Verify": "warn", Active: "success", Deactive: "muted",
  Inactive: "muted", Accepted: "success", Rejected: "danger", Requested: "warn", Urgent: "danger",
  Medium: "warn", "For Stock": "neutral", Open: "neutral", "Order Placed": "info", Booked: "brand",
  Received: "success", "Not Received": "warn", "Bill Not Received": "warn", Posted: "success",
  "Not posted: rate missing": "warn", Done: "success", "Not Done": "warn", "Add More Quantity": "warn",
  "Remove Some Quantity": "danger", Match: "success", "Not Match": "warn",
  "Close - Received to Party": "success", "In Transit": "info", "Reached Destination Area": "success",
  Follow: "success", UnFollow: "muted", Testing: "info", Purchase: "neutral", Yes: "brand", No: "neutral",
  "Approved By Admin": "success", Chemical: "info", "A+": "success", A: "success", "B+": "neutral",
  B: "neutral", C: "warn", Billed: "neutral", Acknowledged: "info", "Resolved automatically": "success",
  Resolved: "success", New: "brand", Converted: "success", "Not an order": "muted", Duplicate: "warn",
  High: "success", Low: "warn", "Invoice Received": "info", "Purchase Matched": "brand",
  "Purchase Verified": "success", Dispatched: "success", Transfer: "neutral", Declined: "danger",
  Arrived: "neutral", Tested: "info", "Bill received": "info", Matched: "brand",
  "Buyer decision": "brand", "Select vendor": "warn", "Collect quotations": "warn", "Compare quotations": "info",
  "Ready for PO": "brand", "PO awaiting approval": "warn", "PO approved": "info", "PO sent": "info",
  "Partly received": "warn", "Closed short": "muted", Closed: "muted", Cancelled: "muted",
  "Direct purchase": "neutral", Quotation: "info", "Pending approval": "warn", Approved: "success",
  Sent: "info", Selected: "success", "Not selected": "muted",
  "In stock": "success", "Scanned for dispatch": "brand", "On hold": "warn", Returned: "info", "Written off": "danger",
};

/** Named row states (the source's format rules), and how each is labelled. */
export const FLAG: Record<string, [string, Tone]> = {
  rateMissing: ["Purchase rate empty", "warn"],
  incomplete: ["Packing batch incomplete", "warn"],
  orphan: ["Source deleted", "danger"],
  inactive: ["Inactive", "muted"],
  underProcess: ["Under process", "info"],
  readyShort: ["Ready · short of allocation", "danger"],
  readyAlloc: ["Ready · fully allocated", "success"],
  billMissing: ["Bill no / rate missing", "warn"],
  ratePresent: ["Rate present", "success"],
  notVerified: ["Not dispatch-verified", "warn"],
  targetReached: ["Sales target reached", "success"],
  today: ["Transferred today", "brand"],
  lost: ["Lost stock", "danger"],
  orderPlaced: ["Order Placed", "info"],
  booked: ["Booked", "brand"],
  accepted: ["Accepted", "success"],
  rejected: ["Rejected", "danger"],
  requested: ["Requested", "warn"],
  resolved: ["Resolved", "success"],
  awaitingRoute: ["Awaiting routing", "warn"],
  pendingParty: ["Pending customer", "warn"],
  alert: ["Open alert", "danger"],
  aiFilled: ["Filled from bill", "brand"],
  reserved: ["Reserved godown", "danger"],
  detailed: ["In order details", "neutral"],
  cnSync: ["CN out of sync", "warn"],
  below: ["Below level", "danger"],
  noLevel: ["No level set", "neutral"],
  notPosted: ["Not posted to inventory", "warn"],
  overRecipe: ["Above the recipe", "warn"],
  dueToday: ["Dispatch today", "brand"],
  dueTomorrow: ["Dispatch tomorrow", "neutral"],
  late: ["Dispatch late", "danger"],
  requiredOverdue: ["Past its required date", "danger"],
  noPo: ["Before POs", "neutral"],
  rateOffPo: ["Rate differs from PO", "warn"],
  lowestQuote: ["Lowest landed cost", "success"],
  quoteExpired: ["Quotation expired", "muted"],
  awaitingApproval: ["Awaiting approval", "warn"],
  deliveryLate: ["Delivery overdue", "danger"],
  qcPending: ["Waiting for SFG QC", "warn"],
  qcRejected: ["Failed SFG QC", "danger"],
  toScan: ["Boxes still to scan", "warn"],
  unitHold: ["Box on hold", "warn"],
  unlabelled: ["Label not printed", "neutral"],
  mismatch: ["Override used", "danger"],
};

/* -------------------------------------------------------------- formatting */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-27" → "27 Sep". A value that is not an ISO date is returned as is. */
export function fd(v: CellValue | undefined): string {
  if (v == null || v === "") return "";
  const p = String(v).slice(0, 10).split("-");
  if (p.length < 3 || p[0].length !== 4) return String(v);
  return `${Number(p[2])} ${MON[Number(p[1]) - 1]}`;
}

/** "2026-09-27" → "27 Sep 2026". */
export function fdLong(v: CellValue | undefined): string {
  const s = fd(v);
  if (!s || v == null) return s;
  return `${s} ${String(v).slice(0, 4)}`;
}

/** Paise → "₹18,42,000", with a true minus. */
export function inr(paise: CellValue | undefined): string {
  if (paise == null || paise === "") return "";
  const n = Number(paise);
  if (!Number.isFinite(n)) return String(paise);
  const r = Math.round(n / 100);
  return (r < 0 ? "−" : "") + "₹" + groupIndian(Math.abs(r));
}

/** A RATE in paise → "₹11.50": a rate keeps its paise, where an amount is rounded to the rupee. */
export function inrRate(paise: CellValue | undefined): string {
  if (paise == null || paise === "") return "";
  const n = Number(paise);
  if (!Number.isFinite(n)) return String(paise);
  const r = n / 100;
  return (r < 0 ? "−" : "") + "₹" + Math.abs(r).toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 });
}

/** 12345.5 → "12,345.5" in Indian grouping, up to two decimals. */
export function nf(v: CellValue | undefined): string {
  if (v == null || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export function cellText(col: ColSpec, v: CellValue | undefined): string {
  if (col.t === "d") return fd(v) || "—";
  if (col.t === "m") return v === "" || v == null ? "—" : inr(v);
  if (col.t === "n") return v === "" || v == null ? "—" : typeof v === "number" ? nf(v) + (col.u ?? "") : String(v);
  return v == null || v === "" ? "—" : String(v);
}

/** The field as it stands for these values: `reqWhen` folded into `req`. */
export function resolveField(f: FieldSpec, values: Record<string, string>, data: Record<string, unknown> = {}): FieldSpec {
  return f.reqWhen && !f.req && whenHolds(f.reqWhen, values, data) ? { ...f, req: true } : f;
}

export function whenHolds(
  when: When | undefined,
  values: Record<string, string>,
  data: Record<string, unknown> = {},
): boolean {
  if (!when) return true;
  const v = values[when.k] ?? "";
  if ("map" in when) {
    const m = (data[when.map] ?? {}) as Record<string, string[]>;
    return (m[v] ?? []).includes(when.has);
  }
  if ("eq" in when) return v === when.eq;
  if ("in" in when) return when.in.includes(v);
  if ("includes" in when) return v.split("|").includes(when.includes);
  return v !== "";
}
