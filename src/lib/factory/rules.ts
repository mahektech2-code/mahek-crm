/* ---------------------------------------------------------------------------
 * The factory floor's rules, PURE, so the phone and the server read one copy.
 *
 * The phone runs them to say "wrong drum" the instant a label is scanned;
 * the server runs them AGAIN on the stock it holds at the moment of posting,
 * because the phone's copy of a lot can be minutes old and a second person
 * may have poured from the same drum since (PRD §11: the server is the source
 * of truth for stock, transitions and permission).
 *
 * The sentences are the design's. A worker reads "Wrong material — this is
 * Xylene", not an error code.
 * ------------------------------------------------------------------------- */
import type { Draft, FactoryData, Lot, Proc, RmLine, Task } from "./types";
import { CHECK_ITEMS, STEPS } from "./types";

export const nf = (n: number | null | undefined) => Number(n || 0).toLocaleString("en-IN");

export type ScanPurpose = "badge" | "home" | "rm" | "sfg" | "pm" | "fg" | "load" | "drum" | "lr";
export type ScanMeta = { item?: string; idx?: number };
export type ScanResult =
  | { ok: false; code: string; title: string; text: string; fix: string }
  | { ok: true; code: string; kind: "emp"; emp: string }
  | { ok: true; code: string; kind: "task"; task: string }
  | { ok: true; code: string; kind: "info" | "lot"; lot: string };

/** Whether the office (or an earlier scan) has already given this lot to the order. */
export function lotGiven(db: FactoryData, order: string, code: string): boolean {
  return (db.orders[order]?.lines ?? []).some((ln) => ln.alloc.some((a) => a[0] === code));
}

/**
 * A box label (BX-yymmdd-nnnnnn, or LU- for a loose unit), read the way the
 * ERP reads one — a QR may carry the whole tracking URL — or null. Only the
 * server judges a box: the phone holds lots, never the boxes in them.
 */
export function boxCode(raw: string): string | null {
  let s = String(raw ?? "").trim();
  const slash = s.lastIndexOf("/");
  if (/^https?:\/\//i.test(s) && slash >= 0) s = s.slice(slash + 1);
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  s = s.trim().toUpperCase();
  return /^(BX|LU)-\d{6}-\d{6}$/.test(s) ? s : null;
}

/* ------------------------------------------------------------- naming */

export function lotName(db: FactoryData, x: Lot): string {
  if (x.type === "rm") return db.rm[x.item]?.n ?? x.item;
  if (x.type === "sfg") return db.sfg[x.item]?.n ?? x.item;
  if (x.type === "pm") return db.pm[x.item] ?? x.item;
  if (x.type === "fg") {
    const k = db.sku[x.item];
    return k ? k.n + " " + k.size : x.item;
  }
  const b = db.box[x.item], k = b && db.sku[b.sku];
  return b && k ? k.n + " " + k.size + " · box of " + b.cpb : x.item;
}

export function lotUnit(db: FactoryData, x: Lot): string {
  if (x.type === "rm" || x.type === "sfg") return "L";
  if (x.type === "pm") return "pcs";
  if (x.type === "fg") return db.sku[x.item]?.kind === "drum" ? "drums" : "cans";
  return "boxes";
}

export function taskName(db: FactoryData, t: Task): string {
  if (t.proc === "mixing") return db.sfg[t.item!]?.n ?? t.item!;
  if (t.proc === "filling") {
    const k = db.sku[t.item!];
    return k ? k.n + " " + k.size : t.item!;
  }
  if (t.proc === "packing") {
    const b = db.box[t.item!], k = b && db.sku[b.sku];
    return b && k ? k.n + " " + k.size + " · box of " + b.cpb : t.item!;
  }
  const o = db.orders[t.order!];
  return o ? o.cust : t.order!;
}

export function taskTarget(db: FactoryData, t: Task): string {
  if (t.proc === "mixing") {
    const f = db.sfg[t.item!];
    const n = t.batches ?? 1;
    return n + " batch" + (n > 1 ? "es" : "") + " · " + nf(n * (f?.batch ?? 0)) + " L";
  }
  if (t.proc === "filling") {
    const k = db.sku[t.item!];
    return nf(t.target) + " " + (k?.kind === "drum" ? "drums" : "cans");
  }
  if (t.proc === "packing") return nf(t.target) + " boxes" + (t.carry ? " · " + t.carry + " already in an open batch" : "");
  const o = db.orders[t.order!];
  return t.order + (o ? " · " + o.city + " · " + o.lines.length + " item" + (o.lines.length > 1 ? "s" : "") : "");
}

/** The code printed on a task sheet's QR. */
export const taskCode = (t: Task) => (t.proc === "dispatch" ? t.order! : "TASK-" + t.id.replace(/^T-/, ""));

/**
 * A code somebody TYPED off a label instead of scanning it. Spaces and capital
 * letters are not theirs to get right, so it is matched against every code the
 * phone knows — lots, task sheets, orders, badges — ignoring both, and answered
 * in the label's own spelling. A code the phone does not know comes back
 * cleaned (no spaces, capitals) for the scan's own check to judge: typing is a
 * way to READ a label, never a way past the check a scan meets.
 */
export function typedCode(typed: string, db: FactoryData | null): string {
  const fold = (v: string) => v.replace(/\s+/g, "").toUpperCase();
  const want = fold(typed);
  if (!db) return want;
  const known = [...Object.keys(db.lots), ...Object.keys(db.orders), ...db.tasks.map(taskCode), ...Object.values(db.emp).map((e) => e.badge ?? "")];
  return known.find((k) => k && fold(k) === want) ?? want;
}

/* ------------------------------------------------------------- scanning */

type ScanCtx = {
  db: FactoryData;
  purpose: ScanPurpose;
  meta: ScanMeta;
  /** The signed-in person's work area; a head can open anybody's task. */
  area?: string;
  /** Every department they work in, when they work several: a task of any of them is theirs. */
  areas?: string[];
  task?: Task | null;
  d?: Draft | null;
};

/** What a scanned code IS, in the context of the step that asked for it. */
export function resolveScan(code: string, c: ScanCtx): ScanResult {
  const { db, purpose: P, meta: m } = c;
  const f = c.d;
  const t = c.task;
  const x = db.lots[code];
  const loc = db.loc;
  const bad = (title: string, text: string, fix: string): ScanResult => ({ ok: false, code, title, text, fix });

  if (P === "badge") {
    const k = Object.keys(db.emp).find((e) => db.emp[e].badge === code);
    if (!k) return bad("This badge does not work", "This badge is old.", "Ask HR for a new badge. Or type your mobile number.");
    return { ok: true, code, kind: "emp", emp: k };
  }
  if (P === "home") {
    if (/^TASK-/.test(code) || /^SO-/.test(code) || db.orders[code]) {
      const tk = db.tasks.find((z) => taskCode(z) === code || z.order === code);
      if (!tk) return bad("Work not found", "We cannot find this work.", "Ask your supervisor.");
      if (c.area !== "head" && !(c.areas?.length ? c.areas : [c.area]).includes(tk.proc))
        return bad("This work is not yours", "It belongs to the " + tk.proc + " team.", "Give it to the " + tk.proc + " team. Scan only your work.");
      return { ok: true, code, kind: "task", task: tk.id };
    }
    if (x) return { ok: true, code, kind: "info", lot: code };
    return bad("We do not know this QR", "This is not a Mahek label.", "Scan the white Mahek label. If it is torn, pick from photos.");
  }
  if (!x) return bad("We do not know this QR", "We cannot read this label.", "Scan again, closer and in good light. Or pick from photos.");
  /* An allocated lot has already left free stock in the ERP — allocation takes
     it off the ledger — so loading asks about the ORDER before it asks
     whether anything is left. */
  if (P === "load" && t?.order) {
    const o = db.orders[t.order];
    const mine = o?.lines.some((ln) => ln.alloc.some((a) => a[0] === code));
    if (x.status === "shipped") return bad("Already sent on " + (x.order ?? "another order"), "It already left on another order.", "Keep it aside. Tell the dispatch head.");
    if (x.status === "incomplete") return bad("This box batch is not full", "Only " + x.avail + " of " + (db.box[x.item]?.batch ?? "?") + " boxes are packed.", "Do not load it. Tell the packing team.");
    if (!mine) return bad("Not on this order", code + " is not for " + t.order + ".", "Load only what the order shows. Ask the dispatch head.");
    if (f?.loads && f.loads[code] != null) return bad("Already scanned", "You scanned this one already.", "Scan the next lot.");
    if (x.loc !== loc) return bad("This lot is at " + x.loc, "It is not here at " + loc + ".", "Use one that is here. Ask the store team.");
    return { ok: true, code, kind: "lot", lot: code };
  }
  if (x.status === "used" || (x.avail <= 0 && x.type !== "pb")) return bad("This lot is empty", "Nothing is left in " + code + ".", "Keep this drum aside. Scan another one.");
  if (x.loc !== loc) return bad("This lot is at " + x.loc, "It is not here at " + loc + ".", "Use one that is here. Ask the store team.");
  if (x.status === "hold") return bad("Do not use this yet", "The quality team has not checked it.", "Scan another one, or ask the quality team.");

  if (P === "rm" && f && m.item) {
    const want = db.rm[m.item]?.n ?? m.item;
    if (x.type !== "rm") return bad("This is not raw material", "You scanned " + lotName(db, x) + ".", "This step needs " + want + ". Scan the drum label.");
    if (x.item !== m.item) return bad("Wrong material — this is " + (db.rm[x.item]?.n ?? x.item), "This step needs " + want + ".", "Scan the " + want + " drum.");
    if ((f.rm ?? []).some((r, i) => i !== m.idx && r.lot === code)) return bad("Already used in this batch", code + " is already added.", "Scan a different drum.");
  }
  if (P === "sfg" && f?.sku) {
    const want = db.sku[f.sku].sfg;
    if (x.type !== "sfg") return bad("This is not base liquid", "You scanned " + lotName(db, x) + ".", "Scan the base-liquid tank label.");
    if (x.item !== want) return bad("Wrong base — this is " + db.sfg[x.item]?.n, "This task fills " + db.sfg[want]?.n + ".", "Scan the " + db.sfg[want]?.short + " base tank.");
  }
  if (P === "pm" && f?.sku) {
    const want = db.sku[f.sku].pm;
    const nm = (k: string) => (db.pm[k] ?? k).replace("Empty ", "");
    if (x.type !== "pm") return bad("This is not an empty can", "You scanned " + lotName(db, x) + ".", "Scan the empty-can stack label.");
    if (x.item !== want) return bad("Wrong can — this is " + nm(x.item), "This task needs " + nm(want) + ".", "Scan the " + nm(want) + " stack.");
  }
  if (P === "fg" && f?.box) {
    const want = db.box[f.box].sku;
    if (x.type !== "fg") return bad("This is not a filled can", "You scanned " + lotName(db, x) + ".", "Scan the label on the filled-can pallet.");
    if (x.item !== want) return bad("Wrong product — this is " + lotName(db, x), "These boxes take " + db.sku[want].n + " " + db.sku[want].size + ".", "Scan the right pallet.");
    if ((f.fg ?? []).some((g) => g.lot === code)) return bad("Already scanned", "This lot is already in the list.", "Scan the next pallet.");
  }
  return { ok: true, code, kind: "lot", lot: code };
}

/* ------------------------------------------------------------- steps */

export function downCheck(d: Draft): string {
  if (d.down === null) return "Did the machine stop? Choose Yes or No";
  if (d.down && !d.downR) return "Choose why the machine stopped";
  if (d.down && !d.downMin) return "Enter how many minutes it stopped";
  return "";
}

/** "" when the step is complete; otherwise the one sentence that says what is missing. */
export function stepCheck(db: FactoryData, t: Task, d: Draft, key: string): string {
  const L = (code: string | null | undefined) => (code ? db.lots[code] : undefined);
  if (key === "team") return !d.team.owner ? "Choose who is in charge" : !d.team.op ? "Choose the machine operator" : "";
  if (key === "materials") {
    for (const r of d.rm ?? []) {
      const nm = db.rm[r.item]?.n ?? r.item;
      if (!r.lot) return r.extra ? "Scan the next " + nm + " drum, or remove it" : "Scan " + nm;
      if (!r.qty) return "Enter how much " + nm + " you used";
      const x = L(r.lot);
      if (!x) return "Scan " + nm + " again";
      if (r.qty > x.avail) return nm + ": only " + nf(x.avail) + " L in that lot";
    }
    /* What was poured of each material has to match the sheet, across all of
       its drums — a drum that runs short is topped up from another lot. */
    for (const m of rmTotals(d)) {
      const nm = db.rm[m.item]?.n ?? m.item;
      if (m.poured < m.need) return nm + ": " + nf(r3(m.need - m.poured)) + " L more needed — add another drum";
      if (m.poured > m.need) return nm + ": " + nf(r3(m.poured - m.need)) + " L more than the sheet — type less";
    }
    return downCheck(d);
  }
  if (key === "output") {
    if (!d.out) return "Enter how many litres were made";
    return downCheck(d);
  }
  if (key === "sfg") return d.sfg ? "" : "Scan the base-liquid tank";
  if (key === "pack") return d.pm ? "" : "Scan the empty-can stack";
  if (key === "count") {
    const k = db.sku[d.sku!];
    if (!d.filled) return "Enter how many were filled";
    if ((d.rej ?? 0) > d.filled) return "Damaged cannot be more than filled";
    if (d.rej && !d.rejR) return "Choose why they were damaged";
    const s = L(d.sfg), p = L(d.pm);
    if (!s || !p) return "Scan the base liquid and the empty cans again";
    if (d.filled * k.l > s.avail) return "Not enough base liquid — only " + nf(s.avail) + " L";
    if (d.filled > p.avail) return "Not enough empty cans — only " + nf(p.avail);
    return downCheck(d);
  }
  if (key === "fglot") return (d.fg ?? []).length ? "" : "Scan at least one filled-can pallet";
  if (key === "boxes") {
    const b = db.box[d.box!];
    const have = (d.fg ?? []).reduce((a, g) => a + (L(g.lot)?.avail ?? 0), 0);
    if (!d.boxes) return "Enter how many boxes you packed";
    if (d.boxes * b.cpb > have) return "Needs " + nf(d.boxes * b.cpb) + " cans — only " + nf(have) + " scanned";
    return downCheck(d);
  }
  if (key === "order") return db.orders[t.order!]?.blocked ?? "";
  if (key === "load") {
    const o = db.orders[t.order!];
    if (!o) return "This order is not ready yet. Wait for the office.";
    for (const ln of o.lines) {
      const given = ln.alloc.reduce((a, z) => a + z[1], 0);
      if (given < ln.qty) return "Scan " + ln.label.split(" · ")[0] + " — " + nf(given) + " of " + nf(ln.qty) + " " + ln.unit + " found";
    }
    for (const ln of o.lines)
      for (const a of ln.alloc) {
        const v = d.loads?.[a[0]];
        if (v == null) return "Scan " + a[0];
        if (v !== a[1]) return a[0] + ": load exactly " + a[1];
      }
    return "";
  }
  if (key === "checklist") {
    const n = CHECK_ITEMS.filter((c) => !d.checks?.[c[0]]).length;
    return n ? n + " check" + (n > 1 ? "s" : "") + " left" : !d.photo ? "Take a photo of the loaded vehicle" : "";
  }
  return "";
}

/** The first step that is not complete, or null — what the server asks before it posts anything. */
export function firstBlockedStep(db: FactoryData, t: Task, d: Draft): { step: string; msg: string } | null {
  for (const s of STEPS[t.proc as Proc]) {
    if (s === "review") continue;
    const msg = stepCheck(db, t, d, s);
    if (msg) return { step: s, msg };
  }
  return null;
}

/** Litres a batch was expected to make, and how far the actual is from it, in percent. */
export function mixDeviation(db: FactoryData, t: Task, d: Draft): { exp: number; dev: number; over: boolean } {
  const sf = db.sfg[t.item!];
  const exp = (d.batches ?? 1) * (d.ownRecipe ? batchLitres(recipeLines(db, t, d)) : sf.batch);
  const dev = d.out ? ((d.out - exp) / exp) * 100 : 0;
  return { exp, dev, over: !!d.out && Math.abs(dev) > sf.tol };
}

/* ------------------------------------------------- mixing, the worker's recipe */

export type RecipeLine = { item: string; per: number | null };

/** What one batch of this job takes: the batch sheet, or the worker's own recipe once he has replaced it — one line per material, in order. */
export function recipeLines(db: FactoryData, t: Task, d: Draft | null | undefined): { item: string; per: number }[] {
  if (d?.ownRecipe) {
    const seen = new Set<string>();
    return (d.rm ?? []).filter((r) => (seen.has(r.item) ? false : (seen.add(r.item), true))).map((r) => ({ item: r.item, per: r.per }));
  }
  return (db.sfg[t.item!]?.recipe ?? []).map((r) => ({ item: r[0], per: r[1] }));
}

/** The litres one batch makes on a recipe: what goes in. */
export function batchLitres(lines: { per: number | null }[]): number {
  return r3(lines.reduce((a, l) => a + (l.per ?? 0), 0));
}

/** Why a recipe the worker wrote cannot be used yet, or null. The same sentence on the phone and on the server. */
export function recipeProblem(lines: RecipeLine[], rm: Record<string, { n: string }>): string | null {
  if (!lines.length) return "Add at least one material.";
  const seen = new Set<string>();
  for (const l of lines) {
    const m = rm[l.item];
    if (!m) return "A material in this recipe is not in the ERP any more. Take it off.";
    if (seen.has(l.item)) return m.n + " is in the recipe twice.";
    seen.add(l.item);
    if (!(l.per != null && l.per > 0)) return m.n + " needs litres before you can use this recipe.";
  }
  return null;
}

/** The drum lines a recipe starts with: one per material, nothing scanned yet. */
export function recipeRm(lines: { item: string; per: number }[]): RmLine[] {
  return lines.map((l) => ({ item: l.item, per: l.per, lot: null, qty: null }));
}

/* ---------------------------------------------------- mixing, drum by drum */

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** What the sheet asks of each material and what has been poured of it, across every drum of it. A material the sheet asks none of is not held to anything. */
export function rmTotals(d: Draft): { item: string; need: number; poured: number }[] {
  const out = new Map<string, { item: string; need: number; poured: number }>();
  for (const r of d.rm ?? []) {
    const m = out.get(r.item) ?? { item: r.item, need: r3(r.per * (d.batches ?? 1)), poured: 0 };
    m.poured = r3(m.poured + (r.qty ?? 0));
    out.set(r.item, m);
  }
  return [...out.values()].filter((m) => m.need > 0);
}

/** The litres a mixing batch made: what the worker read off the tank where an older page asked, otherwise everything poured — the materials match the sheet, so the batch is the sheet. */
export function mixMade(d: Draft): number {
  return d.out ?? r3((d.rm ?? []).reduce((a, r) => a + (r.qty ?? 0), 0));
}

/** One drum's place in its material: the sheet's figure, what the OTHER drums of it already give, what is still owed with them counted, and whether it is the material's last drum (where "Add another drum" goes). */
export function rmPlan(d: Draft, i: number): { need: number; others: number; rest: number; poured: number; last: boolean } {
  const rm = d.rm ?? [], r = rm[i];
  const need = r3(r.per * (d.batches ?? 1));
  let others = 0, last = true;
  rm.forEach((z, j) => {
    if (z.item !== r.item || j === i) return;
    others += z.qty ?? 0;
    if (j > i) last = false;
  });
  others = r3(others);
  const poured = r3(others + (r.qty ?? 0));
  return { need, others, rest: Math.max(0, r3(need - others)), poured, last };
}

/** The lines with one more drum of line i's material, placed after its last drum. */
export function addRmDrum(rm: RmLine[], i: number): RmLine[] {
  const r = rm[i];
  let at = i;
  rm.forEach((z, j) => { if (z.item === r.item) at = j; });
  return [...rm.slice(0, at + 1), { item: r.item, per: r.per, lot: null, qty: null, extra: true }, ...rm.slice(at + 1)];
}

/** The lines without drum i — only a drum the worker added can be taken off; the sheet's own lines stay. */
export function removeRmDrum(rm: RmLine[], i: number): RmLine[] {
  return rm[i]?.extra ? rm.filter((_, j) => j !== i) : rm;
}

/** Packing: what the boxes add up to with the open batch carried in. */
export function packSplit(db: FactoryData, t: Task, boxes: number) {
  const b = db.box[t.item!];
  const total = (t.carry || 0) + boxes;
  return { total, full: Math.floor(total / b.batch), rem: total % b.batch, batch: b.batch };
}

/** Status of a job on the head's list: [label, bg, fg, group]. */
export function jobStatus(t: Task, now: string, started: boolean): [string, string, string, string] {
  if (t.status === "done") return ["Done", "#E9F5EE", "#1D7A45", "done"];
  if (t.status === "pending") return ["Waiting to send", "#FDF6E7", "#8A5C05", "progress"];
  if (t.status === "held") return ["To check", "#FDF6E7", "#8A5C05", "progress"];
  if (t.status === "blocked") return ["Blocked", "#F7F8FA", "#3D4453", "blocked"];
  if (t.due < now) return ["Late", "#FCECEC", "#B3261E", "late"];
  if (started) return ["Working", "#F1ECFF", "#5223E0", "progress"];
  return ["Not started", "#F7F8FA", "#3D4453", "todo"];
}

/* ------------------------------------------------------------- old phones */

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

/**
 * Any draft any version of the phone has sent, as today's shape.
 *
 * A station phone can sit on a page loaded days ago, and its queue holds
 * work saved under that page's idea of a draft. So this never REFUSES a shape
 * — numbers that arrive as text are read as numbers, a field an old page did
 * not have gets the value that page meant by leaving it out, and a field it
 * does not recognise is dropped rather than failing the send. A missing team
 * stays missing: inventing one would credit people who did not do the work.
 */
export function normalizeDraft(raw: unknown, v = 1): Draft {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tm = (r.team && typeof r.team === "object" ? r.team : {}) as Record<string, unknown>;
  void v; // v1 and v2 drafts are the same shape; a v3 that renames a field reads it here.
  const d: Draft = {
    team: { owner: str(tm.owner), op: str(tm.op ?? tm.operator), helpers: ids(tm.helpers), ver: str(tm.ver ?? tm.verifier) },
    down: r.down == null ? null : !!r.down,
    downR: str(r.downR),
    downMin: num(r.downMin),
  };
  if (r.batches != null) d.batches = num(r.batches) ?? 1;
  if (Array.isArray(r.rm))
    d.rm = r.rm.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { item: String(o.item ?? ""), per: num(o.per) ?? 0, lot: str(o.lot), qty: num(o.qty), manual: !!o.manual, ...(o.extra ? { extra: true } : {}) };
    });
  if (r.ownRecipe) d.ownRecipe = true;
  if (r.out !== undefined) d.out = num(r.out);
  if (r.sku !== undefined) d.sku = String(r.sku);
  if (r.sfg !== undefined) { d.sfg = str(r.sfg); d.sfgManual = !!r.sfgManual; }
  if (r.fromLot) d.fromLot = String(r.fromLot);
  if (r.pm !== undefined) { d.pm = str(r.pm); d.pmManual = !!r.pmManual; }
  if (r.filled !== undefined) d.filled = num(r.filled);
  if (r.rej !== undefined) d.rej = num(r.rej) ?? 0;
  if (r.rejR !== undefined) d.rejR = str(r.rejR);
  if (r.box !== undefined) d.box = String(r.box);
  if (Array.isArray(r.fg)) d.fg = r.fg.map((g) => ({ lot: String((g as Record<string, unknown>)?.lot ?? g), manual: !!(g as Record<string, unknown>)?.manual }));
  if (r.boxes !== undefined) d.boxes = num(r.boxes);
  if (r.loads && typeof r.loads === "object") d.loads = Object.fromEntries(Object.entries(r.loads as Record<string, unknown>).map(([k, x]) => [k, num(x)]));
  if (r.loadsManual && typeof r.loadsManual === "object") d.loadsManual = Object.fromEntries(Object.entries(r.loadsManual as Record<string, unknown>).map(([k, x]) => [k, !!x]));
  if (r.checks && typeof r.checks === "object") d.checks = Object.fromEntries(Object.entries(r.checks as Record<string, unknown>).map(([k, x]) => [k, !!x]));
  if (r.photo !== undefined) d.photo = str(r.photo);
  if (r.photoId !== undefined) d.photoId = str(r.photoId);
  return d;
}

/** When the work was saved on the phone. v1 sent only "HH:MM"; read it as today. */
export function savedInstant(savedAt: string | undefined, now: Date): Date {
  if (savedAt && /^\d{4}-\d{2}-\d{2}T/.test(savedAt)) {
    const d = new Date(savedAt);
    /* A phone whose clock runs ahead cannot have saved work in the future. */
    if (!Number.isNaN(d.getTime())) return d.getTime() > now.getTime() ? now : d;
  }
  return now;
}

/* ------------------------------------------------------------ departments on the phone */

const PROC_LIST: Proc[] = ["mixing", "filling", "packing", "dispatch"];

/** What the phone needs to know about the signed-in person to place them on the floor. */
export type DeptMe = { head: boolean; area: string; areas?: string[]; scope?: Proc | null; scopes?: Proc[] | null };

/**
 * The production departments this person works — or, for a supervisor, runs.
 * A newer server sends `areas` and `scopes`; an older one sends one `area`
 * and one `scope`, read here as a list of one, so both draw the same app.
 */
export function myDepts(me: DeptMe): Proc[] {
  if (me.head) {
    const s = me.scopes !== undefined ? me.scopes : me.scope ? [me.scope] : null;
    return s && s.length ? PROC_LIST.filter((p) => s.includes(p)) : PROC_LIST.slice();
  }
  const a = me.areas?.length ? me.areas : [me.area];
  return PROC_LIST.filter((p) => a.includes(p));
}

/**
 * The department the phone is showing: the one picked, while it is still one
 * of theirs; null is all of them. With one department there is nothing to
 * pick, and the answer is that department.
 */
export function activeDept(me: DeptMe, picked: string | null | undefined): Proc | null {
  const d = myDepts(me);
  if (d.length === 1) return d[0];
  return picked && (d as string[]).includes(picked) ? (picked as Proc) : null;
}

/**
 * May this person start a mixing batch on their own, with nobody giving it?
 * A mixing worker can: the recipe is the approved batch sheet, so what he may
 * make is already decided, and waiting for a supervisor to type it in left
 * the floor idle. A supervisor gives tasks instead, so the button is theirs
 * only where it is not already on their Today screen.
 */
export const startsOwnBatch = (me: DeptMe) => !me.head && myDepts(me).includes("mixing");

/** Does a task belong on the screen under this pick? Null shows every department of theirs. */
export const inDept = (me: DeptMe, picked: Proc | null, proc: Proc) => (picked ? proc === picked : myDepts(me).includes(proc));

/** Does this person work in this department? Their home one, or any of `areas`. */
export const worksIn = (e: { area: string; areas?: string[] }, area: string) => e.area === area || !!e.areas?.includes(area);

/** Each department's tint on the phone — a well behind its icon, the same on every screen. [background, ink] */
export const DEPT_TINT: Record<Proc, [string, string]> = {
  mixing: ["#EDF2FC", "#2B5CBF"],
  filling: ["#FDF6E7", "#8A5C05"],
  packing: ["#E9F5EE", "#1D7A45"],
  dispatch: ["#F1ECFF", "#3D14A8"],
};

/* ------------------------------------------------------------ filling from a scanned lot */

/** The most cans one filling started from a scanned lot may ask for — the same ceiling Give a task has. */
export const FILL_FROM_LOT_MAX = 5000;

export type FillFromLot =
  | { ok: true; lot: Lot; skus: string[] }
  /** `show` false: not this person's work, so the card offers OK only and no refusal. */
  | { ok: false; show: boolean; title: string; text: string };

/**
 * May the person who scanned this SFG lot start a filling from it, and which
 * products may it fill? The server asks the same question again
 * (`startFillFromLot`) — this is only what the scan card draws. A mixing or
 * packing worker sees the lot and nothing to press, a supervisor of another
 * department is told it is not theirs, and anybody who fills is told in words
 * why a lot they cannot use cannot be used.
 */
export function fillFromLot(me: DeptMe, db: Pick<FactoryData, "lots" | "sku" | "loc">, code: string): FillFromLot | null {
  const lot = db.lots[code];
  if (!lot || lot.type !== "sfg") return null;
  if (!myDepts(me).includes("filling"))
    return { ok: false, show: me.head, title: "Not your work", text: "Filling is for the filling team. Tell your supervisor." };
  if (lot.loc !== db.loc) return { ok: false, show: true, title: "At another godown", text: "This lot is at " + lot.loc + ", not " + db.loc + "." };
  if (lot.status === "used" || !(lot.avail > 0)) return { ok: false, show: true, title: "Nothing left", text: lot.code + " is empty. Scan another lot." };
  if (lot.status !== "ok")
    return { ok: false, show: true, title: "Cannot fill yet", text: "The quality team has not approved this lot. Ask them, or scan another lot." };
  const skus = Object.keys(db.sku)
    .filter((k) => db.sku[k].sfg === lot.item)
    .sort((a, b) => db.sku[a].l - db.sku[b].l || db.sku[a].n.localeCompare(db.sku[b].n));
  if (!skus.length) return { ok: false, show: true, title: "No product for this base", text: "No FG product is made from it. Ask the office." };
  return { ok: true, lot, skus };
}

/** How many cans the New filling sheet starts at: what the lot fills, at most 40. */
export function fillStartQty(litres: number, avail: number): number {
  if (!(litres > 0)) return 1;
  return Math.max(1, Math.min(40, Math.floor(avail / litres)));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-12" → "12 Oct". Read off the string, so no time zone can move the day. */
export function shortDay(ymd: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? "");
  return m ? Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] : "—";
}

/** How a fill product leaves the line, for the line under its tile: "6 / box", "Drum", "No can" or "Loose". */
export function skuPackLine(db: Pick<FactoryData, "sku" | "box">, key: string): string {
  const k = db.sku[key];
  if (!k) return "";
  const boxes = Object.values(db.box).filter((b) => b.sku === key).map((b) => b.cpb);
  if (boxes.length) return Math.max(...boxes) + " / box";
  if (k.kind === "drum") return "Drum";
  if (!k.pm) return "No can";
  return "Loose";
}

/** Empty cans (or drums) of this product's packing at the person's godown — the same figure the fill checks. */
export function emptyPackHere(db: Pick<FactoryData, "lots" | "loc">, pm: string): number | null {
  if (!pm) return null;
  const here = Object.values(db.lots).find((l) => l.type === "pm" && l.item === pm && l.loc === db.loc);
  return here ? here.avail : 0;
}

/* ------------------------------------------------------------ packing from a scanned lot */

/** The most boxes one packing started from a scanned lot may ask for — the same ceiling Give a task has. */
export const PACK_FROM_LOT_MAX = 5000;

export type PackFromLot =
  | { ok: true; lot: Lot; boxes: string[] }
  /** `show` false: not this person's work, so the card offers OK only and no refusal. */
  | { ok: false; show: boolean; title: string; text: string };

/**
 * May the person who scanned this FG lot start a packing from it, and into
 * which boxes? The ERP's New packing batch question — the FG product is the
 * lot's, the box is one of that product's boxed SKUs — asked on the scan card.
 * The server asks it again (`startPackFromLot`).
 */
export function packFromLot(me: DeptMe, db: Pick<FactoryData, "lots" | "sku" | "box" | "loc">, code: string): PackFromLot | null {
  const lot = db.lots[code];
  if (!lot || lot.type !== "fg") return null;
  if (!myDepts(me).includes("packing"))
    return { ok: false, show: me.head, title: "Not your work", text: "Packing is for the packing team. Tell your supervisor." };
  if (lot.loc !== db.loc) return { ok: false, show: true, title: "At another godown", text: "This lot is at " + lot.loc + ", not " + db.loc + "." };
  if (lot.status === "used" || !(lot.avail > 0)) return { ok: false, show: true, title: "Nothing left", text: lot.code + " is empty. Scan another lot." };
  const boxes = Object.keys(db.box)
    .filter((b) => db.box[b].sku === lot.item)
    .sort((a, b) => db.box[b].cpb - db.box[a].cpb || a.localeCompare(b));
  const k = db.sku[lot.item];
  const name = k ? k.n + " " + k.size : "This product";
  if (!boxes.length)
    return { ok: false, show: true, title: "Not packed in boxes", text: name + (k?.kind === "drum" ? " goes out in drums." : " goes out loose.") + " There is nothing to pack." };
  const least = Math.min(...boxes.map((b) => db.box[b].cpb));
  if (lot.avail < least)
    return { ok: false, show: true, title: "Not enough for one box", text: lot.code + " has " + nf(lot.avail) + " cans; a box takes " + least + ". Scan another pallet." };
  return { ok: true, lot, boxes };
}

/** How many boxes the New packing batch sheet starts at: what the lot fills, at least 1. */
export function packStartQty(cpb: number, avail: number): number {
  return Math.max(1, Math.floor(avail / Math.max(1, cpb)));
}

/**
 * Where a count of boxes goes in the ERP: into the open batch of this box
 * first, as far as it has room, then into new batches of `batch` boxes. A new
 * batch takes ALL its empty boxes on its first line, whatever is packed into
 * it today (the ERP's New packing batch does exactly that), and an open batch
 * has already taken its own — the same arithmetic the posting's plan follows.
 */
export function packBatchPlan(boxes: number, batch: number, open: { have: number; of: number } | null, emptyPerBox: number) {
  const intoOpen = open ? Math.max(0, Math.min(boxes, open.of - open.have)) : 0;
  const newBatches = Math.ceil(Math.max(0, boxes - intoOpen) / Math.max(1, batch));
  return { intoOpen, newBatches, emptyNeed: newBatches * batch * emptyPerBox };
}

export type PackNeeds = {
  cans: number;
  /** The open batch of this box at this godown, and how many boxes it holds of how many. */
  open: { code: string; have: number; of: number } | null;
  intoOpen: number;
  newBatches: number;
  emptyNeed: number;
  /** Empty boxes of this box's type at the godown; null where the ERP does not count them. */
  emptyHave: number | null;
};

/** What packing `boxes` of box SKU `key` needs, as the sheet says it. */
export function packNeeds(db: Pick<FactoryData, "lots" | "box" | "loc" | "emptyBoxes">, key: string, boxes: number): PackNeeds {
  const b = db.box[key];
  const pb = Object.values(db.lots).find((l) => l.type === "pb" && l.status === "incomplete" && l.item === key && l.loc === db.loc);
  const open = pb ? { code: pb.code, have: pb.avail, of: b.batch } : null;
  const plan = packBatchPlan(boxes, b.batch, open, b.empty ?? 1);
  const have = db.emptyBoxes?.[key];
  return { cans: boxes * b.cpb, open, ...plan, emptyHave: have == null ? null : have };
}

/** Why the empty boxes will not do, or null. The same sentence on the sheet and from the server. */
export function emptyBoxShort(need: number, have: number | null, newBatches: number, batch: number, type: string, where: string): string | null {
  if (have == null || need <= have + 1e-9) return null;
  return (newBatches > 1 ? newBatches + " new batches of " : "A new batch of ") + batch + " boxes takes " + nf(need) + " empty " + type + "; " + nf(Math.max(0, have)) + " are at " + where + ".";
}
