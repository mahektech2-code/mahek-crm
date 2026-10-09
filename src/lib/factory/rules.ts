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
import type { Draft, FactoryData, Lot, Proc, Task } from "./types";
import { CHECK_ITEMS, STEPS } from "./types";

export const nf = (n: number | null | undefined) => Number(n || 0).toLocaleString("en-IN");

export type ScanPurpose = "badge" | "home" | "rm" | "sfg" | "pm" | "fg" | "load";
export type ScanMeta = { item?: string; idx?: number };
export type ScanResult =
  | { ok: false; code: string; title: string; text: string; fix: string }
  | { ok: true; code: string; kind: "emp"; emp: string }
  | { ok: true; code: string; kind: "task"; task: string }
  | { ok: true; code: string; kind: "info" | "lot"; lot: string };

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

/* ------------------------------------------------------------- scanning */

type ScanCtx = {
  db: FactoryData;
  purpose: ScanPurpose;
  meta: ScanMeta;
  /** The signed-in person's work area; a head can open anybody's task. */
  area?: string;
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
      if (c.area !== "head" && tk.proc !== c.area)
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
      if (!r.lot) return "Scan " + nm;
      if (!r.qty) return "Enter how much " + nm + " you used";
      const x = L(r.lot);
      if (!x) return "Scan " + nm + " again";
      if (r.qty > x.avail) return nm + ": only " + nf(x.avail) + " L in that lot";
    }
    return "";
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
  const exp = (d.batches ?? 1) * sf.batch;
  const dev = d.out ? ((d.out - exp) / exp) * 100 : 0;
  return { exp, dev, over: !!d.out && Math.abs(dev) > sf.tol };
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
      return { item: String(o.item ?? ""), per: num(o.per) ?? 0, lot: str(o.lot), qty: num(o.qty), manual: !!o.manual };
    });
  if (r.out !== undefined) d.out = num(r.out);
  if (r.sku !== undefined) d.sku = String(r.sku);
  if (r.sfg !== undefined) { d.sfg = str(r.sfg); d.sfgManual = !!r.sfgManual; }
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
