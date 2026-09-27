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
  | "multi" | "suggest";

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
  req?: boolean;
  /** Fixed options. */
  opts?: string[];
  /** Options that depend on another field's value: `{ by: "type", map: { Chemical: [...] } }`. */
  optsBy?: { by: string; map: Record<string, string[]> };
  hint?: string;
  /** Default value on open. */
  def?: string;
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
  /** Data the calculators read (stock maps, rates). */
  data?: Record<string, unknown>;
  /** Initial values when opened from an action ("Add more" keeps the header). */
  init?: Record<string, string>;
  /** Record being edited, if any. */
  recordId?: string;
  /** Asks "are you sure" with this text (placeholders `{field}` filled). */
  confirm?: string;
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

export type BulkSpec = { id: string; l: string; confirm?: string };

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
  "Purchase Verified": "success", Dispatched: "success", Transfer: "neutral",
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
  awaitingRoute: ["Awaiting routing", "warn"],
  pendingParty: ["Pending customer", "warn"],
  alert: ["Open alert", "danger"],
  aiFilled: ["Filled from bill", "brand"],
  reserved: ["Reserved godown", "danger"],
  detailed: ["In order details", "neutral"],
  cnSync: ["CN out of sync", "warn"],
  below: ["Below level", "danger"],
  noLevel: ["No level set", "neutral"],
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
