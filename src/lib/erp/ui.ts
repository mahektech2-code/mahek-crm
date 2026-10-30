/* ---------------------------------------------------------------------------
 * The contract between an ERP screen's server loader and the generic client
 * screens (list, record dialog, form dialog, prompt, confirm).
 *
 * The server decides EVERYTHING that is a rule — which rows, which columns a
 * person's powers reveal, which actions a record offers and why one is not
 * available yet — and sends plain data. The client only draws it and asks the
 * server to act. That is what keeps a hidden button from being a permission.
 *
 * PURE and client-safe.
 * ------------------------------------------------------------------------- */

import { groupIndian, rupeesFromPaise } from "@/lib/format";

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

/**
 * A figure summed (or averaged) over a list's group. `missing` is the words
 * for rows carrying no value — "without a weight" — and opts the aggregate
 * into counting them: a total over a group where some rows could not be
 * weighed is a part total, and the heading says so rather than printing it
 * as though it were the whole.
 */
export type ListAgg = { k: string; l: string; t?: "avg"; missing?: string };

/** A spec's aggregates as a list, whichever way it declared them. */
export const aggsOf = (agg: ListAgg | ListAgg[] | undefined): ListAgg[] => (agg == null ? [] : Array.isArray(agg) ? agg : [agg]);

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
  | "pin"
  /** One of a few options, drawn as buttons to tap rather than a dropdown. */
  | "pick";

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
  /**
   * A select drawn as a box somebody TYPES into, however few its options —
   * the GRN's PO number is typed, never scrolled for. The text is the
   * placeholder.
   */
  typed?: string;
  /**
   * Draw no "Optional" tag beside a field that is not required — for a form
   * where nothing is, so saying it on every field says nothing.
   */
  untagged?: boolean;
  /**
   * A photo or video drawn as a square tile with its name inside, beside the
   * other tiles next to it — for a dialog that asks for several pictures at once.
   */
  tile?: boolean;
  /** A short field that shares a row with the inline fields beside it. */
  inline?: boolean;
  /** Required only while this holds — "weight with drum" is needed for a kg item, not a litre one. */
  reqWhen?: When;
  /** Fixed options. */
  opts?: string[];
  /** Options that depend on other fields' values: `{ by: "type", map: { Chemical: [...] } }`; a list of fields keys the map by their values joined with "|". */
  optsBy?: { by: string | string[]; map: Record<string, string[]> };
  hint?: string;
  /** Keep the hint written under the box instead of behind the i — only for a
   *  hint that changes what is typed (a format, a limit). Short, one line. */
  hintShown?: boolean;
  /** Default value on open. */
  def?: string;
  /**
   * Filled in when a field it depends on changes: `{ by: ["product", "item"],
   * map: { "Nano|Toluene": "200" } }` — header and line values both count, keys
   * joined with "|". No entry leaves the value as it was, unless `otherwise`
   * says what to put there instead; whatever is filled stays editable. A header
   * field filled this way moves the line fields that read it, so one pick can
   * fill a chain. The SFG batch's quantity per batch reads the recipe this way,
   * and an order line's rate reads the billing party's price list.
   */
  fillBy?: { by: string[]; map: Record<string, string>; otherwise?: string };
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
  /**
   * A photo field's upload allowance, named rather than numbered: the upload
   * route maps it to a ceiling, so a browser cannot ask for a bigger one.
   * Absent is `attachments.maxSizeMb`.
   */
  upload?: "material-photo";
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
  /**
   * A form drawn by its own dialog rather than field by field. `grn`: the goods
   * receipt that starts from the item that arrived (`engines/grn-pick.ts`) —
   * search the item, pick the open PO line, then the ordinary line fields.
   */
  flow?: "grn";
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

/** An impact id naming one part of a record, chosen in a prompt (`ActionSpec.impact.withValue`). */
export function impactPart(id: string, part: string | undefined): string {
  return JSON.stringify([id, part ?? ""]);
}

/** The record id and the chosen part back out of `impactPart`, or null where it is not one. */
export function readImpactPart(id: string): [string, string] | null {
  try {
    const v = JSON.parse(id) as unknown;
    return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" ? [v[0], v[1]] : null;
  } catch {
    return null;
  }
}

/** What a list's own New form is asked for by, when it stayed on the server (`ListSpec.newFormLazy`). Never a module's action id: those are words. */
export const NEW_FORM_ACTION = "__new";

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
  /**
   * A delete or change that reaches other records: opens the impact modal
   * (`components/ui/impact-dialog.tsx`) in place of `confirm`, which lists
   * everything that moves with it across MahekOne and asks for the name to be
   * typed. The act receives the confirmation under `IMPACT_FIELD` and checks it
   * with `confirmImpact` before it writes.
   */
  impact?: {
    kind: string;
    id: string;
    /**
     * Where the prompt picks WHICH part of the record the act reverses (one QC
     * decision of a return, one match of a receipt), the prompt field naming
     * it: the report is asked for `impactPart(id, values[withValue])`, so it
     * describes the part chosen rather than the record in general.
     */
    withValue?: string;
  };
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
  /**
   * Opens the Share window (`_ui/share-dialog.tsx`): how it goes, who it goes
   * to, the message. Its Send runs this action with `channel`, `to` (the ticked
   * keys, as JSON), `extra` (typed numbers or emails) and `message`, and the
   * action answers with a `ShareOutcome`.
   */
  share?: ShareSpec;
};

/** What the Share window offers for one record. */
export type ShareSpec = {
  title: string;
  sub?: string;
  /** The ways it may go, first one picked; each with a line saying what happens. */
  channels: { k: "whatsapp" | "email" | "link"; l: string; d: string }[];
  /** Who it may go to, from the record's own parties. */
  recipients: { key: string; name: string; tag?: string; whatsapp: string | null; email: string | null; checked: boolean }[];
  message: string;
  /** What travels with the message ("PO-411.pdf"), named under it. */
  attachment?: string;
  /** "WhatsApp to Vendor B · 18 Oct by Deepa". */
  last?: string;
};

/** What a share action answers with: one row per person, and the link. */
export type ShareOutcome = {
  link: string | null;
  /** The message as it went, link included — for Copy. */
  text: string;
  results: {
    recipient: string;
    address: string | null;
    /** sent: Wati or the mail provider took it. open: to be sent from the person's own app, through `href`. failed: `why`. */
    status: "sent" | "open" | "failed";
    href?: string;
    why?: string;
  }[];
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

export type BulkSpec = {
  id: string;
  l: string;
  /** Handled on the page rather than by the server: "printInvoices" opens the Print invoices pop-up over the selection. */
  client?: "printInvoices";
  confirm?: string;
  /** Values to collect once for the whole selection. */
  prompt?: PromptSpec;
  /**
   * The impact modal for the whole selection, in place of `confirm`: the
   * selection is one record whose id is `impactBatchKey(ids)`
   * (`lib/impact/batch-key.ts`), and the bulk act checks the confirmation
   * against the same key, received under `IMPACT_FIELD`. A `prompt` is asked
   * first and its values travel with the confirmation.
   */
  impact?: { kind: string };
};

/* -------------------------------------------------------------------- rows */

export type ListRow = {
  id: string;
  v: Record<string, CellValue>;
  flags: string[];
  /** Record dialog. */
  title?: string;
  header?: string;
  fields?: RowField[];
  contacts?: Contact[];
  actions?: ActionSpec[];
  /** "Created by X · 27 Sep, 10:14". */
  by?: string;
  /** Fields hidden by powers, as a count, so the record can say so. */
  hiddenFields?: number;
  /** Free-form panels a screen draws in the record (allocation, evidence…). */
  /** `covers`: column keys the panel already draws, left out of the record's field list. */
  panel?: { kind: string; data: unknown; covers?: string[] };
  /** More screen-drawn panels, each a tab after `panel` (an order's Invoice beside its Customer tracking). */
  panels?: { kind: string; data: unknown }[];
  /**
   * The rows FOLDED under this one (`ListSpec.fold`): a can's lots under its
   * item total. Each is a whole row, with every column, so the list's
   * "By lot" reading can draw it on its own and a click opens its own record.
   * Folded rows are searched with their total and never sorted apart from it.
   */
  sub?: ListRow[];
  /** What a folded row says in the first column, under its total ("Received 02 Sep"). */
  subLine?: string;
};

/**
 * One figure the selection bar adds up: the sum of a number column, or — `distinct`
 * — how many different values it holds (three orders among twelve lines).
 * `missing` names the rows with no value, so a total is never read as the whole.
 */
export type SelectSum = { k: string; l: string; one?: string; kind?: "sum" | "distinct"; missing?: string };

export type ListSpec = {
  screen: string;
  cols: ColSpec[];
  /**
   * The row value each group's heading draws as invoice buttons: "y:<order>"
   * (a PDF is attached — view and print), "n:<order>" (billed, no PDF — a red
   * Add PDF), absent (not billed). Read off the group's first row.
   */
  groupInvoice?: string;
  /** Action ids drawn in a ⋯ menu at the end of every row (each row's own `actions` of those ids). */
  rowMenu?: string[];
  /**
   * Draw the rows as image cards instead of table rows: the same rows,
   * search, chips and paging, and a card opens the same record. `img` names
   * the row value holding the image's URL (empty draws a placeholder),
   * `title` the bold line, `lines` the muted ones beneath.
   */
  cards?: {
    img: string;
    title: string;
    lines: string[];
    empty: string;
    /** A video: the picture area is a navy frame with a play button. */
    play?: boolean;
    /** Offer a Cards / Table switch, so the table's columns and sorting stay a click away. */
    toggle?: boolean;
  };
  /**
   * Draw the rows as a conversation: senders down the left, their messages in
   * the middle, the picked message's draft and actions on the right. Always
   * offered beside the table, never instead of it.
   */
  chat?: { who: string; text: string; when: string; via: string };
  /** Columns withheld by a power, named so the screen can say which. */
  hidden: { l: string; power: string }[];
  groups?: string[];
  /** Aggregate on each group — one, or several drawn side by side ("12 stickers · 480 kg"). */
  agg?: ListAgg | ListAgg[];
  groupSel?: boolean;
  /**
   * Columns that belong to the GROUP rather than the line — an SFG batch's
   * date, product and QC are one fact about the batch, however many lots it
   * drew. While grouped they are drawn once in the group's header and left
   * out of its rows; ungrouped, the list is flat and carries them on every
   * line as before.
   */
  groupHead?: string[];
  /** Header facts whose VALUE is drawn bold — the ones somebody reads a group by. */
  groupHeadStrong?: string[];
  /** A header fact left out when it says the same as another: { delivery: "billing" }. */
  groupHeadUnlessSame?: Record<string, string>;
  chips?: string;
  /**
   * Columns offered as filters on the toolbar: one "All …" select each, its
   * choices the values the column draws, counted. A key not among `cols` (a
   * column withheld by a power) is simply not offered.
   */
  filters?: string[];
  /**
   * Every drawn column heading carries an Excel-style filter: a funnel that
   * opens the column's values, counted, to tick — or a min/max on a number
   * column. Applied on the server with the rest of the reading (`list-query.ts`).
   */
  colFilters?: boolean;
  /**
   * What the selection bar adds up over the ticked rows ("1,240 kg · 86 boxes ·
   * 3 orders"). Naming any draws a checkbox on every row even where the list
   * has no bulk action — ticking is then for reading the totals.
   */
  selectSum?: SelectSum[];
  sortDefault?: [string, 1 | -1];
  bulk?: BulkSpec[];
  /** Key of the godown column the godown filter applies to. */
  godownKey?: string;
  /** Line under the toolbar when the list is scoped to the working godown. */
  scopedLine?: string;
  newForm?: FormSpec;
  /**
   * The New form was too heavy to send with the list (`lazy-forms.ts`): the
   * button asks the server for it under `NEW_FORM_ACTION` when pressed.
   */
  newFormLazy?: boolean;
  newLabel?: string;
  /**
   * "+ New ▾": every kind of record the screen can start, each opening its
   * form on its own tab. Drawn in place of the single New button.
   */
  newMenu?: { l: string; sub?: string; href: string }[];
  /**
   * A row of figures above the list, read left to right with an operator
   * between them — an account statement's Opening + In − Out = Closing.
   */
  strip?: { l: string; v: string; op?: "+" | "−" | "="; tone?: "danger" | "success" }[];
  /** Header buttons that act on the screen (see ToolSpec). */
  tools?: ToolSpec[];
  readOnly?: boolean;
  noDataLine?: string;
  /**
   * Some rows carry their parts folded under them (`ListRow.sub`), and the
   * toolbar offers both readings: `whole` (the totals, each opening onto its
   * parts) and `parts` (every part a row of its own, as `?parts=1`). `l` names
   * what is folded; `note` is said under the toolbar while totals are shown.
   */
  fold?: { l: string; whole: string; parts: string; note?: string };
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
  "Close - Received to Party": "success", "In Transit": "info", "Reached Destination Area": "success", "Out for Delivery": "success",
  Follow: "success", UnFollow: "muted", Testing: "info", Purchase: "neutral", Yes: "brand", No: "neutral",
  "Approved By Admin": "success", Chemical: "info", "A+": "success", A: "success", "B+": "neutral",
  B: "neutral", C: "warn", Billed: "neutral", Acknowledged: "info", "Resolved automatically": "success",
  Resolved: "success", New: "brand", Converted: "success", "Not an order": "muted", Duplicate: "warn",
  High: "success", Low: "warn", "Invoice Received": "info", "Purchase Matched": "brand",
  "Purchase Verified": "success", Dispatched: "success", Transfer: "neutral", Declined: "danger",
  Arrived: "neutral", Tested: "info", "Bill received": "info", Matched: "brand",
  "Buyer decision": "brand", "Select vendor": "warn",
  "Ready for PO": "brand", "Waiting for PO number": "warn", "Create PO": "brand", "Create or link PO": "brand", "Waiting for goods": "info", "PO awaiting approval": "warn", "PO approved": "info", "PO sent": "info",
  "Partly received": "warn", "Closed short": "muted", Closed: "muted", Cancelled: "muted",
  "Direct purchase": "neutral", Quotation: "info", "Pending approval": "warn", Approved: "success",
  Sent: "info", Selected: "success", "Not selected": "muted",
  "To count": "info", Mismatch: "danger", "Mismatch · reviewed": "warn", "Red flag": "danger", "Recount out": "warn", Investigating: "warn", "Stock discrepancy": "danger",
  "Blind count": "info",
  "In stock": "success", "Scanned for dispatch": "brand", "On hold": "warn", Returned: "info", "Written off": "danger",
  "Empty – available": "success", "Empty – returnable to vendor": "info", "Needs review": "warn", Sold: "neutral",
  "Returned to vendor": "muted", Adjusted: "muted", Unpaid: "danger", "Partially Paid": "warn", Paid: "success",
  "Above limit": "danger", "Within limit": "success", "No declared tare": "muted", "Not matched": "warn",
  "Part matched": "info", Void: "muted", Recorded: "success", "Mahek owned": "brand", "Vendor returnable": "info",
  "Not recorded": "warn", "1–7": "warn", "8–15": "warn", "16–30": "danger", "31–60": "danger", "60+": "danger",
  Current: "success", "0–30 days": "neutral", "31–60 days": "warn", "61–90 days": "danger", "90+ days": "danger",
  "Awaiting approval": "warn", "Awaiting owner approval": "warn", "Debit note issued · to dispatch": "info",
  "Outward prepared · not confirmed": "brand", Issued: "success", Draft: "neutral", Confirmed: "success",
  "Awaiting receipt": "warn", "In quarantine · awaiting QC": "danger", "Partly decided by QC": "warn",
  "With accounts": "info", "Not raised": "neutral", Refused: "danger", Reversed: "muted", Disposed: "success",
  Completed: "success", "Reusable as is": "success", Rework: "info", "Chemical scrap": "warn", "Waste disposal": "danger",
  "To dispose": "warn", "In rework": "info",
};

/** Named row states (the source's format rules), and how each is labelled. */
export const FLAG: Record<string, [string, Tone]> = {
  rateMissing: ["Purchase rate empty", "warn"],
  countOverdue: ["Count overdue", "danger"],
  recount: ["Independent recount", "brand"],
  forPurchase: ["Holds a purchase", "warn"],
  adjustmentPending: ["Adjustment waiting", "warn"],
  shortage: ["Shortage", "danger"],
  surplus: ["Surplus", "info"],
  stockToCount: ["Waiting for the blind count", "info"],
  stockFlag: ["Stock difference — red flag", "danger"],
  stockOverJustified: ["More than the shelf needs", "warn"],
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
  autoLevel: ["Planned automatically", "brand"],
  aiAdjusted: ["Adjusted by AI", "info"],
  noLevel: ["No level set", "neutral"],
  notPosted: ["Not posted to inventory", "warn"],
  overRecipe: ["Above the recipe", "warn"],
  dueToday: ["Dispatch today", "brand"],
  dueTomorrow: ["Dispatch tomorrow", "neutral"],
  late: ["Dispatch late", "danger"],
  requiredOverdue: ["Past its required date", "danger"],
  noPo: ["Before POs", "neutral"],
  rateOffPo: ["Rate differs from PO", "warn"],
  awaitingApproval: ["Awaiting approval", "warn"],
  deliveryLate: ["Delivery overdue", "danger"],
  qcPending: ["Waiting for SFG QC", "warn"],
  qcRejected: ["Failed SFG QC", "danger"],
  toScan: ["Boxes still to scan", "warn"],
  orderToVerify: ["Order not verified", "warn"],
  orderCorrection: ["Order sent back for correction", "danger"],
  invoiceToCheck: ["Invoice to check", "warn"],
  invoiceRejected: ["Invoice rejected", "danger"],
  invoiceApproved: ["Invoice approved", "success"],
  stickersOn: ["Dispatch stickers on", "success"],
  noVehicle: ["No vehicle recorded", "warn"],
  linkedOrder: ["Linked order", "info"],
  unitHold: ["Box on hold", "warn"],
  unlabelled: ["Label not printed", "neutral"],
  mismatch: ["Override used", "danger"],
  drumVariance: ["Tare variance above limit", "danger"],
  drumReview: ["Ownership to decide", "warn"],
  drumWeightException: ["Weight outside limits, approved", "warn"],
  drumOpening: ["Opening stock — no GRN", "neutral"],
  unmatched: ["Not matched to a sale", "warn"],
  ownerApproval: ["Owner approval needed", "warn"],
  quarantine: ["In quarantine", "danger"],
  noRate: ["No rate — no debit note yet", "warn"],
  creditRaised: ["Credit note with accounts", "info"],
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

/** Paise → a rupees string for pre-filling a form. */
export function rupeesField(p: number | null | undefined): string {
  return p == null ? "" : rupeesFromPaise(p);
}

/**
 * Paise → "₹18,42,000", or "₹18,42,000.50" where it has paise, with a true
 * minus. An amount used to be rounded to the rupee here, so a bill of
 * ₹10,450.60 read as ₹10,451 in every ERP list and record — the paise were
 * stored and never shown.
 */
export function inr(paise: CellValue | undefined): string {
  if (paise == null || paise === "") return "";
  const n = Number(paise);
  if (!Number.isFinite(n)) return String(paise);
  const p = Math.round(n);
  const abs = Math.abs(p);
  const frac = abs % 100;
  return (
    (p < 0 ? "−" : "") +
    "₹" +
    groupIndian(Math.floor(abs / 100)) +
    (frac ? "." + String(frac).padStart(2, "0") : "")
  );
}

/** A RATE in paise → "₹11.50" — always two places once it has paise, like `inr`. */
export function inrRate(paise: CellValue | undefined): string {
  if (paise == null || paise === "") return "";
  const n = Number(paise);
  if (!Number.isFinite(n)) return String(paise);
  const r = n / 100;
  return (r < 0 ? "−" : "") + "₹" + (Number.isInteger(r) ? RATE_WHOLE : RATE_PAISE).format(Math.abs(r));
}

/** 12345.5 → "12,345.5" in Indian grouping, up to two decimals. */
/* One formatter, built once. `toLocaleString` with options builds a fresh
   Intl formatter on EVERY call, and a list of ten thousand rows formats a
   number several times a row — that alone was half a second of a page load. */
const NF = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const RATE_WHOLE = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const RATE_PAISE = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function nf(v: CellValue | undefined): string {
  if (v == null || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return NF.format(n);
}

/** A counted or weighed quantity → "12,345.125": up to three decimals, because
    kilograms and litres are recorded to the gram and the millilitre. */
const QTY = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
export function qty(v: CellValue | undefined): string {
  if (v == null || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return QTY.format(n);
}

export function cellText(col: ColSpec, v: CellValue | undefined): string {
  if (col.t === "d") return fd(v) || "—";
  if (col.t === "m") return v === "" || v == null ? "—" : inr(v);
  if (col.t === "n") return v === "" || v == null ? "—" : typeof v === "number" ? nf(v) + (col.u ?? "") : String(v);
  return v == null || v === "" ? "—" : String(v);
}

/** What a field's `fillBy` puts in it for these values: its entry, else `otherwise`, else undefined — left as it was. */
export function fillOf(f: FieldSpec, values: Record<string, string>): string | undefined {
  if (!f.fillBy) return undefined;
  return f.fillBy.map[f.fillBy.by.map((k) => values[k] ?? "").join("|")] ?? f.fillBy.otherwise;
}

/**
 * A form that opens with its picks already made — "Add to order" names the
 * party, a drafted order its party and SKUs — filled the way the dialog fills
 * a pick as it is made. The dialog fills on a change, and these never change.
 * Only empty values are filled; what the form was opened with stands.
 */
export function withFills(spec: FormSpec): FormSpec {
  const h: Record<string, string> = { ...(spec.init ?? {}) };
  for (const f of spec.header) {
    const v = h[f.k] ? undefined : fillOf(f, h);
    if (v) h[f.k] = v;
  }
  const initLines = spec.initLines?.map((l) => {
    const out = { ...l };
    for (const f of spec.line ?? []) {
      const v = out[f.k] ? undefined : fillOf(f, { ...h, ...out });
      if (v) out[f.k] = v;
    }
    return out;
  });
  return { ...spec, init: h, ...(initLines ? { initLines } : {}) };
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
