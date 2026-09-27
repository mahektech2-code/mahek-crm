/* ---------------------------------------------------------------------------
 * THE FOUNDER COMMAND CENTRE'S WIRE SHAPES.
 *
 * Client-safe and pure: the client shell renders exactly these, and every
 * section provider on the server returns exactly these. Nothing in here is a
 * figure — a figure is always read by a provider from the service the owning
 * app already uses (PRD P12), and arrives here already worded.
 *
 * The design (Claude Design, "Founder Command Centre.dc.html") draws every
 * section from the same four things — callouts, a metric strip, tables with
 * row actions, and a footnote — so a section is data, not a screen.
 * ------------------------------------------------------------------------- */

export type SectionKey =
  | "company"
  | "inbox"
  | "sales"
  | "team"
  | "customers"
  | "leads"
  | "enquiries"
  | "calling"
  | "field"
  | "service"
  | "money"
  | "prices"
  | "whatsapp"
  | "people"
  | "system";

export const SECTION_KEYS: readonly SectionKey[] = [
  "company",
  "inbox",
  "sales",
  "team",
  "customers",
  "leads",
  "enquiries",
  "calling",
  "field",
  "service",
  "money",
  "prices",
  "whatsapp",
  "people",
  "system",
];

export function isSectionKey(v: unknown): v is SectionKey {
  return typeof v === "string" && (SECTION_KEYS as readonly string[]).includes(v);
}

/** The period keys the design offers. `ytd` is the financial year to date. */
export type PeriodKey =
  | "today"
  | "week"
  | "month"
  | "last-month"
  | "quarter"
  | "ytd"
  | "custom";

export type PeriodView = {
  key: PeriodKey;
  label: string;
  /** "1–26 Sep 2026, compared with 1–26 Aug 2026" */
  dates: string;
};

export type PeriodState = {
  key: PeriodKey;
  from: string;
  to: string;
  compareFrom: string;
  compareTo: string;
  lastYearFrom: string;
  lastYearTo: string;
  /** The business date the reading was taken on. */
  today: string;
  /** YYYY-MM of the month the period ends in — the Month figures' month. */
  monthKey: string;
  views: PeriodView[];
};

export type Tone = "bad" | "warn" | "good" | "info" | "muted";

/** Period · Month · Now — PRD §7.2's three kinds, printed on every figure. */
export type FigureKind = "Period" | "Month" | "Now";

export type Metric = {
  key: string;
  label: string;
  value: string;
  sub: string;
  kind: FigureKind;
  tone?: Tone;
};

export type Callout = {
  tone: Tone;
  text: string;
  /** The button label, if the callout offers one. */
  act?: string;
  /** Go to another section. */
  go?: SectionKey;
  /** Or open a figure in this section. */
  figure?: string;
  /** Or open an external desk page (a route inside MahekOne). */
  href?: string;
};

export type Cell = {
  t: string;
  sub?: string;
  pill?: Tone;
};

/** A form field. Validation runs on the server; the client only shows it. */
export type FieldSpec = {
  k: string;
  label: string;
  type?: "text" | "area" | "select" | "date" | "money" | "customer" | "person" | "number" | "product";
  options?: { v: string; l: string }[];
  req?: boolean;
  /** "needed unless cash" — printed where "optional" would be. */
  cond?: string;
  ph?: string;
  hint?: string;
  /** For `customer`/`person`: what kind to search. */
  search?: "customer" | "lead" | "any" | "staff" | "caller" | "salesman";
  /** Shown only while another field holds one of these values. */
  when?: { k: string; in: string[] };
};

export type FormSpec = {
  title: string;
  sub?: string;
  submit?: string;
  consequence?: string;
  fields: FieldSpec[];
  init?: Record<string, string>;
};

export type ActSpec = {
  key: string;
  label: string;
  tone?: "bad";
  /** A confirmation stating the consequence. Absent = no confirmation. */
  confirm?: string;
  /** The word shown on the row once done ("Approved"). */
  done: string;
  /** An input the action needs (a reason, a person). */
  form?: FormSpec;
  /** "View as" opens the read-only view of a person. */
  viewAs?: boolean;
  /** Opens a MahekOne page instead of running anything. */
  href?: string;
};

export type Row = {
  id: string;
  cells: Cell[];
  /** Keys of the table's acts this row offers. Absent = all of them. */
  acts?: string[];
  /** Already decided — the row shows the word instead of the buttons. */
  done?: string;
};

export type Column = [label: string, width: string, right?: boolean];

export type TableDef = {
  key: string;
  title: string;
  hint: string;
  cols: Column[];
  noun: string;
  plural?: string;
  /** What a row's record is called ("Order", "Receipt"). */
  rec: string;
  acts?: ActSpec[];
  actW?: string;
  min?: number;
};

export type TablePage = {
  rows: Row[];
  /** Rows matching the search, over the whole set — never the loaded page. */
  count: number;
  /** Rows in the whole list. */
  total: number;
  page: number;
  size: number;
  q: string;
};

export type Table = TableDef & { page: TablePage };

export type SectionPayload = {
  metrics: Metric[];
  callouts: Callout[];
  tables: Table[];
  foot: string;
};

/* ---------------------------------------------------------------- drawer */

export type Fact = { label: string; value: string };

export type Bar = { h: number; tip: string; current?: boolean };

export type FigureDrawer = {
  kind: string;
  title: string;
  value: string;
  facts: Fact[];
  def: string;
  bars: Bar[];
  barsLabel: string;
  rowsLabel: string;
  rows: { a: string; b: string; c: string }[];
  /** No list holds the records behind this figure. */
  noRowsLine?: string;
  section?: SectionKey;
  sectionLabel?: string;
};

/* ---------------------------------------------------------------- record */

export type RecordView = {
  kind: string;
  title: string;
  sub: string;
  fields: Fact[];
  timeline: { what: string; when: string }[];
  audit: { what: string; who: string }[];
  acts: ActSpec[];
  /** Where the full working screen for this record lives, if anywhere. */
  href?: { label: string; url: string };
  /** The note's target — kind + id — used by "Add a note". */
  noteTarget: { kind: string; id: string };
};

/* ----------------------------------------------------------------- inbox */

export type InboxSeverity = "Urgent" | "Soon" | "Watch";

export type InboxItem = {
  id: string;
  sev: InboxSeverity;
  area: string;
  since: string;
  title: string;
  why: string;
  action: string;
  go: SectionKey;
  /** Handed on to somebody, or snoozed — by this viewer. */
  handed?: { to: string; note: string };
  snoozed?: { until: string; why: string };
};

/* ----------------------------------------------------------------- shell */

export type NavCounts = Partial<Record<SectionKey, number>>;

export type ShellData = {
  user: { name: string; initials: string; hatLabel: string };
  period: PeriodState;
  navCounts: NavCounts;
  freshness: { tone: Tone; line: string };
  inbox: InboxItem[];
  /** Sections this person may open (their modules). */
  allowed: SectionKey[];
};

export type Result<T = undefined> =
  | ({ ok: true; message?: string } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/* ------------------------------------------------------------- view as */

export type ViewAs = {
  name: string;
  role: string;
  stats: { l: string; v: string }[];
  held: string;
  listLabel: string;
  rows: { n: string; name: string; why: string; tag: string; tagTone: "now" | "done" | "" }[];
};

/* --------------------------------------------------------------- search */

export type SearchHit = {
  kind: string;
  name: string;
  meta: string;
  /** Opens this record. */
  ref: { section: SectionKey; table: string; id: string };
};

/* ------------------------------------------------------------- company */

export type PeriodCard = {
  key: string;
  label: string;
  value: string;
  chg: string;
  chgGood: boolean | null;
  prevLine: string;
  lyLine: string;
  note?: string;
  bars: Bar[];
};

export type CompanyPayload = {
  cards: PeriodCard[];
  pace: {
    title: string;
    badge: string;
    figures: { label: string; value: string; sub: string; tone?: Tone }[];
    donePct: number;
    projectedPct: number;
    targetPct: number;
    leftLine: string;
    rightLine: string;
    hasTarget: boolean;
  };
  moversTitle: string;
  movers: { kind: string; name: string; d: number; val: string }[];
  nowAsOf: string;
  now: { key: string; label: string; value: string; sub: string; warn?: boolean }[];
  topTeam: { rank: string; name: string; role: string; score: string; initials: string }[];
  topTeamMonthLine: string;
  teamAllLabel: string;
  unattributed: { line: string; button: string } | null;
};
