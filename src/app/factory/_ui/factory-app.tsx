"use client";

import { Component, type CSSProperties, type ReactNode } from "react";
import { L, STEP_T, type Lang, type Words } from "@/lib/factory/i18n";
import {
  worksIn,
  myDepts,
  inDept,
  DEPT_TINT,
  activeDept,
  downCheck,
  addRmDrum,
  removeRmDrum,
  rmPlan,
  batchLitres,
  recipeLines,
  recipeProblem,
  recipeRm,
  jobStatus,
  lotName,
  lotUnit,
  mixDeviation,
  mixMade,
  nf,
  resolveScan,
  startsOwnBatch,
  stepCheck,
  taskCode,
  taskName,
  typedCode,
  taskTarget,
  type ScanMeta,
  type ScanPurpose,
  type ScanResult,
} from "@/lib/factory/rules";
import { CHECK_ITEMS, DOWN, MIX_BATCH_MAX, OFFLINE_HOURS, REJ, STEPS, SUBMISSION_VERSION, type CheckStage, type CheckUnit, type QcLot, type Draft, type FactoryData, type Lot, type Proc, type ReqDept, type ReqItem, type ReqLine, type SubmitResult, type Task, type Team } from "@/lib/factory/types";
import { hhmm } from "@/lib/factory/time";
import type { Me } from "@/lib/actions/factory";
import { call, NotReceived, PAGE_BUILD, watchBuild } from "./api";
import { art, ic, qr } from "./art";
import { avStyle, btn, card, initials, mono, msg, MsgBox, Pill, artWell, type Msg } from "./kit";
import { CameraScanner, shrinkPhoto } from "./camera";
import { dropPhoto, forget, keepPhoto, keptPhoto, load, mintKey, readNet, save, type Flow, type KpSheet, type Net, type PeopleSheet, type QItem, type ReasonSheet, type Res, type State, type TilesSheet, mintDrumKey, type StockEntry, type QcEntry, mintCheckKey, type RecipeSheet, type ReqEntry, mintReqKey } from "./model";

/* ---------------------------------------------------------------------------
 * THE FACTORY APP — "Mahek Factory App" from the design, screen for screen.
 *
 * One task per screen, scan first, pictures before words, and nothing called
 * "Saved" until the server says so (PRD §4). The styles are the design's own
 * values, copied rather than approximated: this is a screen for somebody who
 * learns where a button is and stops reading, so moving one by a few pixels
 * between the design and the build is a regression, not a refinement.
 *
 * It is a class because the design is one — every handler reads the live
 * state the way the prototype's did, which is what kept the port faithful.
 * ------------------------------------------------------------------------- */

type Props = { initialMe: Me | null; initialData: FactoryData | null; dev: boolean };


/* Purchase requirement: each buying department, as the More row names it. */
const REQ_WORD: Record<ReqDept, string> = { mixing: "Mixing", filling: "Refilling", packing: "Packing" };

/* Stock check: how a unit and a kind of stock are said on the floor. */
const UNIT_WORD: Record<CheckUnit, string> = { Ltr: "litres", Pcs: "pieces", Cans: "cans", Boxes: "boxes" };
const UNIT_SHORT: Record<CheckUnit, string> = { Ltr: "L", Pcs: "pcs", Cans: "cans", Boxes: "boxes" };
const STAGE_WORD: Record<CheckStage, string> = { rm: "Raw material", sfg: "Semi-finished", fg: "Filled cans", pack: "Packed boxes" };
const MISMATCH_REASONS = ["Not entered yet", "Used in production", "Moved to another place", "Damaged or leaked", "Counted wrong before", "Not sure"];

const PC: Record<Proc, string> = { mixing: "flask", filling: "fill", packing: "box", dispatch: "truck" };
const LI: Record<Lang, number> = { en: 0, hi: 1, mr: 2 };
const LANG_SPEECH: Record<Lang, string> = { en: "en-IN", hi: "hi-IN", mr: "mr-IN" };
const HELP: [string, string, string, string, string[]][] = [
  ["scan", "How to scan a label", "0:40", "qr", ["Hold the phone 20 cm from the label.", "Keep the QR inside the green box.", 'If it is torn, tap "Choose by photo".']],
  ["mixing", "Saving a mixing batch", "1:20", "flask", ["Scan each drum before you pour.", "Enter how many litres you poured.", "Read the tank gauge and enter litres made."]],
  ["filling", "Choosing the right can size", "0:50", "fill", ["Look at the task sheet for the size.", "Tap the same size picture.", "Scan the empty-can stack."]],
  ["packing", "Why some boxes wait", "0:45", "box", ["A batch is full at 50 boxes.", "Extra boxes wait.", "They wait for the next batch."]],
  ["dispatch", "Wrong lot warning", "0:35", "truck", ["Scan every pallet before loading.", "A red screen means stop.", "Load only the lots on the order."]],
  ["sync", "Waiting to send", "0:30", "clock", ["No network? Keep working.", "Your jobs wait on the phone.", "They send by themselves later."]],
];

export class FactoryApp extends Component<Props, State> {
  private ivs: number[] = [];
  private tt = 0;
  private ot = 0;
  private photoInput: HTMLInputElement | null = null;

  constructor(props: Props) {
    super(props);
    this.state = {
      lang: props.initialMe?.lang ?? "en",
      me: props.initialMe,
      db: props.initialData,
      signStep: "lang",
      phone: "",
      idErr: "",
      otp: "",
      otpErr: "",
      otpT: 0,
      otpTo: "",
      pinFor: null,
      pin: "",
      pinErr: "",
      newPin: "",
      newPin1: "",
      route: props.initialMe?.head ? "today" : "home",
      dept: null,
      scan: null,
      flow: null,
      result: null,
      sheet: null,
      net: "online",
      toast: "",
      toastTone: "ok",
      play: null,
      hf: "all",
      asg: null,
      started: {},
      drafts: {},
      results: {},
      queue: [],
      sending: false,
      busy: false,
      refreshing: false,
      clock: "",
      cam: "wait",
      drum: null,
      stock: null,
      qc: null,
      req: null,
      newBuild: false,
    };
  }

  /* ================================================================ life */

  componentDidMount() {
    const lang = load<Lang | null>(null, "lang", null);
    /* OPENED WITH NO NETWORK: the page may be the service worker's copy from
       yesterday, so the person and the floor come from whichever is newer —
       what the page was rendered with, or what this phone last saved. */
    const cachedMe = load<Me | null>(null, "me", null);
    const me = this.state.me ?? (!navigator.onLine ? cachedMe : null);
    const cached = me ? load<FactoryData | null>(me.key, "data", null) : null;
    const db = this.state.db && cached ? (cached.at > this.state.db.at ? cached : this.state.db) : (this.state.db ?? cached);
    this.setState({
      clock: hhmm(new Date()),
      net: readNet(),
      signStep: lang ? "id" : "lang",
      lang: me?.lang ?? lang ?? "en",
      ...(me && db ? { me, db, route: me.head ? "today" : "home" } : null),
      ...(me ? this.restore(me.key) : null),
    } as Pick<State, "clock">, () => void this.flushQueue());
    watchBuild(() => this.setState({ newBuild: true }, () => this.maybeReload()));
    /* The app opens with no network because a service worker keeps its page
       and its scripts. Not in development, where it would serve yesterday's
       code to the person writing today's. */
    if ("serviceWorker" in navigator && (!this.props.dev || location.search.includes("sw=1")))
      navigator.serviceWorker.register("/factory-sw.js", { scope: "/factory" }).catch(() => {});
    this.ivs.push(window.setInterval(() => void this.flushQueue(), 30_000));
    document.addEventListener("visibilitychange", this.onVisible);
    this.ivs.push(window.setInterval(() => this.setState({ clock: hhmm(new Date()) }), 15_000));
    this.ivs.push(
      window.setInterval(() => {
        const p = this.state.play;
        if (p && p.on) this.setState({ play: { ...p, t: Math.min(p.t + 1, p.dur), on: p.t + 1 < p.dur } });
      }, 1000),
    );
    /* New work reaches the phone without anybody pressing anything. */
    this.ivs.push(window.setInterval(() => this.poll(), 45_000));
    window.addEventListener("online", this.onNet);
    window.addEventListener("offline", this.onNet);
    (navigator as unknown as { connection?: EventTarget }).connection?.addEventListener?.("change", this.onNet);
  }

  componentWillUnmount() {
    this.ivs.forEach((i) => clearInterval(i));
    clearTimeout(this.tt);
    clearInterval(this.ot);
    window.removeEventListener("online", this.onNet);
    window.removeEventListener("offline", this.onNet);
    document.removeEventListener("visibilitychange", this.onVisible);
    try {
      window.speechSynthesis?.cancel();
    } catch {}
  }

  private restore(me: string) {
    return {
      queue: load<QItem[]>(me, "queue", []),
      drafts: load<Record<string, Flow>>(me, "drafts", {}),
      started: load<Record<string, 1>>(me, "started", {}),
      results: load<Record<string, SubmitResult>>(me, "results", {}),
      dept: load<Proc | null>(me, "dept", null),
    };
  }

  componentDidUpdate(_: Props, prev: State) {
    const me = this.state.me?.key ?? null;
    if (!me) return;
    if (prev.db !== this.state.db && this.state.db) save(me, "data", this.state.db);
    if (prev.me !== this.state.me) save(null, "me", this.state.me);
    if (this.state.newBuild && (prev.flow !== this.state.flow || prev.result !== this.state.result || prev.queue !== this.state.queue || prev.sheet !== this.state.sheet || prev.scan !== this.state.scan)) this.maybeReload();
    if (prev.queue !== this.state.queue) save(me, "queue", this.state.queue);
    if (prev.drafts !== this.state.drafts) save(me, "drafts", this.state.drafts);
    if (prev.started !== this.state.started) save(me, "started", this.state.started);
    if (prev.results !== this.state.results) save(me, "results", this.state.results);
  }

  private onNet = () => this.setNet(readNet());
  private onVisible = () => {
    if (document.visibilityState === "visible") void this.flushQueue();
  };

  /**
   * A newer build is live. Reload — but only when nothing is in somebody's
   * hands: no job open, no scan, no sheet, no result on screen, nothing
   * waiting to send. Anything half-done is in this phone's storage anyway;
   * waiting for a quiet moment is what keeps a reload from ever looking like
   * the app lost their place.
   */
  private maybeReload() {
    const st = this.state;
    if (!st.newBuild || st.flow || st.scan || st.sheet || st.result || st.sending || st.busy) return;
    if (st.queue.some((x) => x.status === "pending")) return;
    window.location.reload();
  }

  private setNet(n: Net) {
    this.setState({ net: n }, () => {
      if (n !== "offline") void this.flushQueue();
    });
  }

  /* WHO THEY ARE comes back on every refresh, not only at sign-in. A manager
     changing somebody from in charge to helper, adding a department or taking
     one away used to reach this phone only on the next sign-in: the server
     already refused what the old role could no longer do, while the screen
     went on drawing it. The language stays the one chosen on this phone. */
  private refreshed(cur: State, fresh: Me | undefined, data: FactoryData): Pick<State, "db"> | Pick<State, "db" | "me" | "route" | "sheet"> {
    const was = cur.me;
    if (!fresh || !was || fresh.key !== was.key) return { db: data };
    const me: Me = { ...fresh, lang: was.lang };
    const r = cur.route;
    /* A screen the new role does not have is left for the role's own start. */
    const headOnly = r === "today" || r === "review" || r === "teams" || r === "machines";
    const lost =
      (headOnly && !me.head) ||
      (r === "home" && me.head) ||
      (r === "drum" && me.drums === false) ||
      (r === "lr" && !me.dispatch) ||
      (r === "qc" && me.qc === false) ||
      (r === "req" && !me.reqs?.length);
    return lost ? { db: data, me, route: me.head ? "today" : "home", sheet: null } : { db: data, me, route: r, sheet: cur.sheet };
  }

  private async poll() {
    const st = this.state;
    if (!st.me || st.net === "offline" || st.sending || st.busy) return;
    if (st.queue.some((x) => x.status === "pending")) return void this.flushQueue();
    try {
      const r = await call("bootstrap");
      if (r.ok) this.setState((cur) => this.refreshed(cur, r.me, r.data));
      else if (r.error === "signedOut") this.setState({ me: null, db: null, signStep: "id" });
    } catch {
      this.setNet("offline");
    }
  }

  /**
   * The refresh button: send what is waiting and fetch the latest from the
   * office. The phone app also asks whether a newer APK is out; a page picks
   * up a new build by itself (`watchBuild`), so there is nothing to ask here.
   */
  private async refreshAll() {
    const st = this.state;
    if (st.refreshing) return;
    if (st.net === "offline") return this.toast("No network. Your work is saved and will send by itself.", "warn");
    this.setState({ refreshing: true });
    try {
      await this.flushQueue();
      const r = this.state.me ? await call("bootstrap").catch(() => null) : null;
      if (r && r.ok) this.setState({ db: r.data });
      else if (r && r.error === "signedOut") return this.setState({ me: null, db: null, signStep: "id" });
      this.toast(r && r.ok ? "Up to date. The latest work from the office is on your phone." : "Could not refresh now. Try again in a minute.", r && r.ok ? "ok" : "warn");
    } finally {
      this.setState({ refreshing: false });
    }
  }

  /* ================================================================ helpers */

  T(): Words {
    return L[this.state.lang];
  }
  li() {
    return LI[this.state.lang];
  }
  now() {
    return this.state.clock || hhmm(new Date());
  }
  db(): FactoryData {
    return this.state.db!;
  }
  av(key: string, s?: number): CSSProperties {
    const db = this.state.db;
    const i = db ? Object.keys(db.emp).indexOf(key) : 0;
    return avStyle(i < 0 ? key.length : i, s);
  }
  ini(key: string) {
    const e = this.state.db?.emp[key];
    return e ? initials(e.n) : "?";
  }
  name(key: string | null | undefined) {
    return key ? (this.state.db?.emp[key]?.n ?? "—") : "—";
  }

  /** `warn` for a refusal or an instruction — a tick there would read as done. */
  toast(t: string, tone: "ok" | "warn" = "ok") {
    clearTimeout(this.tt);
    this.setState({ toast: t, toastTone: tone });
    this.tt = window.setTimeout(() => this.setState({ toast: "" }), 3200);
  }

  speak(text: string) {
    try {
      const u = new window.SpeechSynthesisUtterance(text);
      u.lang = LANG_SPEECH[this.state.lang];
      u.rate = 0.92;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
      this.toast(this.T().listen + " · " + text.slice(0, 60) + (text.length > 60 ? "…" : ""));
    } catch {
      this.toast("Audio is not available on this phone");
    }
  }

  /** Today's work, with anything still waiting in this phone's queue shown as waiting. */
  /** The department the screen is showing, for somebody who works several; null is all of theirs. */
  dept(): Proc | null {
    const me = this.state.me;
    return me ? activeDept(me, this.state.dept) : null;
  }

  /** Switch the department the screens show. Remembered on this phone, per person. */
  pickDept(d: Proc | null) {
    const me = this.state.me!;
    save(me.key, "dept", d);
    /* No toast: the pill and the chips already say which work is showing. */
    this.setState({ dept: d, sheet: null, hf: "all" });
  }

  /** The department switch: a pill under the name for somebody who works more than one department. */
  deptPill(): ReactNode {
    const me = this.state.me!, T = this.T();
    if (myDepts(me).length < 2) return null;
    const d = this.dept();
    const tint = d ? DEPT_TINT[d] : ["#F1ECFF", "#3D14A8"];
    return (
      <button onClick={() => this.setState({ sheet: { type: "dept" } })} aria-label={T.whichWork} style={{ display: "inline-flex", alignItems: "center", gap: "6px", height: "28px", padding: "0 6px 0 10px", marginTop: "3px", borderRadius: "14px", border: "1.5px solid " + tint[1] + "33", background: tint[0], color: tint[1], fontSize: "13px", fontWeight: 700, cursor: "pointer", maxWidth: "100%" }}>
        {ic(d ? PC[d] : "list", 15)}
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d ? (T as Record<string, string>)[d] : T.allWork}</span>
        {ic("chev", 16)}
      </button>
    );
  }

  /** The department chips across the top of a list: all of theirs, then each one with its open jobs. */
  deptChips(): ReactNode {
    const me = this.state.me!, T = this.T();
    const ds = myDepts(me);
    if (ds.length < 2) return null;
    const d = this.dept();
    const open = (p: Proc | null) => this.tasks().filter((t) => t.status !== "done" && inDept(me, p, t.proc)).length;
    const chip = (p: Proc | null) => {
      const on = d === p;
      const n = open(p);
      return (
        <button key={p ?? "all"} onClick={() => !on && this.pickDept(p)} aria-pressed={on} style={{ flex: "none", display: "flex", alignItems: "center", gap: "6px", height: "40px", padding: "0 14px", borderRadius: "20px", border: on ? "none" : "1px solid #DDE1E8", background: on ? "#6835FB" : "#FFFFFF", color: on ? "#FFFFFF" : "#3D4453", fontSize: "14px", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
          {ic(p ? PC[p] : "list", 17, on ? "#FFFFFF" : undefined)}
          {p ? (T as Record<string, string>)[p] : T.allWork}
          <span style={{ minWidth: "22px", height: "22px", padding: "0 6px", borderRadius: "11px", background: on ? "rgba(255,255,255,0.22)" : n ? "#F1ECFF" : "#F7F8FA", color: on ? "#FFFFFF" : n ? "#3D14A8" : "#6B7385", fontSize: "12px", lineHeight: "22px", textAlign: "center" }}>{n}</span>
        </button>
      );
    };
    return (
      <div role="tablist" aria-label={T.whichWork} style={{ display: "flex", flexWrap: "wrap", gap: "8px", padding: "2px 0 4px 0" }}>
        {chip(null)}
        {ds.map((p) => chip(p))}
      </div>
    );
  }

  tasks(): Task[] {
    const db = this.state.db;
    if (!db) return [];
    const waiting = new Set(this.state.queue.filter((x) => x.status === "pending").map((x) => x.flow.task.id));
    return db.tasks.map((t) => (waiting.has(t.id) && t.status !== "done" ? { ...t, status: "pending" } : t));
  }
  task(id: string) {
    return this.tasks().find((t) => t.id === id);
  }

  taskArt(t: Task, s: number) {
    const db = this.db();
    if (t.proc === "mixing") {
      const f = db.sfg[t.item!];
      return art("tank", f?.col, f?.short, s);
    }
    if (t.proc === "filling") {
      const k = db.sku[t.item!];
      return art(k?.kind ?? "can", k?.col, k?.tag, s);
    }
    if (t.proc === "packing") {
      const b = db.box[t.item!], k = b && db.sku[b.sku];
      return art("box", k?.col, b ? b.cpb + "×" + k?.tag : "", s);
    }
    return art("truck", "", "", s);
  }

  lotArt(x: Lot | undefined, s: number) {
    if (!x) return null;
    const db = this.db();
    if (x.type === "rm") return art("rm", db.rm[x.item]?.col, db.rm[x.item]?.code, s);
    if (x.type === "sfg") {
      const f = db.sfg[x.item];
      return art("tank", f?.col, f?.short, s);
    }
    if (x.type === "pm") {
      const nm = (db.pm[x.item] ?? "").toLowerCase();
      const k = Object.values(db.sku).find((z) => z.pm === x.item);
      return art(nm.includes("drum") || k?.kind === "drum" ? "drum" : "can", "#9BA3B2", k?.tag ?? "", s);
    }
    if (x.type === "fg") {
      const k = db.sku[x.item];
      return art(k?.kind ?? "can", k?.col, k?.tag, s);
    }
    const b = db.box[x.item], k = b && db.sku[b.sku];
    return art("box", k?.col, b ? b.cpb + "×" + k?.tag : "", s);
  }

  /* ================================================================ sign in */

  private signedIn(me: Me, data: FactoryData, toast?: string) {
    const chosen = load<Lang | null>(null, "lang", null) ?? this.state.lang;
    if (chosen !== me.lang) void call("setLang", chosen);
    this.setState({
      me: { ...me, lang: chosen },
      db: data,
      lang: chosen,
      pinFor: null,
      pin: "",
      otp: "",
      phone: "",
      signStep: "id",
      route: me.head ? "today" : "home",
      ...this.restore(me.key),
    }, () => {
      if (toast) this.toast(toast);
      void this.flushQueue();
    });
  }

  async idNext() {
    const T = this.T();
    const p = this.state.phone;
    if (p.length !== 10) return this.setState({ idErr: T.yourMobile });
    this.setState({ busy: true });
    try {
      const r = await call("findPhone", p);
      if (!r.ok) return this.setState({ idErr: r.error === "notFound" || r.error === "phone" ? T.notFound : r.error === "inactive" ? T.inactive : r.error });
      this.setState({ pinFor: r.who, pin: "", pinErr: "", signStep: r.who.hasPin ? "pin" : "otp" }, () => {
        if (!r.who.hasPin) void this.sendCode(true);
      });
    } catch {
      this.setState({ idErr: "No network. Check the Wi-Fi and try again." });
    } finally {
      this.setState({ busy: false });
    }
  }

  async tryPin(q: string) {
    const T = this.T();
    if (q.length < 4) return this.setState({ pinErr: T.enterPin });
    const who = this.state.pinFor;
    if (!who || this.state.busy) return;
    this.setState({ busy: true });
    try {
      const r = await call("signInPin", who.key, q);
      if (!r.ok) {
        if (r.error === "noPin") return this.setState({ signStep: "otp" }, () => void this.sendCode(true));
        return this.setState({ pin: "", pinErr: r.error === "wrongPin" ? T.wrongPin : r.error === "inactive" ? T.inactive : r.error });
      }
      this.signedIn(r.me, r.data);
    } catch {
      this.setState({ pinErr: "No network. Check the Wi-Fi and try again." });
    } finally {
      this.setState({ busy: false });
    }
  }

  async sendCode(first = false) {
    const who = this.state.pinFor;
    if (!who) return;
    if (!first && this.state.otpT > 0) return;
    this.setState({ otpT: 30, otp: "", otpErr: "", signStep: "otp" }, () => this.otpTick());
    try {
      const r = await call("sendCode", who.key);
      if (!r.ok) return this.setState({ otpErr: r.error, otpT: 0 });
      this.setState({ otpTo: r.sentTo });
      if (!first) this.toast("New code sent");
    } catch {
      this.setState({ otpErr: "No network. Check the Wi-Fi and try again.", otpT: 0 });
    }
  }

  otpTick() {
    clearInterval(this.ot);
    this.ot = window.setInterval(() => {
      const t = this.state.otpT - 1;
      this.setState({ otpT: Math.max(0, t) });
      if (t <= 0) clearInterval(this.ot);
    }, 1000);
  }

  async tryOtp(q: string) {
    if (q.length < 6) return this.setState({ otpErr: "Enter all 6 numbers from the SMS." });
    const who = this.state.pinFor;
    if (!who || this.state.busy) return;
    this.setState({ busy: true });
    try {
      const r = await call("verifyCode", who.key, q);
      if (!r.ok) return this.setState({ otp: "", otpErr: r.error || "Wrong code. Check the SMS and try again." });
      /* In, but with no PIN worth the name: choose one before anything else. */
      this.setState({ me: r.me, db: r.data, signStep: "newpin", newPin: "", newPin1: "", pinErr: "" });
    } catch {
      this.setState({ otpErr: "No network. Check the Wi-Fi and try again." });
    } finally {
      this.setState({ busy: false });
    }
  }

  async tryNewPin(q: string) {
    if (q.length < 4) return this.setState({ pinErr: "Use 4 numbers." });
    if (!this.state.newPin1) return this.setState({ newPin1: q, newPin: "", pinErr: "" });
    if (q !== this.state.newPin1) return this.setState({ newPin: "", newPin1: "", pinErr: "The two PINs are not the same. Start again." });
    this.setState({ busy: true });
    try {
      const r = await call("setPin", q);
      if (!r.ok) return this.setState({ newPin: "", newPin1: "", pinErr: r.error });
      this.signedIn(this.state.me!, this.state.db!, "Signed in · your new PIN is saved");
    } finally {
      this.setState({ busy: false });
    }
  }

  /**
   * A shared station phone: the next person must not see this one's floor.
   * What is still waiting to send is NOT dropped — it stays under this
   * person's name and goes the next time they sign in on this phone. Before
   * leaving, it is given one more chance to go now.
   */
  async signOut() {
    const me = this.state.me?.key;
    await this.flushQueue().catch(() => {});
    try {
      await call("signOut");
    } catch {}
    if (me) forget(me);
    try {
      navigator.serviceWorker?.controller?.postMessage("forget-pages");
    } catch {}
    this.setState({ me: null, db: null, sheet: null, route: "home", signStep: "id", flow: null, result: null, queue: [], drafts: {}, started: {}, results: {} });
  }

  /* ================================================================ scanning */

  openScan(purpose: ScanPurpose, meta?: ScanMeta) {
    this.setState({ scan: { purpose, meta: meta || {}, res: null, torch: false }, cam: "wait" });
  }

  /** The labels a phone with no camera can tap — only where scanning cannot happen. */
  scanLabels(): { code: string; what: string; good: boolean }[] {
    const st = this.state, sc = st.scan!, f = st.flow, P = sc.purpose, m = sc.meta;
    const db = st.db;
    const out: { code: string; what: string; good: boolean }[] = [];
    if (!db) return out;
    const add = (code: string, what: string, good: unknown) => out.push({ code, what, good: !!good });
    const lots = Object.values(db.lots);
    if (P === "badge") return out;
    if (P === "drum") {
      lots.filter((x) => x.type === "rm").slice(0, 8).forEach((x) => add(x.code, (db.rm[x.item]?.n ?? x.item) + " drum", 1));
      return out;
    }
    if (P === "home") {
      const me = st.me!;
      this.tasks().filter((t) => (me.head || inDept(me, this.dept(), t.proc)) && t.status !== "done").slice(0, 4).forEach((t) => add(taskCode(t), taskName(db, t).slice(0, 22), 1));
      const anyLot = lots.find((x) => x.status === "ok" && x.loc === db.loc);
      if (anyLot) add(anyLot.code, "Lot label", 1);
      add("8901234567890", "Supplier barcode", 0);
      return out;
    }
    if (P === "rm" && m.item) {
      lots.filter((x) => x.type === "rm" && x.item === m.item).forEach((x) => add(x.code, db.rm[m.item!].n + (x.status === "used" ? " · empty" : x.loc !== db.loc ? " · " + x.loc : x.status === "hold" ? " · on hold" : ""), x.status === "ok" && x.loc === db.loc));
      const ol = lots.find((x) => x.type === "rm" && x.item !== m.item);
      if (ol) add(ol.code, db.rm[ol.item]?.n + " · wrong", 0);
      return out;
    }
    if (P === "sfg" && f?.d.sku) {
      const want = db.sku[f.d.sku].sfg;
      lots.filter((x) => x.type === "sfg").forEach((x) => add(x.code, (db.sfg[x.item]?.short ?? "") + " base" + (x.status === "used" ? " · empty" : x.item !== want ? " · wrong" : x.status === "hold" ? " · QC" : ""), x.item === want && x.avail > 0 && x.status === "ok"));
      return out;
    }
    if (P === "pm" && f?.d.sku) {
      const want = db.sku[f.d.sku].pm;
      lots.filter((x) => x.type === "pm").forEach((x) => add(x.code, (db.pm[x.item] ?? "").replace("Empty ", ""), x.item === want));
      return out;
    }
    if (P === "fg" && f?.d.box) {
      const want = db.box[f.d.box].sku;
      lots.filter((x) => x.type === "fg" && db.sku[x.item]?.kind === "can").forEach((x) => add(x.code, (db.sku[x.item].n ?? "").replace("Mahek ", "") + " " + db.sku[x.item].size, x.item === want));
      return out;
    }
    if (P === "load" && f?.task.order) {
      const o = db.orders[f.task.order];
      o?.lines.forEach((ln) => ln.alloc.forEach((a) => add(a[0], "On this order", 1)));
      lots.filter((x) => x.type === "pb" && !o?.lines.some((ln) => ln.alloc.some((a) => a[0] === x.code))).slice(0, 3).forEach((x) => add(x.code, x.status === "incomplete" ? "Next batch" : "Not on order", 0));
    }
    return out;
  }

  /** A code typed off the label: read like a scan, judged like one. */
  submitTyped() {
    const sc = this.state.scan;
    const raw = (sc?.typed ?? "").trim();
    if (!sc || !raw) return;
    const code = sc.purpose === "lr" ? raw : typedCode(raw, this.state.db);
    /* The text stays: a code the server refuses comes back to the box to fix, not to an empty one. */
    void this.doScan(code);
  }

  async doScan(code: string, manual?: boolean) {
    const st = this.state, sc = st.scan;
    if (!sc || sc.res) return;
    if (sc.purpose === "drum") {
      try {
        const r = await call("drumLookup", code);
        if (r.ok) {
          this.setState({ scan: null, route: "drum", drum: { lot: r.lot, limits: r.limits, kg: null, key: mintDrumKey(), ask: null, err: null, saving: false, saved: null } });
        } else {
          const seen = r.existing?.length ? " Recorded: " + r.existing.map((e) => e.label + (e.seq ? " (drum " + e.seq + ")" : "")).join(", ") + "." : "";
          this.setState({ scan: { ...sc, res: { ok: false, code, title: r.title, text: r.text + seen, fix: r.fix } } });
        }
      } catch {
        this.setState({ scan: { ...sc, res: { ok: false, code, title: "No network", text: "We could not check this label.", fix: "Check the Wi-Fi, then scan again. Nothing was saved." } } });
      }
      return;
    }
    if (sc.purpose === "badge") {
      try {
        const r = await call("findBadge", code);
        const res: ScanResult = r.ok
          ? { ok: true, code, kind: "emp", emp: r.who.key }
          : { ok: false, code, title: "This badge does not work", text: "This badge is old.", fix: "Ask HR for a new badge. Or type your mobile number." };
        if (r.ok) this.setState({ pinFor: r.who });
        this.setState({ scan: { ...sc, res } });
      } catch {
        this.setState({ scan: { ...sc, res: { ok: false, code, title: "No network", text: "We could not check the badge.", fix: "Check the Wi-Fi, or type your mobile number." } } });
      }
      return;
    }
    const r = resolveScan(code, { db: this.db(), purpose: sc.purpose, meta: sc.meta, area: st.me?.head ? "head" : st.me?.area, areas: st.me && !st.me.head ? myDepts(st.me) : undefined, task: st.flow?.task, d: st.flow?.d });
    this.setState({ scan: { ...sc, res: { ...r, manual: !!manual } } });
  }

  acceptScan() {
    const st = this.state, sc = st.scan!, r = sc.res!, P = sc.purpose, m = sc.meta;
    if (!r.ok) return;
    if (r.kind === "emp") {
      const who = st.pinFor;
      return this.setState({ scan: null, pin: "", pinErr: "", signStep: who?.hasPin ? "pin" : "otp", phone: who?.ph ?? "" }, () => {
        if (who && !who.hasPin) void this.sendCode(true);
      });
    }
    if (P === "home") {
      this.setState({ scan: null });
      if (r.kind === "task") return this.startTask(r.task);
      if (r.kind === "info" || r.kind === "lot") {
        const x = this.db().lots[r.lot];
        return this.toast(lotName(this.db(), x) + " · " + nf(x.avail) + " " + lotUnit(this.db(), x) + " left");
      }
      return;
    }
    if (r.kind !== "lot") return;
    const f: Flow = { ...st.flow!, d: { ...st.flow!.d } };
    const d = f.d;
    const x = this.db().lots[r.lot];
    const db = this.db();
    if (P === "rm") {
      d.rm = (d.rm ?? []).map((q, i) => (i === m.idx ? { ...q, lot: r.lot, manual: !!r.manual } : q));
      this.setState({ flow: f, scan: null }, () => this.rmKp(m.idx!));
      return;
    }
    if (P === "sfg") { d.sfg = r.lot; d.sfgManual = !!r.manual; }
    if (P === "pm") { d.pm = r.lot; d.pmManual = !!r.manual; }
    if (P === "fg") d.fg = (d.fg ?? []).concat([{ lot: r.lot, manual: !!r.manual }]);
    if (P === "load") {
      const a = db.orders[f.task.order!].lines.reduce<[string, number][]>((acc, ln) => acc.concat(ln.alloc), []).find((z) => z[0] === r.lot)!;
      d.loads = { ...(d.loads ?? {}), [r.lot]: null };
      if (r.manual) d.loadsManual = { ...(d.loadsManual ?? {}), [r.lot]: true };
      this.setState({ flow: f, scan: null }, () =>
        this.openKp({
          l: "How many did you load from " + r.lot + "?", unit: lotUnit(db, x), v: null, max: a[1], maxL: "This order takes " + a[1] + " from this lot. Do not load more.",
          quick: [{ l: "All " + a[1], v: a[1] }],
          set: (v) => this.setD((dd) => { dd.loads = { ...(dd.loads ?? {}), [r.lot]: v }; }),
        }),
      );
      return;
    }
    this.setState({ flow: f, scan: null });
  }

  /* ================================================================ quality check */

  openQc() {
    const blank: QcEntry = { loading: true, err: null, tests: [], waiting: [], decided: [], pick: null, results: {}, note: "", saving: false, saved: null };
    this.setState({ sheet: null, route: "qc", qc: blank }, () => void this.loadQc());
  }

  /** Merges onto the LATEST quality-check state, like `setStock`. */
  setQc(p: Partial<QcEntry>) {
    this.setState((st) => (st.qc ? { qc: { ...st.qc, ...p } } : null));
  }

  async loadQc() {
    if (!this.state.qc) return;
    this.setQc({ loading: true, err: null });
    try {
      const r = await call("qcKit");
      if (r.ok) this.setQc({ loading: false, tests: r.tests, waiting: r.waiting, decided: r.decided });
      else this.setQc({ loading: false, err: { title: r.title, text: r.text, fix: r.fix } });
    } catch (e) {
      this.setQc({ loading: false, err: { title: "No network", text: "The lots could not be loaded.", fix: "Check the Wi-Fi and tap Try again. A quality decision needs the network — it is checked against the Testing list the moment it arrives." } });
      if (!(e instanceof NotReceived)) throw e;
    }
  }

  /** A lot already decided opens with the answers it was decided on, so changing one test is one tap. */
  pickQc(lot: QcLot) {
    this.setQc({ pick: lot, results: { ...lot.tests }, note: lot.status === "Rejected" ? (lot.note ?? "") : "", saving: false, saved: null, err: null });
  }

  async saveQc(verdict: "Approved" | "Rejected") {
    const s = this.state.qc;
    if (!s?.pick || s.saving) return;
    this.setQc({ saving: true, err: null });
    try {
      const r = await call("qcDecide", { lot: s.pick.lot, verdict, results: s.results, note: s.note.trim() || null });
      if (r.ok) {
        this.setQc({ saving: false, saved: { msg: r.msg, lot: r.lot } });
        this.toast(r.msg);
        return;
      }
      this.setQc({ saving: false, err: { title: r.title, text: r.text, fix: r.fix } });
    } catch (e) {
      this.setQc({ saving: false, err: { title: "No network", text: "The decision is not saved yet.", fix: "Check the Wi-Fi and press the button again." } });
      if (!(e instanceof NotReceived)) throw e;
    }
  }

  /** Back from a lot to the list — reloading it, so a lot just decided moves down. */
  qcBack() {
    const s = this.state.qc;
    if (s?.pick) {
      const reload = !!s.saved;
      this.setQc({ pick: null, saved: null, err: null });
      if (reload) void this.loadQc();
      return;
    }
    this.setState({ route: "more", qc: null });
  }

  /* ============================================================ purchase requirement
   * The in-charge asks the office to buy what the department needs. Every item
   * is COUNTED before it is added — the phone is never sent the book — and the
   * count goes to the ERP as that item's stock check (lib/factory/purchase.ts).
   */

  openReq() {
    const blank: ReqEntry = { loading: true, err: null, kit: null, view: "list", tab: "open", dept: null, q: "", lines: [], requiredBy: "", priority: "Medium", remarks: "", key: "", saving: false, saved: null, open: null, ask: null, expand: null, find: "" };
    this.setState({ sheet: null, route: "req", req: blank }, () => void this.loadReq());
  }

  /** Merges onto the LATEST requirement state, like `setQc`. */
  setReq(p: Partial<ReqEntry>) {
    this.setState((st) => (st.req ? { req: { ...st.req, ...p } } : null));
  }

  async loadReq() {
    if (!this.state.req) return;
    this.setReq({ loading: true, err: null });
    try {
      const r = await call("reqKit");
      if (r.ok) this.setState((st) => (st.req ? { req: { ...st.req, loading: false, kit: r, dept: st.req.dept ?? r.depts[0]?.key ?? null } } : null));
      else this.setReq({ loading: false, err: { title: r.title, text: r.text, fix: r.fix } });
    } catch (e) {
      this.setReq({ loading: false, err: { title: "No network", text: "The requirements could not be loaded.", fix: "Check the Wi-Fi and tap Try again. A requirement needs the network — your counts are checked the moment they arrive." } });
      if (!(e instanceof NotReceived)) throw e;
    }
  }

  /** A date `days` after the kit's today, as YYYY-MM-DD. */
  reqDay(days: number): string {
    const d = new Date((this.state.req?.kit?.today ?? "") + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    const two = (n: number) => (n < 10 ? "0" : "") + n;
    return d.getUTCFullYear() + "-" + two(d.getUTCMonth() + 1) + "-" + two(d.getUTCDate());
  }

  /** "Thu 16 Oct" for a YYYY-MM-DD; `short` drops the month: "Thu 16". */
  reqDayWords(iso: string | null, short?: boolean): string {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00Z");
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return DOW[d.getUTCDay()] + " " + d.getUTCDate() + (short ? "" : " " + MON[d.getUTCMonth()]);
  }

  startReq() {
    const s = this.state.req;
    if (!s?.kit) return;
    this.setReq({ view: "pick", lines: [], q: "", requiredBy: this.reqDay(2), priority: "Medium", remarks: "", key: mintReqKey(), saved: null, err: null, ask: null, dept: s.dept ?? s.kit.depts[0]?.key ?? null });
  }

  /** Tap Add (or an item already added): count first, then how much to buy. */
  askReqItem(it: ReqItem) {
    const have = this.state.req?.lines.find((l) => l.itemId === it.id);
    this.setReq({ ask: { itemId: it.id, step: "count", counted: have ? String(have.counted) : "", need: have ? String(have.need) : "" } });
  }

  /** The quick amounts and the − / + step for how an item is bought. */
  reqQuick(it: ReqItem): { step: number; quick: number[]; hint: string } {
    if (it.buyUnit === "Pcs") return { step: 100, quick: [100, 250, 500, 1000], hint: "Shortcuts follow how this item is bought." };
    return { step: 200, quick: [200, 400, 600, 1000], hint: "Drum = 200 " + (it.buyUnit === "Kg" ? "kg" : "L") + ". Shortcuts follow how this item is bought." };
  }

  addReqLine() {
    const s = this.state.req, a = s?.ask;
    if (!s || !a) return;
    const counted = Number(a.counted), need = Number(a.need);
    if (a.counted === "" || !Number.isFinite(counted) || counted < 0) return this.setReq({ ask: { ...a, step: "count" } });
    if (!Number.isFinite(need) || need <= 0) return this.toast("Enter how much to buy", "warn");
    const line = { itemId: a.itemId, counted, need };
    const lines = s.lines.some((l) => l.itemId === a.itemId) ? s.lines.map((l) => (l.itemId === a.itemId ? line : l)) : s.lines.concat([line]);
    this.setReq({ lines, ask: null, err: null });
  }

  pickReqDay() {
    const days = Array.from({ length: 28 }, (_, i) => this.reqDay(i));
    this.setState({
      sheet: {
        type: "tiles", title: "Needed by", sub: "Pick the day the department needs it in hand.",
        groups: [{ cols: 4, items: days.map((d) => ({ l: this.reqDayWords(d, true), sub: this.reqDayWords(d).split(" ").pop(), v: d })) }],
        pick: (v) => { this.setState({ sheet: null }); this.setReq({ requiredBy: v }); },
      },
    });
  }

  async sendReq() {
    const s = this.state.req;
    if (!s?.dept || s.saving || !s.lines.length) return;
    this.setReq({ saving: true, err: null });
    try {
      const r = await call("reqRaise", { key: s.key, dept: s.dept, requiredBy: s.requiredBy, priority: s.priority, remarks: s.remarks.trim() || null, lines: s.lines });
      if (r.ok) {
        this.setReq({ saving: false, saved: r, view: "sent" });
        return;
      }
      this.setReq({ saving: false, err: { title: r.title, text: r.text, fix: r.fix } });
    } catch (e) {
      this.setReq({ saving: false, err: { title: "No network", text: "The requirement is not sent yet. It is still on this screen.", fix: "Check the Wi-Fi and press Raise requirement again — it will not be raised twice." } });
      if (!(e instanceof NotReceived)) throw e;
    }
  }

  cancelReqLine(l: ReqLine) {
    this.setState({
      sheet: {
        type: "reason", title: "Cancel " + l.item + "?", sub: "The office stops buying it. Say why.", danger: true, okL: "Cancel item",
        reasons: ["Not needed any more", "Asked for by mistake", "Wrong quantity — raising a new one", "Found stock in another godown"],
        done: (reason) => void this.doCancelReq(l.id, reason),
      },
    });
  }

  async doCancelReq(id: string, reason: string) {
    this.setState({ sheet: null });
    try {
      const r = await call("reqCancel", id, reason);
      if (!r.ok) return this.toast(r.error, "warn");
      this.toast(r.msg);
      void this.loadReq();
    } catch (e) {
      this.toast("No network — nothing was cancelled", "warn");
      if (!(e instanceof NotReceived)) throw e;
    }
  }

  reqBack() {
    const s = this.state.req;
    if (!s) return this.setState({ route: "more" });
    if (s.ask) return this.setReq({ ask: s.ask.step === "need" ? { ...s.ask, step: "count" } : null });
    if (s.view === "send") return this.setReq({ view: "pick", err: null });
    if (s.view === "pick" && s.lines.length)
      return this.setState({ sheet: { type: "reason", title: "Leave this requirement?", sub: "The items you added and counted are not sent.", reasons: ["Yes, leave it"], okL: "Leave", danger: true, done: () => this.setState({ sheet: null, req: { ...s, view: "list", lines: [] } }) } });
    if (s.view === "pick" || s.view === "detail") return this.setReq({ view: "list", open: null, err: null });
    if (s.view === "sent") return this.setReq({ view: "list", saved: null }), void this.loadReq();
    this.setState({ route: "more", req: null });
  }

  /** Keeps a field in view once the phone's keyboard has opened and the page has shrunk under it. */
  revealField(el: HTMLElement) {
    const go = () => el.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(go, 300);
    window.visualViewport?.addEventListener("resize", go, { once: true });
  }

  /** The new-requirement steps take the whole screen, as the design draws them: no header bar, no tabs. */
  reqFullScreen(): boolean {
    const s = this.state.req;
    return this.state.route === "req" && !!s && (s.view === "pick" || s.view === "send" || s.view === "sent" || s.view === "detail");
  }

  /** The sheet that adds one item: count it (blind), then how much to buy. */
  renderReqAsk(it: ReqItem, godown: string): ReactNode {
    const s = this.state.req!, a = s.ask!;
    const round = { width: "40px", height: "40px", borderRadius: "50%", border: "none", background: "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flex: "none" } as CSSProperties;
    const cu = it.countUnit, bu = it.buyUnit === "Litre" ? "L" : it.buyUnit === "Kg" ? "kg" : "pcs";
    const dots = (n: number, l: string) => (
      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "8px" }}>
        <span style={{ width: "24px", height: "6px", borderRadius: "3px", background: "#6835FB" }} />
        <span style={{ width: "24px", height: "6px", borderRadius: "3px", background: n > 1 ? "#6835FB" : "#DDE1E8" }} />
        <span style={{ fontSize: "13px", fontWeight: 600, color: "#6B7385", marginLeft: "2px" }}>{l}</span>
      </div>
    );
    const top = (n: number, l: string) => (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "21px", lineHeight: "27px", fontWeight: 700 }}>{it.name}</div>
          {dots(n, l)}
        </div>
        <button onClick={() => this.setReq({ ask: null })} aria-label="Close" style={round}>{ic("x", 20, "#5223E0")}</button>
      </div>
    );
    const pad = (k: string) => {
      const press = () => {
        let v = a.counted;
        if (k === "⌫") v = v.slice(0, -1);
        else if (k === ".") v = cu === "L" && !v.includes(".") ? (v || "0") + "." : v;
        else v = (v === "0" ? "" : v) + k;
        this.setReq({ ask: { ...a, counted: v.slice(0, 8) } });
      };
      return <button key={k} onClick={press} aria-label={k === "⌫" ? "Delete" : k} style={{ height: "48px", borderRadius: "10px", border: "none", background: "#F1F2F5", fontSize: "21px", fontWeight: 600, color: k === "." && cu !== "L" ? "#C2C8D2" : "#1A1E28", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{k}</button>;
    };
    const purpleBtn = (on: boolean, l: string, run: () => void) => <button onClick={() => on && run()} style={btn(on ? "p" : "off", 58)}>{l}</button>;
    let body: ReactNode;
    if (a.step === "count") {
      const has = a.counted !== "";
      body = (
        <>
          {top(1, "Count, then how much you need")}
          <MsgBox m={msg("Go and check the godown first. How much " + it.name + " is at " + godown + " right now? Count every " + (cu === "L" ? "drum" : "piece") + ", open ones too.", "info")} />
          <div>
            <div style={{ fontSize: "15px", fontWeight: 700, marginBottom: "6px" }}>Available now</div>
            <div style={{ height: "58px", borderRadius: "12px", border: "2px solid " + (has ? "#6835FB" : "#DDE1E8"), background: "#FFFFFF", display: "flex", alignItems: "center", padding: "0 16px", gap: "8px" }}>
              <span style={{ flex: 1, fontSize: has ? "26px" : "19px", fontWeight: has ? 700 : 500, color: has ? "#1A1E28" : "#9BA3B2" }}>{has ? a.counted : "Type what you counted"}</span>
              <span style={{ fontSize: "17px", fontWeight: 600, color: "#3D4453" }}>{cu}</span>
            </div>
          </div>
          <div style={{ display: "flex" }}>
            <button onClick={() => this.setReq({ ask: { ...a, counted: "0" } })} style={{ padding: "10px 14px", borderRadius: "18px", border: "1.5px solid #DDE1E8", background: "#FFFFFF", color: "#3D4453", fontSize: "15px", fontWeight: 600, cursor: "pointer" }}>None in the godown · 0</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "6px" }}>{["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map(pad)}</div>
          {purpleBtn(has, "Next", () => this.setReq({ ask: { ...a, step: "need" } }))}
        </>
      );
    } else {
      const q = this.reqQuick(it);
      const n = Number(a.need) || 0;
      const setNeed = (v: number) => this.setReq({ ask: { ...a, need: v > 0 ? String(Math.round(v * 1000) / 1000) : "" } });
      const sq: CSSProperties = { width: "60px", height: "60px", flex: "none", borderRadius: "14px", border: "none", background: "#F1ECFF", color: "#5223E0", fontSize: "30px", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" };
      body = (
        <>
          {top(2, "How much you need")}
          <div style={{ ...card, borderRadius: "12px", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "15px", color: "#6B7385" }}>You counted</span>
            <span style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "18px", fontWeight: 700 }}>{nf(Number(a.counted)) + " " + cu}</span>
              <button onClick={() => this.setReq({ ask: { ...a, step: "count" } })} style={{ background: "none", border: "none", padding: 0, color: "#5223E0", fontSize: "14px", fontWeight: 700, cursor: "pointer" }}>Change</button>
            </span>
          </div>
          <div>
            <div style={{ fontSize: "15px", fontWeight: 700, marginBottom: "6px" }}>How much to buy?</div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <button onClick={() => setNeed(Math.max(0, n - q.step))} aria-label="Less" style={sq}>−</button>
              <label style={{ flex: 1, minWidth: 0, height: "60px", borderRadius: "14px", border: "2px solid #6835FB", background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", padding: "0 10px" }}>
                <input onFocus={(e) => this.revealField(e.currentTarget)} value={a.need} onChange={(e) => this.setReq({ ask: { ...a, need: String(e.target.value).replace(it.buyUnit === "Pcs" ? /[^\d]/g : /[^\d.]/g, "").slice(0, 8) } })} inputMode={it.buyUnit === "Pcs" ? "numeric" : "decimal"} placeholder="0" aria-label={"How much " + it.name + " to buy"} style={{ width: "100%", minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: "28px", fontWeight: 700, color: "#1A1E28", textAlign: "center" }} />
                <span style={{ fontSize: "17px", fontWeight: 600, color: "#6B7385", flex: "none" }}>{bu}</span>
              </label>
              <button onClick={() => setNeed(n + q.step)} aria-label="More" style={sq}>＋</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            {q.quick.map((v) => {
              const on = n === v;
              return <button key={v} onClick={() => setNeed(v)} style={{ flex: 1, padding: "10px 4px", borderRadius: "18px", border: "none", background: on ? "#6835FB" : "#F1ECFF", color: on ? "#FFFFFF" : "#5223E0", fontSize: "15px", fontWeight: 600, cursor: "pointer" }}>{nf(v) + " " + bu}</button>;
            })}
          </div>
          <div style={{ fontSize: "13px", color: "#6B7385" }}>{q.hint}</div>
          {purpleBtn(n > 0, "Add to requirement", () => this.addReqLine())}
        </>
      );
    }
    return (
      <div onClick={() => this.setReq({ ask: null })} style={{ position: "absolute", inset: 0, background: "rgba(14,16,22,0.5)", zIndex: 40, display: "flex", alignItems: "flex-end" }}>
        <div onClick={(e) => e.stopPropagation()} role="dialog" className="fx-scroll" aria-label={it.name} style={{ width: "100%", maxHeight: "94%", overflowY: "auto", background: "#FFFFFF", borderRadius: "26px 26px 0 0", padding: "10px 20px 18px 20px", display: "flex", flexDirection: "column", gap: "14px", animation: "fx-up 200ms cubic-bezier(0.2,0,0.2,1)" }}>
          <div style={{ width: "44px", height: "5px", borderRadius: "3px", background: "#DDE1E8", alignSelf: "center", flex: "none" }} />
          {body}
        </div>
      </div>
    );
  }

  renderReq(): ReactNode {
    const st = this.state, T = this.T(), s = st.req;
    const round = { width: "44px", height: "44px", borderRadius: "50%", border: "none", background: "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flex: "none" } as CSSProperties;
    const errBox = (e: { title: string; text: string; fix: string }) => (
      <div style={{ padding: "14px", borderRadius: "14px", background: "#FCECEC" }}>
        <div style={{ fontSize: "17px", fontWeight: 700, color: "#B3261E" }}>{e.title}</div>
        <div style={{ fontSize: "15px", lineHeight: "22px", color: "#1A1E28", marginTop: "6px" }}>{e.text}</div>
        <div style={{ fontSize: "15px", lineHeight: "22px", color: "#1A1E28", marginTop: "6px" }}><span style={{ fontWeight: 700 }}>What to do: </span>{e.fix}</div>
      </div>
    );
    const kit = s?.kit ?? null;
    const deptLabel = (k: string | null) => kit?.depts.find((d) => d.key === k)?.label ?? "";
    const view = s?.view ?? "list";
    const titles: Record<ReqEntry["view"], [string, string]> = {
      list: ["Purchase requirements", (kit?.depts.map((d) => d.label).join(" · ") ?? "") + (kit ? " · " + kit.godown : "")],
      pick: ["New requirement", "Step 1 of 2 · What do you need?"],
      send: ["New requirement", "Step 2 of 2 · Check and send"],
      sent: ["", ""],
      detail: [s?.open ?? "", deptLabel(kit?.reqs.find((x) => x.no === s?.open)?.dept ?? null)],
    };
    const head = (
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <button onClick={() => this.reqBack()} aria-label={view === "pick" ? "Close" : T.back} style={round}>{ic(view === "pick" ? "x" : "back", 22, "#5223E0")}</button>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: "20px", fontWeight: 700, ...(view === "detail" ? mono : {}) }}>{titles[view][0]}</span>
          {!!titles[view][1] && <span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{titles[view][1]}</span>}
        </span>
        {view === "list" && <button onClick={() => void this.loadReq()} aria-label="Refresh" style={round}>{ic("sync", 22, "#5223E0")}</button>}
      </div>
    );
    const wrap = (kids: ReactNode, foot?: ReactNode, overlay?: ReactNode, noHead?: boolean) => (
      <>
        <div className="fx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 16px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>{!noHead && head}{kids}</div>
        {foot && <div style={{ flex: "none", background: "#FFFFFF", borderTop: "1px solid #EDEFF3", padding: "12px 16px 16px 16px" }}>{foot}</div>}
        {overlay}
      </>
    );
    if (!s) return wrap(null);
    if (!kit) return wrap(<>{s.loading && <div style={{ fontSize: "15px", color: "#6B7385" }}>Loading…</div>}{s.err && errBox(s.err)}{s.err && <button onClick={() => void this.loadReq()} style={btn("s", 52)}>Try again</button>}</>);

    const unitW = (u: string) => (u === "Litre" ? "L" : u === "Kg" ? "kg" : "pcs");
    const qtyW = (n: number, u: string) => nf(n) + " " + unitW(u);
    const PRI: Record<string, { bg: string; fg: string; l: string }> = { Urgent: { bg: "#FCECEC", fg: "#B3261E", l: "Urgent" }, Medium: { bg: "#EDEFF3", fg: "#3D4453", l: "Medium" }, "For Stock": { bg: "#EDEFF3", fg: "#3D4453", l: "For stock" } };
    const tag = (l: string, bg: string, fg: string) => <Pill key={l} l={l} bg={bg} fg={fg} />;
    const stageTone = (l: ReqLine) =>
      l.step < 0 ? { bg: "#EDEFF3", fg: "#6B7385" } : l.step >= kit.steps.length ? { bg: "#E9F5EE", fg: "#1D7A45" } : l.step <= 1 ? { bg: "#FDF6E7", fg: "#8A5C05" } : l.step >= 4 ? { bg: "#E8F1FD", fg: "#1A5BB5" } : { bg: "#F1ECFF", fg: "#3D14A8" };
    const countWords = (l: ReqLine) =>
      l.countState === "matched" ? { t: "✓ Count matches", bg: "#E9F5EE", fg: "#1D7A45" } : l.countState === "flagged" ? { t: "Count doesn't match — stock control told", bg: "#FDF6E7", fg: "#8A5C05" } : l.countState === "waiting" ? { t: "Stock check — count first", bg: "#FDF6E7", fg: "#8A5C05" } : null;
    const cardS = card;

    /* ---- the list */
    if (view === "list") {
      const f = s.find.trim().toLowerCase();
      const mine = kit.reqs.filter((r) => r.state === s.tab && (!f || r.no.toLowerCase().includes(f) || r.lines.some((l) => l.item.toLowerCase().includes(f))));
      const n = (t: ReqEntry["tab"]) => kit.reqs.filter((r) => r.state === t).length;
      const tab = (t: ReqEntry["tab"], l: string) => {
        const on = s.tab === t;
        return <button key={t} onClick={() => this.setReq({ tab: t })} aria-pressed={on} style={{ padding: "10px 14px", borderRadius: "18px", border: "none", background: on ? "#6835FB" : "#F1ECFF", color: on ? "#FFFFFF" : "#5223E0", fontSize: "15px", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: "6px" }}>{l}<span style={{ padding: "0 6px", borderRadius: "10px", lineHeight: "20px", fontSize: "12px", background: on ? "rgba(255,255,255,0.25)" : "#FFFFFF" }}>{n(t)}</span></button>;
      };
      const bar = (lines: ReqLine[]) => {
        const live = lines.filter((l) => l.step >= 0);
        const min = live.length ? Math.min(...live.map((l) => l.step)) : -1;
        return (
          <div style={{ display: "flex", gap: "4px", marginTop: "12px" }}>
            {kit.steps.map((x, i) => <span key={x} style={{ flex: 1, height: "5px", borderRadius: "3px", background: min < 0 ? "#EDEFF3" : i < min ? "#6835FB" : i === min ? "#F0B43C" : "#EDEFF3" }} />)}
          </div>
        );
      };
      return wrap(
        <>
          <button onClick={() => this.startReq()} style={btn("p", 58)}>{ic("plus", 22, "#FFFFFF")}Raise a requirement</button>
          <label style={{ height: "48px", minHeight: "48px", boxSizing: "border-box", border: "1.5px solid #DDE1E8", borderRadius: "12px", padding: "0 12px", background: "#FFFFFF", display: "flex", alignItems: "center", gap: "10px" }}>
            {ic("search", 18, "#9BA3B2")}
            <input onFocus={(e) => this.revealField(e.currentTarget)} value={s.find} onChange={(e) => this.setReq({ find: String(e.target.value).slice(0, 60) })} placeholder="Search by REQ number or item" aria-label="Search requirements" style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: "17px", color: "#1A1E28" }} />
          </label>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>{tab("open", "Open")}{tab("received", "Received")}{tab("cancelled", "Cancelled")}</div>
          {s.err && errBox(s.err)}
          {mine.length ? mine.map((r) => {
            const pr = PRI[r.priority];
            const shown = r.lines.slice(0, 3);
            const done = r.lines.filter((l) => l.step >= kit.steps.length).length;
            const live = r.lines.filter((l) => l.step >= 0).length;
            return (
              <button key={r.no} onClick={() => this.setReq({ view: "detail", open: r.no, expand: null })} style={{ ...cardS, padding: "14px", textAlign: "left", cursor: "pointer", display: "block", width: "100%" }}>
                <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                  <span style={{ ...mono, fontSize: "15px", fontWeight: 600, color: "#1A1E28" }}>{r.no}</span>
                  <span style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    {kit.depts.length > 1 && tag(deptLabel(r.dept), "#F1ECFF", "#3D14A8")}
                    {tag(pr.l, pr.bg, pr.fg)}
                  </span>
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}>
                  {shown.map((l) => {
                    const t = stageTone(l);
                    return (
                      <span key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "15px", fontWeight: 700, color: "#1A1E28", flex: 1, minWidth: 0 }}>{l.item}<span style={{ fontWeight: 500, color: "#6B7385" }}>{" · " + qtyW(l.qty, l.unit)}</span></span>
                        {tag(l.stage, t.bg, t.fg)}
                      </span>
                    );
                  })}
                  {r.lines.length > 3 && <span style={{ fontSize: "13px", fontWeight: 700, color: "#5223E0" }}>{"+ " + (r.lines.length - 3) + " more"}</span>}
                </span>
                {r.state === "open" && bar(r.lines)}
                <span style={{ display: "flex", justifyContent: "space-between", gap: "8px", marginTop: "10px", fontSize: "13px", color: "#6B7385" }}>
                  <span>{(r.requiredBy ? "Needed by " + this.reqDayWords(r.requiredBy) : "Raised " + this.reqDayWords(r.date))}</span>
                  <span style={{ fontWeight: 700, color: done === live && live ? "#1D7A45" : "#3D4453" }}>{r.state === "cancelled" ? "Cancelled" : done + " of " + live + " received"}</span>
                </span>
              </button>
            );
          }) : !s.loading && <div style={{ ...cardS, padding: "20px", fontSize: "15px", lineHeight: "21px", color: "#6B7385", textAlign: "center" }}>{f ? "Nothing matches “" + s.find + "”." : s.tab === "open" ? "Nothing asked for yet. Tap Raise a requirement when the department needs something." : "None in the last 60 days."}</div>}
          {s.loading && <div style={{ fontSize: "15px", color: "#6B7385" }}>Loading…</div>}
        </>,
      );
    }

    /* ---- one requirement, item by item */
    if (view === "detail") {
      const r = kit.reqs.find((x) => x.no === s.open);
      if (!r) return wrap(<div style={{ ...cardS, padding: "20px", color: "#6B7385" }}>That requirement is no longer on the list.</div>);
      const pr = PRI[r.priority];
      const where = /godown/i.test(r.godown) ? r.godown : r.godown + " godown";
      const fact = (l: string, v: ReactNode, last?: boolean) => (
        <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", padding: "11px 0", borderBottom: last ? "none" : "1px solid #EDEFF3" }}>
          <span style={{ fontSize: "15px", color: "#6B7385" }}>{l}</span>
          <span style={{ fontSize: "15px", fontWeight: 700, textAlign: "right" }}>{v}</span>
        </div>
      );
      const live = r.lines.filter((l) => l.step >= 0);
      const done = live.filter((l) => l.step >= kit.steps.length).length;
      return wrap(
        <>
          <div style={{ ...cardS, padding: "2px 16px" }}>
            {fact("Needed by", r.requiredBy ? this.reqDayWords(r.requiredBy) : "—")}
            {fact("How urgent", tag(pr.l, pr.bg, pr.fg))}
            {fact("Raised", this.reqDayWords(r.date) + (r.by ? " · " + r.by : ""))}
            {fact("Deliver to", where)}
            {fact("Progress", r.state === "cancelled" ? "Cancelled" : done + " of " + live.length + " received", !r.remarks)}
            {!!r.remarks && <div style={{ padding: "11px 0", fontSize: "15px", lineHeight: "21px", color: "#3D4453" }}><span style={{ color: "#6B7385" }}>Note · </span>{r.remarks}</div>}
          </div>
          {this.sectionLabel("Items · " + r.lines.length)}
          {r.lines.map((l) => {
            const t = stageTone(l), cw = countWords(l);
            const open = s.expand === l.id;
            const cur = Math.min(Math.max(l.step, 0), kit.steps.length);
            const facts: [string, string][] = [];
            if (l.po) facts.push(["Purchase order", l.po + (l.vendor ? " · " + l.vendor : "")]);
            else if (l.vendor) facts.push(["Vendor", l.vendor]);
            if (l.quotes && !l.po) facts.push(["Quotations", l.quotes + " in"]);
            if (l.received != null) facts.push(["Received", qtyW(l.received, l.unit) + " of " + qtyW(l.qty, l.unit)]);
            return (
              <div key={l.id} style={{ ...cardS, padding: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: "17px", fontWeight: 700 }}>{l.item}</span>
                    <span style={{ display: "block", fontSize: "14px", color: "#6B7385", marginTop: "2px" }}>{"Need " + qtyW(l.qty, l.unit) + (l.counted != null ? " · you counted " + nf(l.counted) + " " + l.countUnit : "")}</span>
                  </span>
                  {tag(l.stage, t.bg, t.fg)}
                </div>
                {l.step >= 0 && (
                  <div style={{ display: "flex", gap: "4px" }}>
                    {kit.steps.map((x, i) => <span key={x} style={{ flex: 1, height: "6px", borderRadius: "3px", background: i < cur ? "#1D7A45" : i === cur ? "#F0B43C" : "#EDEFF3" }} />)}
                  </div>
                )}
                <div style={{ fontSize: "14px", lineHeight: "20px", color: "#3D4453" }}>{l.next}</div>
                {cw && <div style={{ display: "flex" }}>{tag(cw.t, cw.bg, cw.fg)}</div>}
                {!!facts.length && (
                  <div style={{ borderTop: "1px solid #EDEFF3" }}>
                    {facts.map(([a, b], i) => (
                      <div key={a} style={{ display: "flex", justifyContent: "space-between", gap: "12px", padding: "9px 0", borderBottom: i < facts.length - 1 ? "1px solid #EDEFF3" : "none", fontSize: "14px" }}>
                        <span style={{ color: "#6B7385" }}>{a}</span><span style={{ fontWeight: 700, textAlign: "right" }}>{b}</span>
                      </div>
                    ))}
                  </div>
                )}
                {l.step >= 0 && (
                  <button onClick={() => this.setReq({ expand: open ? null : l.id })} style={{ background: "none", border: "none", padding: 0, color: "#5223E0", fontSize: "14px", fontWeight: 700, cursor: "pointer", textAlign: "left" }}>{open ? "Hide the steps" : "Show every step"}</button>
                )}
                {open && (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {kit.steps.map((x, i) => {
                      const isDone = i < l.step || l.step >= kit.steps.length, now = i === l.step;
                      return (
                        <div key={x} style={{ display: "flex", gap: "12px", alignItems: "stretch" }}>
                          <div style={{ width: "22px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                            <span style={{ width: "14px", height: "14px", borderRadius: "50%", marginTop: "3px", flex: "none", background: isDone ? "#1D7A45" : now ? "#FFFFFF" : "#DDE1E8", border: now ? "3px solid #F0B43C" : "none", boxSizing: "border-box" }} />
                            {i < kit.steps.length - 1 && <span style={{ flex: 1, width: "2px", minHeight: "8px", margin: "2px 0", background: isDone ? "#1D7A45" : "#DDE1E8" }} />}
                          </div>
                          <span style={{ paddingBottom: "10px", fontSize: "15px", lineHeight: "20px", fontWeight: isDone || now ? 700 : 500, color: isDone || now ? "#1A1E28" : "#9BA3B2" }}>{x}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {l.cancel && (l.cancel.ok ? (
                  <button onClick={() => this.cancelReqLine(l)} style={{ ...btn("s", 52), color: "#B3261E", border: "1.5px solid #F6CFCF" }}>{"Cancel " + l.item + "…"}</button>
                ) : <div style={{ fontSize: "13px", color: "#6B7385", textAlign: "center" }}>{l.cancel.why}</div>)}
              </div>
            );
          })}
        </>,
      );
    }

    /* ---- the answer */
    if (view === "sent" && s.saved) {
      const sv = s.saved;
      const off = sv.lines.filter((l) => l.verdict === "flagged").map((l) => l.item);
      const fine = sv.lines.filter((l) => l.verdict === "matched").map((l) => l.item);
      const and = (xs: string[]) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);
      return wrap(
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: "14px", padding: "8px" }}>
          <span style={{ width: "80px", height: "80px", borderRadius: "50%", background: "#E9F5EE", display: "flex", alignItems: "center", justifyContent: "center", alignSelf: "center" }}>{ic("check", 42, "#1D7A45")}</span>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "26px", lineHeight: "32px", fontWeight: 700 }}>Requirement raised</div>
            <div style={{ ...mono, fontSize: "17px", color: "#3D4453", marginTop: "4px" }}>{sv.no + " · " + PRI[s.priority].l + " · by " + this.reqDayWords(s.requiredBy)}</div>
          </div>
          <div style={{ ...cardS, padding: "6px 16px" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#6B7385", padding: "8px 0 4px 0" }}>Your counts</div>
            {sv.lines.map((l, i) => (
              <div key={l.item} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", padding: "10px 0", borderBottom: i < sv.lines.length - 1 ? "1px solid #EDEFF3" : "none" }}>
                <span style={{ fontSize: "15px", fontWeight: 700 }}>{l.item + " · " + nf(l.counted) + " " + l.countUnit}</span>
                {l.verdict === "matched" ? tag("✓ Matches the book", "#E9F5EE", "#1D7A45") : l.verdict === "flagged" ? tag("Doesn’t match", "#FDF6E7", "#8A5C05") : tag("Recount already open", "#EDEFF3", "#3D4453")}
              </div>
            ))}
          </div>
          {!!off.length && (
            <MsgBox m={msg(and(off) + (off.length > 1 ? " don’t" : " doesn’t") + " match the book. Stock control has been told — buying carries on" + (fine.length ? ", and " + and(fine) + (fine.length > 1 ? " match." : " matches.") : "."), "warn")} />
          )}
          <div style={{ ...cardS, padding: "14px 16px" }}>
            <div style={{ fontSize: "15px", fontWeight: 700, marginBottom: "6px" }}>What happens next</div>
            {sv.next.map((x) => <div key={x} style={{ fontSize: "14px", lineHeight: "21px", color: "#3D4453" }}>{x}</div>)}
          </div>
          <button onClick={() => this.reqBack()} style={btn("p", 58)}>Done</button>
        </div>,
        undefined,
        undefined,
        true,
      );
    }

    const dept = kit.depts.find((d) => d.key === s.dept) ?? kit.depts[0];
    const itemOf = (id: string) => dept?.items.find((i) => i.id === id);
    const what = s.dept === "filling" ? "cans and drums" : s.dept === "packing" ? "boxes and stationery" : "chemicals";

    /* ---- step 2: when, how urgent, and send */
    if (view === "send") {
      const days: [string, number][] = [["Tomorrow", 1], ["In 2 days", 2], ["In a week", 7]];
      const preset = days.some(([, d]) => this.reqDay(d) === s.requiredBy);
      const seg = (on: boolean, danger?: boolean): CSSProperties => ({ flex: 1, minWidth: 0, height: "52px", borderRadius: "12px", border: "2px solid " + (on ? (danger ? "#B3261E" : "#6835FB") : "#DDE1E8"), background: on ? (danger ? "#FCECEC" : "#F7F4FF") : "#FFFFFF", color: on ? (danger ? "#B3261E" : "#3D14A8") : "#3D4453", fontSize: "16px", fontWeight: 700, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", lineHeight: "19px" });
      const small = { fontSize: "11px", fontWeight: 600, color: "#6B7385" } as CSSProperties;
      const lbl = (t: string) => <div style={{ fontSize: "14px", color: "#6B7385", marginBottom: "6px" }}>{t}</div>;
      const where = /godown/i.test(kit.godown) ? kit.godown : kit.godown + " godown";
      return wrap(
        <>
          <div style={{ ...cardS, padding: "2px 14px" }}>
            <div style={{ display: "flex", padding: "10px 0", borderBottom: "1px solid #EDEFF3", fontSize: "12px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "#6B7385" }}>
              <span style={{ flex: 1 }}>Item</span><span style={{ width: "80px", textAlign: "right" }}>Counted</span><span style={{ width: "70px", textAlign: "right" }}>Need</span>
            </div>
            {s.lines.map((l, i) => {
              const it = itemOf(l.itemId);
              return (
                <div key={l.itemId} style={{ display: "flex", padding: "11px 0", borderBottom: i < s.lines.length - 1 ? "1px solid #EDEFF3" : "none", fontSize: "15px" }}>
                  <span style={{ flex: 1, fontWeight: 700 }}>{it?.name ?? ""}</span>
                  <span style={{ width: "80px", textAlign: "right", color: "#3D4453" }}>{nf(l.counted) + " " + (it?.countUnit ?? "")}</span>
                  <span style={{ width: "70px", textAlign: "right", fontWeight: 700 }}>{qtyW(l.need, it?.buyUnit ?? "")}</span>
                </div>
              );
            })}
          </div>
          <div>{lbl("Needed by")}
            <div style={{ display: "flex", gap: "6px" }}>
              {days.map(([l, d]) => {
                const v = this.reqDay(d);
                return <button key={l} onClick={() => this.setReq({ requiredBy: v })} style={seg(s.requiredBy === v)}>{l}<span style={small}>{this.reqDayWords(v, true)}</span></button>;
              })}
              <button onClick={() => this.pickReqDay()} style={seg(!preset)}>{preset ? "📅" : this.reqDayWords(s.requiredBy, true)}<span style={small}>{preset ? "Pick" : "Picked"}</span></button>
            </div>
          </div>
          <div>{lbl("How urgent?")}
            <div style={{ display: "flex", gap: "6px" }}>
              {(["Urgent", "Medium", "For Stock"] as const).map((p) => <button key={p} onClick={() => this.setReq({ priority: p })} style={seg(s.priority === p, p === "Urgent")}>{PRI[p].l}</button>)}
            </div>
          </div>
          <div>{lbl("Deliver to")}
            <div style={{ ...cardS, borderRadius: "14px", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: "16px", fontWeight: 700 }}>{where}</span><span style={{ fontSize: "14px", color: "#6B7385" }}>where you work</span></div>
          </div>
          <div>{lbl("Note for the office (optional)")}
            <textarea onFocus={(e) => this.revealField(e.currentTarget)} value={s.remarks} onChange={(e) => this.setReq({ remarks: String(e.target.value).slice(0, 1000) })} placeholder="What it is for, or anything the buyer should know" aria-label="Note for the office" rows={3} style={{ width: "100%", boxSizing: "border-box", border: "1.5px solid #DDE1E8", borderRadius: "12px", padding: "12px", fontSize: "17px", lineHeight: "23px", color: "#1A1E28", background: "#FFFFFF", resize: "none", fontFamily: "inherit" }} />
          </div>
          <MsgBox m={msg("Your counts are sent as this requirement’s stock check. If one doesn’t match the book, stock control is told — buying carries on.", "info")} />
          {s.err && errBox(s.err)}
        </>,
        <button onClick={() => void this.sendReq()} style={btn(s.saving ? "off" : "p", 58)}>{s.saving ? "Sending…" : "Raise requirement"}</button>,
      );
    }

    /* ---- step 1: pick and count */
    const q = s.q.trim().toLowerCase();
    const items = (dept?.items ?? []).filter((i) => !q || i.name.toLowerCase().includes(q));
    const chosen = new Set(s.lines.map((l) => l.itemId));
    const row = (it: ReqItem) => {
      const l = s.lines.find((x) => x.itemId === it.id);
      return (
        <div key={it.id} style={{ ...cardS, padding: "12px 14px", display: "flex", alignItems: "center", gap: "12px", border: l ? "2px solid #6835FB" : cardS.border }}>
          <button onClick={() => this.askReqItem(it)} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer" }}>
            <span style={{ display: "block", fontSize: "16px", fontWeight: 700, color: "#1A1E28" }}>{it.name}</span>
            {l ? (
              <span style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px" }}>
                {tag("✓ Counted " + nf(l.counted) + " " + it.countUnit, "#E9F5EE", "#1D7A45")}
                {tag("Need " + qtyW(l.need, it.buyUnit), "#F1ECFF", "#3D14A8")}
              </span>
            ) : (
              <span style={{ display: "block", fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>
                {(it.countUnit === "L" ? "Litres" : "Pieces") + " · " + it.how.charAt(0).toLowerCase() + it.how.slice(1)}
                {it.openReq && <span style={{ color: "#3D14A8", fontWeight: 700 }}>{" · already on " + it.openReq}</span>}
              </span>
            )}
          </button>
          {l ? (
            <button onClick={() => this.setReq({ lines: s.lines.filter((x) => x.itemId !== it.id) })} style={{ background: "none", border: "none", color: "#B3261E", fontSize: "14px", fontWeight: 700, cursor: "pointer", flex: "none" }}>Remove</button>
          ) : (
            <button onClick={() => this.askReqItem(it)} style={{ height: "40px", padding: "0 16px", borderRadius: "12px", border: "1.5px solid #DDE1E8", background: "#FFFFFF", color: "#5223E0", fontSize: "15px", fontWeight: 700, cursor: "pointer", flex: "none", display: "flex", alignItems: "center", gap: "4px" }}>{ic("plus", 16, "#5223E0")}Add</button>
          )}
        </div>
      );
    };
    const sec = (l: string) => this.sectionLabel(l);
    const onList = items.filter((i) => chosen.has(i.id));
    const recent = items.filter((i) => !chosen.has(i.id) && i.recent);
    const rest = items.filter((i) => !chosen.has(i.id) && !i.recent);
    const asking = s.ask ? itemOf(s.ask.itemId) : null;
    const n = s.lines.length;
    return wrap(
      <>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {kit.depts.map((d) => {
            const on = d.key === dept?.key;
            return <button key={d.key} onClick={() => !on && (n ? this.toast("Send or remove the items first — a requirement is for one department", "warn") : this.setReq({ dept: d.key }))} aria-pressed={on} style={{ padding: "10px 14px", borderRadius: "18px", border: "none", background: on ? "#6835FB" : "#F1ECFF", color: on ? "#FFFFFF" : "#5223E0", fontSize: "15px", fontWeight: 600, cursor: "pointer" }}>{d.label}</button>;
          })}
        </div>
        <label style={{ height: "48px", minHeight: "48px", boxSizing: "border-box", border: "1.5px solid #DDE1E8", borderRadius: "12px", padding: "0 12px", background: "#FFFFFF", display: "flex", alignItems: "center", gap: "10px" }}>
          {ic("search", 18, "#9BA3B2")}
          <input onFocus={(e) => this.revealField(e.currentTarget)} value={s.q} onChange={(e) => this.setReq({ q: String(e.target.value).slice(0, 60) })} placeholder={"Search " + what} aria-label={"Search " + what} style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: "17px", color: "#1A1E28" }} />
        </label>
        {!!onList.length && sec("On this requirement · " + onList.length)}
        {onList.map(row)}
        {!!recent.length && sec("Asked for recently")}
        {recent.map(row)}
        {!!rest.length && sec("All " + what)}
        {rest.map(row)}
        {!items.length && <div style={{ ...cardS, padding: "20px", fontSize: "15px", lineHeight: "21px", color: "#6B7385", textAlign: "center" }}>{q ? "Nothing matches “" + s.q + "”." : "No " + what + " for " + (dept?.label ?? "this department") + ". The office adds them in ERP → Masters → Raw materials."}</div>}
      </>,
      <button onClick={() => n && this.setReq({ view: "send", err: null })} style={btn(n ? "p" : "off", 58)}>{n ? "Next · " + n + " item" + (n > 1 ? "s" : "") : "Next · add an item first"}</button>,
      asking ? this.renderReqAsk(asking, kit.godown) : null,
    );
  }

  renderQc(): ReactNode {
    const st = this.state, T = this.T(), s = st.qc;
    const fact = (l: string, v: string, tone?: string) => (
      <div key={l} style={{ display: "flex", justifyContent: "space-between", gap: "12px", padding: "10px 0", borderBottom: "1px solid #EDEFF3" }}>
        <span style={{ fontSize: "15px", color: "#6B7385" }}>{l}</span>
        <span style={{ fontSize: "15px", fontWeight: 700, color: tone ?? "#1A1E28", textAlign: "right", flex: 1 }}>{v}</span>
      </div>
    );
    const errBox = (e: { title: string; text: string; fix: string }) => (
      <div style={{ padding: "14px", borderRadius: "14px", background: "#FCECEC" }}>
        <div style={{ fontSize: "17px", fontWeight: 700, color: "#B3261E" }}>{e.title}</div>
        <div style={{ fontSize: "15px", lineHeight: "22px", color: "#1A1E28", marginTop: "6px" }}>{e.text}</div>
        <div style={{ fontSize: "15px", lineHeight: "22px", color: "#1A1E28", marginTop: "6px" }}><span style={{ fontWeight: 700 }}>What to do: </span>{e.fix}</div>
      </div>
    );
    const round = { width: "44px", height: "44px", borderRadius: "50%", border: "none", background: "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" } as CSSProperties;
    const head = (
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <button onClick={() => this.qcBack()} aria-label={T.back} style={round}>{ic("back", 22, "#5223E0")}</button>
        <span style={{ flex: 1 }}>
          <span style={{ display: "block", fontSize: "20px", fontWeight: 700 }}>Quality check</span>
          <span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>Base liquid lots, tested before filling</span>
        </span>
        {!s?.pick && <button onClick={() => void this.loadQc()} aria-label="Refresh" style={round}>{ic("sync", 22, "#5223E0")}</button>}
      </div>
    );
    const wrap = (kids: ReactNode) => <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>{head}{kids}</div>;
    if (!s) return wrap(null);
    const tone = (v: QcLot["status"]) => (v === "Approved" ? { bg: "#E9F5EE", fg: "#1D7A45" } : v === "Rejected" ? { bg: "#FCECEC", fg: "#B3261E" } : { bg: "#FDF6E7", fg: "#8A5C05" });
    const word = (v: QcLot["status"]) => (v === "Pending" ? "Waiting for QC" : v);
    const p = s.pick;

    /* ---- the answer */
    if (p && s.saved) {
      const sv = s.saved.lot, ok = sv.status === "Approved";
      return wrap(
        <>
          <div style={{ ...card, padding: "16px", border: "2px solid " + (ok ? "#BFE3CC" : "#F6CFCF") }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ width: "52px", height: "52px", flex: "none", borderRadius: "50%", background: ok ? "#E9F5EE" : "#FCECEC", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic(ok ? "check" : "alert", 28, ok ? "#1D7A45" : "#B3261E")}</span>
              <span style={{ flex: 1 }}>
                <span style={{ display: "block", fontSize: "22px", fontWeight: 700, color: ok ? "#1D7A45" : "#B3261E" }}>{ok ? "Approved" : "Rejected"}</span>
                <span style={{ display: "block", fontSize: "15px", color: "#6B7385" }}>{sv.lot + " · " + sv.product}</span>
              </span>
            </div>
            {Object.entries(sv.tests).map(([t, r]) => fact(t, r, r === "Pass" ? "#1D7A45" : "#B3261E"))}
            {!!sv.note && fact("Note", sv.note)}
            <div style={{ marginTop: "10px", fontSize: "14px", lineHeight: "20px", color: "#3D4453" }}>{ok ? "The filling team can use it now." : "It cannot be filled. The mixing team will see why."}</div>
          </div>
          <button onClick={() => this.qcBack()} style={btn("p", 58)}>Check the next lot</button>
        </>,
      );
    }

    /* ---- deciding one lot */
    if (p) {
      const tt = tone(p.status);
      const answered = s.tests.filter((t) => s.results[t]).length;
      const allPass = s.tests.every((t) => s.results[t] === "Pass");
      const anyFail = s.tests.some((t) => s.results[t] === "Fail");
      const canApprove = allPass && !s.saving && p.status !== "Approved";
      const canReject = !!s.note.trim() && !s.saving && p.status !== "Rejected";
      const inputStyle: CSSProperties = { width: "100%", height: "48px", minHeight: "48px", boxSizing: "border-box", border: "1.5px solid #DDE1E8", borderRadius: "12px", padding: "0 12px", fontSize: "17px", color: "#1A1E28", background: "#FFFFFF" };
      const choice = (t: string, r: "Pass" | "Fail") => {
        const on = s.results[t] === r, good = r === "Pass";
        return (
          <button key={r} onClick={() => this.setQc({ results: { ...s.results, [t]: r }, err: null })} aria-label={t + " " + r} style={{ flex: 1, height: "48px", borderRadius: "12px", border: "2px solid " + (on ? (good ? "#1D7A45" : "#B3261E") : "#DDE1E8"), background: on ? (good ? "#E9F5EE" : "#FCECEC") : "#FFFFFF", color: on ? (good ? "#1D7A45" : "#B3261E") : "#3D4453", fontSize: "16px", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{r}</button>
        );
      };
      return wrap(
        <>
          <div style={{ ...card, padding: "16px" }}>
            <span style={{ display: "block", fontSize: "21px", lineHeight: "26px", fontWeight: 700 }}>{p.product}</span>
            <span style={{ display: "block", ...mono, fontSize: "14px", fontWeight: 600, color: "#3D4453", marginTop: "2px" }}>{p.lot}</span>
            {fact("Made", p.made)}
            {fact("In stock", nf(p.litres) + " L · " + p.godown)}
            {fact("Now", word(p.status), tt.fg)}
            {p.status !== "Pending" && !!p.by && fact("Decided by", p.by)}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <span style={{ fontSize: "18px", fontWeight: 700 }}>Tests</span>
            <span style={{ fontSize: "14px", color: "#6B7385" }}>{answered + " of " + s.tests.length + " answered"}</span>
          </div>
          {s.tests.length ? s.tests.map((t) => (
            <div key={t} style={{ ...card, padding: "12px 14px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <span style={{ fontSize: "16px", fontWeight: 700 }}>{t}</span>
              <div style={{ display: "flex", gap: "8px" }}>{choice(t, "Pass")}{choice(t, "Fail")}</div>
            </div>
          )) : <div style={{ ...card, padding: "16px", fontSize: "15px", lineHeight: "21px", color: "#6B7385" }}>No tests are on the Testing list. The office sets them in ERP → Settings → Reference lists.</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <span style={{ fontSize: "15px", color: "#6B7385" }}>{anyFail ? "Why it failed (needed to reject)" : "Note (optional — needed to reject)"}</span>
            <input value={s.note} onChange={(e) => this.setQc({ note: String(e.target.value).slice(0, 500), err: null })} maxLength={500} placeholder={anyFail ? "What was wrong with it" : "Anything the next person should know"} aria-label="Note" style={inputStyle} />
          </div>
          {s.err && errBox(s.err)}
          {anyFail && <div style={{ fontSize: "14px", lineHeight: "20px", color: "#B3261E" }}>A lot that fails a test is rejected, not approved.</div>}
          <button onClick={() => void this.saveQc("Approved")} style={btn(canApprove ? "p" : "off", 60)}>{s.saving ? "Saving…" : p.status === "Approved" ? "Already approved" : allPass ? "Approve — it may be filled" : "Approve (every test must pass)"}</button>
          <button onClick={() => void this.saveQc("Rejected")} style={btn(canReject ? "s" : "off", 54)}>{p.status === "Rejected" ? "Already rejected" : "Reject"}</button>
        </>,
      );
    }

    /* ---- the list */
    const row = (l: QcLot) => {
      const tt = tone(l.status);
      return (
        <button key={l.lot} onClick={() => this.pickQc(l)} style={{ ...card, padding: "14px 16px", display: "flex", flexDirection: "column", alignItems: "stretch", gap: "6px", textAlign: "left", cursor: "pointer" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "17px", fontWeight: 700, flex: 1 }}>{l.product}</span>
            <span style={{ ...mono, fontSize: "13px", color: "#6B7385" }}>{l.lot}</span>
          </div>
          <span style={{ fontSize: "14px", color: "#3D4453" }}>{"Made " + l.made + " · " + nf(l.litres) + " L · " + l.godown}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}><Pill l={word(l.status)} bg={tt.bg} fg={tt.fg} /></div>
        </button>
      );
    };
    return wrap(
      <>
        {s.err && errBox(s.err)}
        {s.err && <button onClick={() => void this.loadQc()} style={btn("s", 54)}>Try again</button>}
        {s.loading && !s.waiting.length && !s.err && <div style={{ fontSize: "15px", color: "#6B7385" }}>Loading…</div>}
        {!s.loading && !s.err && (
          <>
            <span style={{ fontSize: "18px", fontWeight: 700 }}>{"Waiting for QC" + (s.waiting.length ? " · " + s.waiting.length : "")}</span>
            {s.waiting.length ? s.waiting.map(row) : <div style={{ ...card, padding: "20px", fontSize: "15px", lineHeight: "21px", color: "#6B7385", textAlign: "center" }}>Nothing is waiting. Every base liquid in stock has been checked.</div>}
            {s.decided.length > 0 && <span style={{ fontSize: "18px", fontWeight: 700 }}>Decided this week</span>}
            {s.decided.map(row)}
          </>
        )}
      </>,
    );
  }

  /* ================================================================ stock check */

  openStock() {
    const blank: StockEntry = { loading: true, err: null, godown: "", office: [], items: [], stage: "rm", search: "", pick: null, qty: null, bin: "", key: "", saving: false, saved: null, reason: "", reasonSaving: false, reasonSaved: false };
    this.setState({ sheet: null, route: "stock", stock: blank }, () => void this.loadStock());
  }

  /** Merges onto the LATEST stock state: a list reload landing after Back must not put the old pick back. */
  setStock(p: Partial<StockEntry>) {
    this.setState((st) => (st.stock ? { stock: { ...st.stock, ...p } } : null));
  }

  async loadStock() {
    if (!this.state.stock) return;
    this.setStock({ loading: true, err: null });
    try {
      const r = await call("stockKit");
      if (r.ok) this.setStock({ loading: false, godown: r.godown, office: r.office, items: r.items });
      else this.setStock({ loading: false, err: { title: r.title, text: r.text, fix: r.fix } });
    } catch (e) {
      this.setStock({ loading: false, err: { title: "No network", text: "The stock list could not be loaded.", fix: "Check the Wi-Fi and tap Try again. A stock check needs the network — your count is compared with the book the moment it arrives." } });
      if (!(e instanceof NotReceived)) throw e;
    }
  }

  pickStock(pick: NonNullable<StockEntry["pick"]>) {
    this.setStock({ pick, qty: null, bin: "", key: mintCheckKey(), saving: false, saved: null, err: null, reason: "", reasonSaving: false, reasonSaved: false });
  }

  stockQty() {
    const s = this.state.stock;
    if (!s?.pick) return;
    const unit = s.pick.kind === "count" ? s.pick.task.unit : s.pick.item.unit;
    this.openKp({
      l: "How many " + UNIT_WORD[unit] + " did you count?", unit: UNIT_WORD[unit], v: s.qty, decimals: unit === "Ltr", allowZero: true, quick: [{ l: "None here", v: 0 }],
      set: (v) => this.setStock({ qty: v, err: null }),
    });
  }

  async saveStock() {
    const s = this.state.stock;
    if (!s?.pick || s.saving) return;
    if (s.qty == null) return this.stockQty();
    this.setStock({ saving: true, err: null });
    try {
      const r = s.pick.kind === "count"
        ? await call("countSave", { id: s.pick.task.id, qty: s.qty, bin: s.bin || null })
        : await call("stockCheck", { stage: s.pick.item.stage, itemId: s.pick.item.id, qty: s.qty, bin: s.bin || null, key: s.key });
      if (r.ok) {
        this.setStock({ saving: false, saved: r });
        this.toast(r.matched ? "Saved · matches the book" : "Saved · does not match the book");
        return;
      }
      this.setStock({ saving: false, err: { title: r.title, text: r.text, fix: r.fix } });
    } catch (e) {
      this.setStock({ saving: false, err: { title: "No network", text: "The count is not saved yet.", fix: "Check the Wi-Fi and press Save again. It is safe — it will not be saved twice." } });
      if (!(e instanceof NotReceived)) throw e;
    }
  }

  async saveStockReason() {
    const s = this.state.stock, sv = s?.saved;
    if (!s || !sv || !s.reason.trim() || s.reasonSaving) return;
    this.setStock({ reasonSaving: true });
    try {
      const r = await call("checkReason", sv.kind, sv.id, s.reason.trim());
      this.setStock({ reasonSaving: false, reasonSaved: r.ok });
      this.toast(r.ok ? "Reason saved" : "The office has already looked at it");
    } catch (e) {
      this.setStock({ reasonSaving: false });
      this.toast("No network — the reason is not saved yet");
      if (!(e instanceof NotReceived)) throw e;
    }
  }

  /** Back from a count to the list — reloading it, so what was just counted shows as done. */
  stockBack() {
    const s = this.state.stock;
    if (s?.pick) {
      const reload = !!s.saved;
      this.setStock({ pick: null, saved: null, err: null });
      if (reload) void this.loadStock();
      return;
    }
    this.setState({ route: "more", stock: null });
  }

  renderStock(): ReactNode {
    const st = this.state, T = this.T(), s = st.stock;
    const fact = (l: string, v: string, tone?: string) => (
      <div key={l} style={{ display: "flex", justifyContent: "space-between", gap: "12px", padding: "10px 0", borderBottom: "1px solid #EDEFF3" }}>
        <span style={{ fontSize: "15px", color: "#6B7385" }}>{l}</span>
        <span style={{ fontSize: "15px", fontWeight: 700, color: tone ?? "#1A1E28", textAlign: "right", flex: 1 }}>{v}</span>
      </div>
    );
    const errBox = (e: { title: string; text: string; fix: string }) => (
      <div style={{ padding: "14px", borderRadius: "14px", background: "#FCECEC" }}>
        <div style={{ fontSize: "17px", fontWeight: 700, color: "#B3261E" }}>{e.title}</div>
        <div style={{ fontSize: "15px", lineHeight: "22px", color: "#1A1E28", marginTop: "6px" }}>{e.text}</div>
        <div style={{ fontSize: "15px", lineHeight: "22px", color: "#1A1E28", marginTop: "6px" }}><span style={{ fontWeight: 700 }}>What to do: </span>{e.fix}</div>
      </div>
    );
    const round = { width: "44px", height: "44px", borderRadius: "50%", border: "none", background: "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" } as CSSProperties;
    const head = (
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <button onClick={() => this.stockBack()} aria-label={T.back} style={round}>{ic("back", 22, "#5223E0")}</button>
        <span style={{ flex: 1 }}>
          <span style={{ display: "block", fontSize: "20px", fontWeight: 700 }}>Stock check</span>
          {!!s?.godown && <span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{s.godown}</span>}
        </span>
        {!s?.pick && <button onClick={() => void this.loadStock()} aria-label="Refresh" style={round}>{ic("sync", 22, "#5223E0")}</button>}
      </div>
    );
    const wrap = (kids: ReactNode) => <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>{head}{kids}</div>;
    if (!s) return wrap(null);
    const inputStyle: CSSProperties = { width: "100%", height: "48px", minHeight: "48px", boxSizing: "border-box", border: "1.5px solid #DDE1E8", borderRadius: "12px", padding: "0 12px", fontSize: "17px", color: "#1A1E28", background: "#FFFFFF" };
    const p = s.pick;

    /* ---- the answer: matched, or a mismatch and an optional reason */
    if (p && s.saved) {
      const sv = s.saved, u = UNIT_SHORT[sv.unit];
      const ok = sv.matched;
      const diff = sv.difference == null ? null : (sv.difference > 0 ? "+" : "") + nf(sv.difference) + " " + u;
      return wrap(
        <>
          <div style={{ ...card, padding: "16px", border: "2px solid " + (ok ? "#BFE3CC" : "#F6CFCF") }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ width: "52px", height: "52px", flex: "none", borderRadius: "50%", background: ok ? "#E9F5EE" : "#FCECEC", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic(ok ? "check" : "alert", 28, ok ? "#1D7A45" : "#B3261E")}</span>
              <span style={{ flex: 1 }}>
                <span style={{ display: "block", fontSize: "22px", fontWeight: 700, color: ok ? "#1D7A45" : "#B3261E" }}>{ok ? "Matches the book" : "Does not match the book"}</span>
                <span style={{ display: "block", fontSize: "15px", color: "#6B7385" }}>{(sv.no ? sv.no + " · " : "") + sv.item}</span>
              </span>
            </div>
            {fact("You counted", nf(sv.qty) + " " + u)}
            {sv.book != null && fact("The book says", nf(sv.book) + " " + u)}
            {!ok && diff && fact("Difference", diff + (sv.difference! > 0 ? " more on the shelf" : " short on the shelf"), "#B3261E")}
            {sv.kind === "count" && <div style={{ marginTop: "10px", fontSize: "14px", lineHeight: "20px", color: "#3D4453" }}>{sv.message}</div>}
          </div>
          {!ok && (
            <div style={{ ...card, padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <span style={{ fontSize: "17px", fontWeight: 700 }}>Why might it differ? <span style={{ fontWeight: 400, color: "#6B7385" }}>(optional)</span></span>
              <span style={{ fontSize: "14px", color: "#6B7385" }}>The office has been told either way. A reason helps them find it faster.</span>
              {s.reasonSaved ? (
                <div style={{ padding: "12px", borderRadius: "12px", background: "#E9F5EE", color: "#1D7A45", fontSize: "15px" }}>{"Reason saved: " + s.reason}</div>
              ) : (
                <>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {MISMATCH_REASONS.map((r) => (
                      <button key={r} onClick={() => this.setStock({ reason: r })} style={{ padding: "8px 12px", borderRadius: "16px", border: "1.5px solid " + (s.reason === r ? "#6835FB" : "#DDE1E8"), background: s.reason === r ? "#F1ECFF" : "#FFFFFF", fontSize: "14px", color: "#1A1E28", cursor: "pointer" }}>{r}</button>
                    ))}
                  </div>
                  <input value={s.reason} onChange={(e) => this.setStock({ reason: String(e.target.value).slice(0, 300) })} maxLength={300} placeholder="Or say it in your words" aria-label="Why it might differ" style={inputStyle} />
                  <button onClick={() => void this.saveStockReason()} style={btn(!s.reason.trim() || s.reasonSaving ? "off" : "p", 54)}>{s.reasonSaving ? "Saving…" : "Save reason"}</button>
                </>
              )}
            </div>
          )}
          <button onClick={() => this.stockBack()} style={btn(ok || s.reasonSaved ? "p" : "s", 58)}>Check the next item</button>
        </>,
      );
    }

    /* ---- counting one item */
    if (p) {
      const name = p.kind === "count" ? p.task.item : p.item.name;
      const unit = p.kind === "count" ? p.task.unit : p.item.unit;
      const blocked = p.kind === "count" ? p.task.blocked : null;
      return wrap(
        <>
          <div style={{ ...card, padding: "16px" }}>
            <span style={{ display: "block", fontSize: "21px", lineHeight: "26px", fontWeight: 700 }}>{name}</span>
            {p.kind === "count" && <span style={{ display: "block", ...mono, fontSize: "14px", fontWeight: 600, color: "#3D4453", marginTop: "2px" }}>{p.task.no + " · asked by the office"}</span>}
            {fact("Kind", p.kind === "count" ? STAGE_WORD.rm : STAGE_WORD[p.item.stage])}
            {fact("Godown", p.kind === "count" ? p.task.godown : s.godown)}
            {fact("Count in", UNIT_WORD[unit])}
            {p.kind === "count" && fact("Why", p.task.reason)}
            {p.kind === "count" && p.task.recount && fact("Recount", "Somebody else's count differed from the book", "#8A5C05")}
          </div>
          {blocked ? errBox({ title: "Not yours to count", text: blocked, fix: "Leave it for somebody else." }) : (
            <>
              <div style={{ fontSize: "14px", lineHeight: "20px", color: "#6B7385" }}>Count every drum, can or box of it here. The book figure is shown only after you save.</div>
              <button onClick={() => this.stockQty()} style={{ ...card, padding: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", border: "2px solid " + (s.qty == null ? "#6835FB" : "#DDE1E8"), cursor: "pointer", textAlign: "left" }}>
                <span>
                  <span style={{ display: "block", fontSize: "15px", color: "#6B7385" }}>What you counted</span>
                  <span style={{ display: "block", fontSize: "13px", color: "#9BA3B2", marginTop: "2px" }}>Zero if there is none</span>
                </span>
                <span style={{ fontSize: s.qty == null ? "18px" : "30px", fontWeight: 700, color: s.qty == null ? "#6835FB" : "#1A1E28", textAlign: "right" }}>{s.qty == null ? "Tap to enter" : nf(s.qty) + " " + UNIT_SHORT[unit]}</span>
              </button>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "15px", color: "#6B7385" }}>Where (optional)</span>
                <input value={s.bin} onChange={(e) => this.setStock({ bin: String(e.target.value).slice(0, 120) })} maxLength={120} placeholder="Bay, rack or bin" aria-label="Where" style={inputStyle} />
              </div>
              {s.err && errBox(s.err)}
              <button onClick={() => void this.saveStock()} style={btn(s.qty == null || s.saving ? "off" : "p", 60)}>{s.saving ? "Saving…" : "Save count"}</button>
            </>
          )}
        </>,
      );
    }

    /* ---- the list */
    const q = s.search.trim().toLowerCase();
    const ofStage = s.items.filter((i) => i.stage === s.stage);
    const shown = ofStage.filter((i) => !q || i.name.toLowerCase().includes(q));
    const hereN = ofStage.filter((i) => i.here).length;
    const doneN = ofStage.filter((i) => i.here && i.checkedToday).length;
    const misN = s.items.filter((i) => i.checkedToday && !i.checkedToday.matched).length;
    return wrap(
      <>
        {s.err && errBox(s.err)}
        {s.err && <button onClick={() => void this.loadStock()} style={btn("s", 54)}>Try again</button>}
        {misN > 0 && (
          <div style={{ padding: "12px 14px", borderRadius: "14px", background: "#FCECEC", display: "flex", alignItems: "center", gap: "10px" }}>
            {ic("alert", 22, "#B3261E")}
            <span style={{ flex: 1, fontSize: "15px", color: "#B3261E", fontWeight: 600 }}>{misN + (misN === 1 ? " item does" : " items do") + " not match the book today. The office has been told."}</span>
          </div>
        )}
        {s.office.length > 0 && (
          <>
            <span style={{ fontSize: "18px", fontWeight: 700 }}>Asked by the office</span>
            {s.office.map((t) => (
              <button key={t.id} onClick={() => this.pickStock({ kind: "count", task: t })} style={{ ...card, padding: "14px 16px", display: "flex", flexDirection: "column", alignItems: "stretch", gap: "6px", textAlign: "left", cursor: "pointer", border: "1px solid " + (t.overdue ? "#F6CFCF" : "#DDE1E8"), opacity: t.blocked ? 0.6 : 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "17px", fontWeight: 700, flex: 1 }}>{t.item}</span>
                  <span style={{ ...mono, fontSize: "13px", color: "#6B7385" }}>{t.no}</span>
                </div>
                <span style={{ fontSize: "14px", color: "#3D4453" }}>{t.godown + " · " + (t.overdue ? "overdue since " : "due ") + t.due}</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  <Pill l={t.kind} bg="#EDEFF3" fg="#3D4453" />
                  {t.recount && <Pill l="Recount" bg="#FDF6E7" fg="#8A5C05" />}
                  {t.forPurchase && <Pill l="Before a purchase" bg="#EAF0FB" fg="#2B5CBF" />}
                  {t.overdue && <Pill l="Overdue" bg="#FCECEC" fg="#B3261E" />}
                </div>
                {t.blocked && <span style={{ fontSize: "13px", color: "#8A5C05" }}>{t.blocked}</span>}
              </button>
            ))}
          </>
        )}
        <span style={{ fontSize: "18px", fontWeight: 700 }}>Check any stock</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {(["rm", "sfg", "fg", "pack"] as CheckStage[]).map((k) => (
            <button key={k} onClick={() => this.setStock({ stage: k })} style={{ padding: "10px 14px", borderRadius: "18px", border: "none", background: s.stage === k ? "#6835FB" : "#F1ECFF", color: s.stage === k ? "#FFFFFF" : "#5223E0", fontSize: "15px", fontWeight: 600, cursor: "pointer" }}>{STAGE_WORD[k]}</button>
          ))}
        </div>
        <input value={s.search} onChange={(e) => this.setStock({ search: String(e.target.value).slice(0, 60) })} placeholder="Search by name" aria-label="Search" style={inputStyle} />
        {hereN > 0 && <span style={{ fontSize: "14px", color: "#6B7385" }}>{doneN + " of " + hereN + " on the book here checked today"}</span>}
        {s.loading && !s.items.length && <div style={{ ...card, padding: "28px 20px", textAlign: "center", fontSize: "16px", color: "#6B7385" }}>Loading the stock…</div>}
        {!s.loading && !shown.length && <div style={{ ...card, padding: "28px 20px", textAlign: "center", fontSize: "16px", color: "#6B7385" }}>{q ? "Nothing by that name." : "Nothing of this kind yet."}</div>}
        {shown.slice(0, 200).map((i) => {
          const c = i.checkedToday;
          return (
            <button key={i.stage + i.id} onClick={() => this.pickStock({ kind: "check", item: i })} style={{ ...card, minHeight: "64px", padding: "12px 14px", display: "flex", alignItems: "center", gap: "10px", textAlign: "left", cursor: "pointer", border: "1px solid " + (c && !c.matched ? "#F6CFCF" : "#DDE1E8") }}>
              <span style={{ flex: 1 }}>
                <span style={{ display: "block", fontSize: "16px", fontWeight: 600 }}>{i.name}</span>
                <span style={{ display: "block", fontSize: "13px", color: c ? (c.matched ? "#1D7A45" : "#B3261E") : "#6B7385" }}>
                  {c ? (c.matched ? "Checked today · matched" : "Checked today · does not match") + " · " + c.by : "Count in " + UNIT_WORD[i.unit] + (i.here ? "" : " · none on the book here")}
                </span>
              </span>
              {c ? ic(c.matched ? "check" : "alert", 22, c.matched ? "#1D7A45" : "#B3261E") : ic("chev", 22)}
            </button>
          );
        })}
        {shown.length > 200 && <span style={{ fontSize: "14px", color: "#6B7385", textAlign: "center" }}>{"Showing 200 of " + shown.length + " — search to find the rest."}</span>}
      </>,
    );
  }

  /* ================================================================ empty drums */

  openDrum() {
    this.setState({ sheet: null, route: "drum", drum: null }, () => this.openScan("drum"));
  }

  drumWeight() {
    const d = this.state.drum;
    if (!d) return;
    this.openKp({
      l: "Weight of the empty drum", unit: "kg", v: d.kg, decimals: true,
      set: (v) => this.setState({ drum: { ...d, kg: v, err: null, ask: null } }),
    });
  }

  async saveDrum(different?: boolean) {
    const d = this.state.drum;
    if (!d || d.saving) return;
    if (d.kg == null) return this.drumWeight();
    this.setState({ drum: { ...d, saving: true, err: null } });
    try {
      const r = await call("emptyDrum", { code: d.lot.code, kg: d.kg, key: d.key, different: !!different });
      const now = this.state.drum ?? d;
      if (r.ok) {
        this.setState({ drum: { ...now, saving: false, saved: r.drum, ask: null } });
        this.toast(r.drum.label + " saved · " + r.drum.statusLabel);
        return;
      }
      if (r.kind === "confirm") return this.setState({ drum: { ...now, saving: false, ask: r.text } });
      this.setState({ drum: { ...now, saving: false, err: { title: r.title, text: r.text, fix: r.fix } } });
    } catch (e) {
      const now = this.state.drum ?? d;
      this.setState({ drum: { ...now, saving: false, err: { title: "No network", text: "The drum is not saved yet.", fix: "Check the Wi-Fi and press Save again. It is safe — the drum will not be counted twice." } } });
      if (!(e instanceof NotReceived)) throw e;
    }
  }

  renderDrum(): ReactNode {
    const st = this.state, T = this.T(), d = st.drum;
    const fact = (l: string, v: string, tone?: string) => (
      <div key={l} style={{ display: "flex", justifyContent: "space-between", gap: "12px", padding: "10px 0", borderBottom: "1px solid #EDEFF3" }}>
        <span style={{ fontSize: "15px", color: "#6B7385" }}>{l}</span>
        <span style={{ fontSize: "15px", fontWeight: 700, color: tone ?? "#1A1E28", textAlign: "right" }}>{v}</span>
      </div>
    );
    const scanBtn = (l: string) => (
      <button onClick={() => this.openScan("drum")} style={{ background: "#6835FB", border: "none", borderRadius: "20px", padding: "18px 20px", color: "#FFFFFF", display: "flex", alignItems: "center", gap: "16px", textAlign: "left", cursor: "pointer", minHeight: "104px" }}>
        <span style={{ width: "68px", height: "68px", flex: "none", borderRadius: "18px", background: "rgba(255,255,255,0.14)", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic("qr", 40, "#FFFFFF")}</span>
        <span style={{ flex: 1 }}>
          <span style={{ display: "block", fontSize: "22px", lineHeight: "28px", fontWeight: 700 }}>{l}</span>
          <span style={{ display: "block", fontSize: "15px", color: "#DDD2FF", marginTop: "4px" }}>Scan it while the label can still be read</span>
        </span>
      </button>
    );
    const head = (
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <button onClick={() => this.setState({ route: "more", drum: null })} aria-label={T.back} style={{ width: "44px", height: "44px", borderRadius: "50%", border: "none", background: "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>{ic("back", 22, "#5223E0")}</button>
        <span style={{ fontSize: "20px", fontWeight: 700 }}>Empty drum entry</span>
      </div>
    );
    if (!d) {
      return (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
          {head}
          {scanBtn("Scan the empty drum")}
          <div style={{ ...card, padding: "14px", fontSize: "15px", lineHeight: "22px", color: "#3D4453" }}>
            When a drum is completely empty: scan its GRN label, weigh the empty drum, enter the weight and save. The GRN, supplier, material and lot come from the label. If the label is torn, keep the drum aside and tell the Production Head.
          </div>
        </div>
      );
    }
    const l = d.lot, sv = d.saved;
    const ownTone = l.ownership === "returnable" ? "#2B5CBF" : l.ownership === "mahek" ? "#1D7A45" : "#8A5C05";
    if (sv) {
      const varTxt = sv.varianceKg == null ? "No declared weight on the GRN" : (sv.varianceKg > 0 ? "+" : "") + nf(sv.varianceKg) + " kg";
      return (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
          {head}
          <div style={{ ...card, padding: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ width: "52px", height: "52px", flex: "none", borderRadius: "50%", background: "#E9F5EE", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic("check", 28, "#1D7A45")}</span>
              <span style={{ flex: 1 }}>
                <span style={{ display: "block", fontSize: "22px", fontWeight: 700 }}>{sv.label + " saved"}</span>
                <span style={{ display: "block", fontSize: "15px", color: "#6B7385" }}>{sv.statusLabel}</span>
              </span>
            </div>
            {fact("Material", sv.material)}
            {fact("Lot", sv.lotNo + (sv.seq ? " · drum " + sv.seq + (sv.drums ? " of " + sv.drums : "") : ""))}
            {fact("Supplier", sv.supplier)}
            {fact("Empty weight", nf(sv.actualKg) + " kg")}
            {fact("Against the GRN", varTxt)}
            {sv.reviewReason && <div style={{ marginTop: "10px", padding: "12px", borderRadius: "12px", background: "#FDF6E7", color: "#8A5C05", fontSize: "15px", lineHeight: "21px" }}>{"The Production Head will check it: " + sv.reviewReason + "."}</div>}
          </div>
          {scanBtn("Scan the next drum")}
        </div>
      );
    }
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
        {head}
        <div style={{ ...card, padding: "16px" }}>
          <span style={{ display: "block", fontSize: "21px", lineHeight: "26px", fontWeight: 700 }}>{l.material}</span>
          <span style={{ display: "block", ...mono, fontSize: "14px", fontWeight: 600, color: "#3D4453", marginTop: "2px" }}>{l.lotNo}</span>
          {fact("Supplier", l.supplier)}
          {fact("GRN", "PR " + l.pr)}
          {fact("This drum", "Drum " + l.nextSeq + (l.drums ? " of " + l.drums : ""))}
          {fact("Belongs to", l.ownershipLabel, ownTone)}
          {fact("Declared empty weight", l.declaredKg == null ? "Not on the GRN" : nf(l.declaredKg) + " kg")}
        </div>
        <button onClick={() => this.drumWeight()} style={{ ...card, padding: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", border: "2px solid " + (d.kg == null ? "#6835FB" : "#DDE1E8"), cursor: "pointer", textAlign: "left" }}>
          <span>
            <span style={{ display: "block", fontSize: "15px", color: "#6B7385" }}>Weight of the empty drum</span>
            <span style={{ display: "block", fontSize: "13px", color: "#9BA3B2", marginTop: "2px" }}>{"Usually " + nf(d.limits.minKg) + "–" + nf(d.limits.maxKg) + " kg"}</span>
          </span>
          <span style={{ fontSize: d.kg == null ? "18px" : "30px", fontWeight: 700, color: d.kg == null ? "#6835FB" : "#1A1E28", textAlign: "right" }}>{d.kg == null ? "Tap to enter" : nf(d.kg) + " kg"}</span>
        </button>
        {d.ask && (
          <div style={{ padding: "14px", borderRadius: "14px", background: "#FDF6E7", border: "1px solid #F9E9C4" }}>
            <div style={{ fontSize: "16px", lineHeight: "23px", color: "#8A5C05", fontWeight: 600 }}>{d.ask}</div>
            <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
              <button onClick={() => this.setState({ drum: null })} style={{ ...btn("s", 54), flex: 1 }}>No, same drum</button>
              <button onClick={() => void this.saveDrum(true)} style={{ ...btn("p", 54), flex: 1 }}>Yes, a different drum</button>
            </div>
          </div>
        )}
        {d.err && (
          <div style={{ padding: "14px", borderRadius: "14px", background: "#FCECEC" }}>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#B3261E" }}>{d.err.title}</div>
            <div style={{ fontSize: "15px", lineHeight: "22px", color: "#1A1E28", marginTop: "6px" }}>{d.err.text}</div>
            <div style={{ fontSize: "15px", lineHeight: "22px", color: "#1A1E28", marginTop: "6px" }}><span style={{ fontWeight: 700 }}>What to do: </span>{d.err.fix}</div>
          </div>
        )}
        {!d.ask && (
          <div style={{ display: "flex", gap: "10px" }}>
            <button onClick={() => this.openScan("drum")} style={{ ...btn("s", 58), flex: 1 }}>{T.scanAgain}</button>
            <button onClick={() => void this.saveDrum()} style={{ ...btn(d.kg == null || d.saving ? "off" : "p", 58), flex: 2 }}>{d.saving ? "Saving…" : "Save empty drum"}</button>
          </div>
        )}
      </div>
    );
  }

  /** How much of drum i was poured. The quick answer is what is still owed of
      this material, or all of the drum where the drum holds less — and taking
      a drum to empty with the sheet still short opens the next drum's row. */
  rmKp(i: number) {
    const db = this.db(), d = this.state.flow!.d, q = d.rm![i];
    const x = q.lot ? db.lots[q.lot] : undefined;
    const nm = db.rm[q.item]?.n ?? q.item;
    const p = rmPlan(d, i);
    const quick = x && x.avail < p.rest
      ? [{ l: "All of this drum · " + nf(x.avail) + " L", v: x.avail }]
      : p.rest > 0 ? [{ l: (p.others ? "The rest · " : "As on sheet · ") + nf(p.rest) + " L", v: p.rest }] : [];
    this.openKp({
      l: "How much " + nm + " did you pour?", unit: "L", v: q.qty, max: x ? x.avail : null, maxL: x ? "Only " + nf(x.avail) + " L in this lot" : "",
      quick,
      set: (v) => this.setD((z) => {
        z.rm = z.rm!.map((r, j) => (j === i ? { ...r, qty: v } : r));
        const after = rmPlan(z, i);
        if (x && v >= x.avail && after.poured < after.need && after.last) z.rm = addRmDrum(z.rm, i);
      }),
    });
  }

  manualPick() {
    const st = this.state, sc = st.scan!, P = sc.purpose, db = this.db(), f = st.flow!;
    const lots = Object.values(db.lots);
    let pool: Lot[] = [];
    if (P === "rm") pool = lots.filter((x) => x.type === "rm" && x.item === sc.meta.item && !(f.d.rm ?? []).some((r, i) => i !== sc.meta.idx && r.lot === x.code));
    if (P === "sfg") pool = lots.filter((x) => x.type === "sfg" && x.item === db.sku[f.d.sku!].sfg);
    if (P === "pm") pool = lots.filter((x) => x.type === "pm" && x.item === db.sku[f.d.sku!].pm);
    if (P === "fg") pool = lots.filter((x) => x.type === "fg" && x.item === db.box[f.d.box!].sku);
    if (P === "load") pool = db.orders[f.task.order!].lines.reduce<Lot[]>((a, ln) => a.concat(ln.alloc.map((z) => db.lots[z[0]]).filter(Boolean)), []);
    const sheet: TilesSheet = {
      type: "tiles",
      title: "Pick from photos",
      sub: "Use this only if the label is torn. Your supervisor will see this.",
      groups: [{ title: "Here at " + db.loc, cols: 2, items: pool.filter((x) => x.status === "ok" && x.loc === db.loc && x.avail > 0).map((x) => ({ l: x.code, sub: nf(x.avail) + " " + lotUnit(db, x) + " left", art: this.lotArt(x, 56), v: x.code })) }],
      pick: (v) => {
        this.setState({ sheet: null });
        void this.doScan(v, true);
      },
    };
    this.setState({ sheet });
  }

  /* ================================================================ a job */

  startTask(id: string) {
    const st = this.state;
    const t = this.task(id);
    if (!t) return;
    if (t.status === "blocked") return this.toast(this.db().orders[t.order!]?.blocked ?? "This order is not ready yet. Wait for the office.");
    const keep = st.drafts[id];
    if (keep) return this.setState({ flow: { ...keep, task: { ...keep.task, ...t } } });
    const db = this.db();
    const team = JSON.parse(JSON.stringify(t.team)) as Team;
    const d: Draft = { team, down: null, downR: null, downMin: null };
    if (t.proc === "mixing") Object.assign(d, { batches: t.batches ?? 1, rm: (db.sfg[t.item!]?.recipe ?? []).map((r) => ({ item: r[0], per: r[1], lot: null, qty: null })), out: null });
    if (t.proc === "filling") Object.assign(d, { sku: t.item, sfg: null, pm: null, filled: null, rej: 0, rejR: null });
    if (t.proc === "packing") Object.assign(d, { box: t.item, fg: [], boxes: null });
    if (t.proc === "dispatch") Object.assign(d, { loads: {}, checks: {}, photo: null, photoId: null });
    this.setState({ flow: { task: t, step: 0, d, key: mintKey(t.id) }, started: { ...st.started, [id]: 1 } });
  }

  setD(fn: (d: Draft) => void) {
    const f = this.state.flow;
    if (!f) return;
    const d = JSON.parse(JSON.stringify(f.d)) as Draft;
    fn(d);
    const flow = { ...f, d };
    this.setState({ flow, drafts: { ...this.state.drafts, [f.task.id]: flow } });
  }

  openKp(cfg: Omit<KpSheet, "type" | "v"> & { v?: number | null }) {
    this.setState({ sheet: { ...cfg, type: "kp", v: cfg.v != null ? String(cfg.v) : "" } });
  }

  downCheckMsg(d: Draft) {
    return downCheck(d);
  }

  reviewVM(f: Flow) {
    const t = f.task, d = f.d, db = this.db(), T = this.T();
    const rv = { art: this.taskArt(t, 76), name: taskName(db, t), code: t.id, rows: [] as { l: string; v: string }[], warns: [] as Msg[], team: [] as { l: string; v: string }[], key: "" };
    const R = (l: string, v: string) => rv.rows.push({ l, v });
    if (t.proc === "mixing") {
      (d.rm ?? []).forEach((r) => R(db.rm[r.item].n + " · " + r.lot, nf(r.qty) + " L"));
      R("Batches", String(d.batches));
      R("Made", nf(mixMade(d)) + " L");
      if (mixDeviation(db, t, d).over) rv.warns.push(msg("This is more or less than normal. Your supervisor will check it.", "warn"));
      if ((d.rm ?? []).some((r) => r.manual)) rv.warns.push(msg("You picked a drum from photos. Your supervisor will check it.", "warn"));
    }
    if (t.proc === "filling") {
      const k = db.sku[d.sku!], u = k.kind === "drum" ? "drums" : "cans";
      R("Base liquid · " + d.sfg, nf((d.filled ?? 0) * k.l) + " L");
      R("Empty " + u + " · " + d.pm, nf(d.filled));
      R("Filled", nf(d.filled) + " " + u);
      R("Damaged", nf(d.rej) + (d.rej ? " · " + d.rejR : ""));
      R("Good " + u, nf((d.filled ?? 0) - (d.rej ?? 0)));
      if (d.sku !== t.item) rv.warns.push(msg("Size changed from the task sheet (" + db.sku[t.item!].size + " → " + k.size + ").", "warn"));
      if (d.sfgManual || d.pmManual) rv.warns.push(msg("You picked a lot from photos. Your supervisor will check it.", "warn"));
    }
    if (t.proc === "packing") {
      const b = db.box[d.box!];
      (d.fg ?? []).forEach((g) => R("Filled cans · " + g.lot, nf(db.lots[g.lot]?.avail) + " available"));
      R("Boxes packed", nf(d.boxes));
      R("Cans used", nf((d.boxes ?? 0) * b.cpb));
      const total = (t.carry || 0) + (d.boxes ?? 0), rem = total % b.batch;
      R("Full batches", String(Math.floor(total / b.batch)));
      if (rem) rv.warns.push(msg(rem + " boxes wait for the next batch.", "warn"));
      if ((d.fg ?? []).some((g) => g.manual)) rv.warns.push(msg("You picked a pallet from photos. Your supervisor will check it.", "warn"));
    }
    if (t.proc === "dispatch") {
      const ord = db.orders[t.order!];
      R("Order", t.order + " · " + (ord?.cust ?? ""));
      Object.keys(d.loads ?? {}).forEach((k) => R("Loaded · " + k, String(d.loads![k])));
      R("Checks", "All done · photo " + d.photo);
      R("Truck", ord?.vehicle && ord.vehicle !== "—" ? ord.vehicle : (ord?.trans ?? "—"));
    }
    if (d.down) R("Machine stopped", d.downMin + " " + T.minutes + " · " + d.downR);
    const tm = d.team;
    rv.team = (
      [["Responsible", tm.owner], ["Operator", tm.op], ["Helpers", tm.helpers], ["Checked by", tm.ver]] as [string, string | string[] | null][]
    ).map(([l, v]) => ({ l, v: Array.isArray(v) ? (v.length ? v.map((x) => this.name(x)).join(", ") : "None") : v ? this.name(v) : "—" })).concat([{ l: "Saved by", v: this.state.me!.n }]);
    if (!tm.helpers.length) rv.warns.push(msg("No helper added. If someone helped you, add them in Team.", "info"));
    rv.key = "Tapping again is safe. This work is saved only once.";
    return rv;
  }

  readBack(f: Flow) {
    const rv = this.reviewVM(f);
    return rv.name + ". " + rv.rows.map((r) => r.l.split(" · ")[0] + ": " + r.v).join(". ") + ".";
  }

  openReport(t: Task) {
    const sheet: ReasonSheet = {
      type: "reason",
      title: "What is wrong?",
      sub: "Your supervisor will get this now. Do not start the work.",
      reasons: ["Wrong product on the sheet", "Product is not here", "Machine is not working", "Material is missing"],
      done: async (r) => {
        this.setState({ busy: true });
        try {
          const res = await call("reportProblem", t.id, r, taskName(this.db(), t));
          if (!res.ok) return this.toast(res.error);
          const drafts = { ...this.state.drafts };
          delete drafts[t.id];
          this.setState({ flow: null, sheet: null, db: res.data, drafts });
          this.toast("Sent to the Production Head");
        } catch {
          this.toast("No network. Tell your supervisor in person.");
        } finally {
          this.setState({ busy: false });
        }
      },
    };
    this.setState({ sheet });
  }

  /* ================================================================ sending */

  /** The submission a flow sends — today's shape, stamped with when it was finished. */
  private toSubmission(f: Flow, savedIso: string, extra: { queued?: boolean; toSupervisor?: boolean } = {}) {
    return { key: f.key, taskId: f.task.id, d: f.d, savedAt: savedIso, v: SUBMISSION_VERSION, build: PAGE_BUILD, ...extra };
  }

  /**
   * A photo taken with no network is still on the phone, keyed by the job.
   * Upload it before the job goes, so the job reaches the server complete.
   * Throws NotReceived if it cannot — the job then waits with its photo.
   */
  private async withPhoto(f: Flow): Promise<Flow> {
    if (f.task.proc !== "dispatch" || f.d.photoId || !f.d.photo) return f;
    const blob = await keptPhoto(f.key);
    if (!blob) return f;
    const body = new FormData();
    body.append("file", blob, "truck.jpg");
    let r: Response;
    try {
      r = await fetch("/api/factory/photo", { method: "POST", body });
    } catch {
      throw new NotReceived("photo");
    }
    if (r.status >= 500) throw new NotReceived("photo");
    const j = (await r.json().catch(() => ({}))) as { id?: string };
    if (!j.id) return f; // a photo the server will not take is not a reason to lose the job
    void dropPhoto(f.key);
    return { ...f, d: { ...f.d, photoId: j.id } };
  }

  /** Puts a job in this phone's queue: kept, shown as waiting, and sent by itself. */
  private enqueue(f: Flow, savedIso: string) {
    const item: QItem = { key: f.key, flow: JSON.parse(JSON.stringify(f)), at: this.now(), savedIso, status: "pending" };
    const r: Res = { kind: "pending", key: f.key, task: f.task.id, proc: f.task.proc };
    const drafts = { ...this.state.drafts };
    delete drafts[f.task.id];
    this.setState({ result: r, flow: null, sending: false, queue: this.state.queue.filter((q) => q.key !== f.key).concat([item]), drafts });
  }

  async submit(toSupervisor = false) {
    const st = this.state;
    let f = st.flow;
    if (!f) return;
    if (st.sending) return this.toast("Already sending — please wait");
    if (st.results[f.key]) return this.setState({ result: st.results[f.key] });
    const savedIso = new Date().toISOString();
    if (st.net === "offline" || !navigator.onLine) return this.enqueue(f, savedIso);
    this.setState({ sending: true, result: { kind: "sending", key: f.key } });
    try {
      f = await this.withPhoto(f);
      const { result: r, data } = await call("submit", this.toSubmission(f, savedIso, { toSupervisor }));
      /* "Not received" from the server's side — it is busy, or failed in a
         way that is nobody's fault on the floor. Keep it; it goes by itself. */
      if (r.kind === "retry") return this.enqueue(f, savedIso);
      const s2 = this.state;
      const results = { ...s2.results };
      const drafts = { ...s2.drafts };
      const finished = r.kind === "done" || r.kind === "held";
      if (finished) {
        results[f.key] = r;
        delete drafts[f.task.id];
      }
      this.setState({ sending: false, result: r, results, drafts, flow: finished ? null : { ...f }, db: data ?? s2.db });
    } catch {
      /* No answer is not "not saved": the key makes sending again safe, so it
         waits on the phone and goes by itself (PRD §4, "no silent failure"). */
      this.setNet(readNet() === "offline" ? "offline" : "weak");
      this.enqueue(f, savedIso);
    }
  }

  /**
   * Sends what is waiting, oldest first. Nothing here ever shows an error:
   * a job the ERP now refuses comes back HELD — received, with the supervisor
   * — and anything not received simply stays and goes on the next pass.
   */
  async flushQueue() {
    const st = this.state;
    const q = st.queue.filter((x) => x.status === "pending");
    const self = this as unknown as { flushing?: boolean };
    if (!q.length || st.net === "offline" || !st.me || self.flushing) return;
    self.flushing = true;
    let sent = 0, held = 0;
    let data: FactoryData | null = null;
    try {
      for (const x of q) {
        try {
          const flow = await this.withPhoto(x.flow);
          const res = await call("submit", this.toSubmission(flow, x.savedIso ?? x.at, { queued: true }));
          if (res.result.kind === "retry") break;
          data = res.data ?? data;
          const at = this.now();
          const status: QItem["status"] = res.result.kind === "done" ? "done" : res.result.kind === "held" ? "held" : "failed";
          this.setState({
            queue: this.state.queue.map((z) => (z.key === x.key ? { ...z, flow, status, doneAt: at, result: res.result } : z)),
            results: status === "done" || status === "held" ? { ...this.state.results, [x.key]: res.result } : this.state.results,
          });
          if (status === "done") sent++;
          if (status === "held") held++;
        } catch {
          break;
        }
      }
    } finally {
      self.flushing = false;
    }
    if (data) this.setState({ db: data });
    if (sent || held) this.toast((sent ? sent + " waiting job" + (sent > 1 ? "s" : "") + " saved in ERP" : "") + (sent && held ? " · " : "") + (held ? held + " sent to your supervisor" : ""));
    /* Finished jobs stay on the list for two days, then go — pending ones never do. */
    const cutoff = Date.now() - OFFLINE_HOURS * 3_600_000;
    const pruned = this.state.queue.filter((z) => z.status === "pending" || z.status === "failed" || !z.savedIso || Date.parse(z.savedIso) > cutoff);
    if (pruned.length !== this.state.queue.length) this.setState({ queue: pruned });
    const r = this.state.result;
    if (r && r.kind === "pending" && this.state.queue.some((z) => z.key === r.key && z.status !== "pending")) this.setState({ result: this.state.queue.find((z) => z.key === r.key)?.result ?? null });
    this.maybeReload();
  }

  /* ================================================================ the head */

  decide(it: FactoryData["review"][number], act: string, i: number) {
    const reasons = i
      ? ["Count again on the floor", "Wrong lot or product", "Not enough information", "Other — I will call the team"]
      : ["Checked on the floor — correct", "Raw material was different", "Machine issue, already fixed", "Agreed with the team"];
    const ask = (helpers?: string[]) =>
      this.setState({
        sheet: {
          type: "reason",
          title: act,
          sub: it.title + " · " + it.task + ". Your reason is saved in the history.",
          reasons,
          okL: act,
          danger: !!i && /Reject|Decline|re-check/.test(act),
          done: async (r) => {
            this.setState({ busy: true });
            try {
              const res = await call("decide", it.id, act, i, r, helpers);
              if (!res.ok) return this.toast(res.error);
              this.setState({ sheet: null, db: res.data });
              this.toast(act + " · saved in history");
            } catch {
              this.toast("No network. Try again when it is back.");
            } finally {
              this.setState({ busy: false });
            }
          },
        },
      });
    /* "Add helper" names the helper first — a decision with nobody in it would close the item and fix nothing. */
    if (it.kind === "attribution" && i === 0) {
      const t = this.task(it.task);
      return this.setState({ sheet: { type: "people", role: "helpers", multi: true, sel: [], area: t?.proc ?? "", onDone: (sel) => (sel.length ? ask(sel) : this.toast("Choose who helped")) } });
    }
    ask();
  }

  async headCall(p: Promise<{ ok: true; data: FactoryData; msg: string } | { ok: false; error: string }>, then?: (data: FactoryData) => void) {
    this.setState({ busy: true });
    try {
      const r = await p;
      if (!r.ok) return this.toast(r.error);
      this.setState({ db: r.data });
      then?.(r.data);
      if (r.msg) this.toast(r.msg);
    } catch {
      this.toast("No network. Try again when it is back.");
    } finally {
      this.setState({ busy: false });
    }
  }

  /**
   * The truck photo is KEPT on the phone first and uploaded second. Taking
   * it never fails for want of a signal: with none, it waits in IndexedDB and
   * goes up just before its job does (`withPhoto`).
   */
  async takePhoto(file: File | undefined) {
    const f = this.state.flow;
    if (!file || !f) return;
    const blob = await shrinkPhoto(file);
    const at = this.now();
    const kept = await keepPhoto(f.key, blob);
    if (this.state.net !== "offline" && navigator.onLine) {
      try {
        const body = new FormData();
        body.append("file", blob, "truck.jpg");
        const r = await fetch("/api/factory/photo", { method: "POST", body });
        const j = (await r.json().catch(() => ({}))) as { id?: string };
        if (r.ok && j.id) {
          void dropPhoto(f.key);
          this.setD((z) => { z.photo = at; z.photoId = j.id!; });
          return this.toast("Photo saved");
        }
      } catch {
        /* Falls through to keeping it on the phone. */
      }
    }
    if (!kept) return this.toast("This phone is full. Free some space, then take the photo again.");
    this.setD((z) => { z.photo = at; z.photoId = null; });
    this.toast("Photo kept on this phone. It will send with the job.");
  }


  /* ================================================================ render */

  render() {
    const st = this.state, me = st.me, head = !!me?.head;
    const dark = !!st.scan;
    const isScan = !!st.scan;
    const signing = (!me || st.signStep === "newpin") && !isScan;
    const isResult = !isScan && !!st.result && !!me && !signing;
    const isFlow = !isScan && !st.result && !!st.flow && !!me && !signing;
    const shell = !!me && !signing && !isScan && !isResult && !isFlow;
    const R = shell ? st.route : "";
    const sbStyle: CSSProperties = { height: "30px", flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", fontSize: "13px", fontWeight: 700, color: dark ? "#FFFFFF" : "#1A1E28", background: st.scan ? "#0E1016" : "#FFFFFF" };
    return (
      <div className="fx-stage">
        <div className="fx-phone">
          <div className="fx-sb" style={sbStyle}>
            <span>{st.clock}</span>
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {ic(st.net === "offline" ? "wifioff" : "wifi", 14)}
              <span style={{ width: "22px", height: "11px", border: "1.5px solid currentColor", borderRadius: "3px", padding: "1px", display: "flex" }}>
                <span style={{ width: "70%", background: "currentColor", borderRadius: "1px" }} />
              </span>
            </span>
          </div>

          {signing && this.renderSignin()}
          {shell && !this.reqFullScreen() && this.renderBar(head)}
          {shell && !head && R === "home" && this.renderHome()}
          {isScan && this.renderScan()}
          {isFlow && this.renderFlow()}
          {isResult && this.renderResult()}
          {shell && R === "sync" && this.renderSync()}
          {shell && R === "help" && this.renderHelp()}
          {shell && R === "more" && this.renderMore()}
          {shell && R === "settings" && this.renderSettings()}
          {shell && R === "drum" && this.renderDrum()}
          {shell && R === "stock" && this.renderStock()}
          {shell && R === "qc" && this.renderQc()}
          {shell && R === "req" && this.renderReq()}
          {shell && head && R === "today" && this.renderToday()}
          {shell && head && R === "review" && this.renderReview()}
          {shell && head && R === "teams" && this.renderTeams()}
          {shell && head && R === "machines" && this.renderMachines()}
          {shell && !this.reqFullScreen() && this.renderNav(head)}

          {st.sheet && me && this.renderSheet()}
          {st.toast && (
            <div role="status" style={{ position: "absolute", left: "16px", right: "16px", bottom: st.flow ? "132px" : "92px", zIndex: 60, display: "flex", alignItems: "center", gap: "10px", background: st.toastTone === "warn" ? "#8A5C05" : "#3D14A8", color: "#FFFFFF", borderRadius: "14px", padding: "14px 16px", fontSize: "15px", lineHeight: "20px", boxShadow: "0 8px 24px rgba(26,30,40,0.25)", animation: "fx-up 150ms cubic-bezier(0.2,0,0.2,1)" }}>
              <span style={{ width: "24px", height: "24px", borderRadius: "50%", background: st.toastTone === "warn" ? "rgba(255,231,168,0.25)" : "rgba(198,255,52,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{st.toastTone === "warn" ? ic("alert", 15, "#FFE7A8") : ic("check", 15, "#C6FF34")}</span>
              <span style={{ flex: 1 }}>{st.toast}</span>
            </div>
          )}
          <input ref={(el) => { this.photoInput = el; }} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void this.takePhoto(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- sign in */

  renderSignin(): ReactNode {
    const st = this.state, T = this.T();
    const step = st.signStep;
    const LG: [Lang, string, string, string][] = [["en", "English", "A", "Default"], ["hi", "हिन्दी", "हि", "Hindi"], ["mr", "मराठी", "म", "Marathi"]];
    const p = st.phone;
    const ok10 = p.length === 10;
    const who = st.pinFor;
    const pinBox = (err: boolean, top: string): CSSProperties => ({ width: "100%", marginTop: top, height: "64px", padding: "0 16px", borderRadius: "14px", border: "1.5px solid " + (err ? "#B3261E" : "#C2C8D2"), background: "#FFFFFF", fontSize: "28px", fontWeight: 700, letterSpacing: "0.5em", color: "#1A1E28", outline: "none" });
    const head = (
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <span style={avStyle(who ? who.key.length : 0, 52)}>{who?.ini ?? "?"}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: "18px", fontWeight: 700 }}>{who?.n}</span>
          <span style={{ display: "block", fontSize: "14px", color: "#6B7385" }}>{who?.ph ? "+91 " + who.ph.slice(0, 5) + " " + who.ph.slice(5) : ""}</span>
        </span>
        <button onClick={() => this.setState({ pinFor: null, pin: "", signStep: "id" })} style={{ height: "40px", padding: "0 4px", border: "none", background: "transparent", color: "#5223E0", fontSize: "15px", fontWeight: 600, cursor: "pointer" }}>{T.change}</button>
      </div>
    );
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, background: "#FFFFFF" }}>
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: "8px", padding: "20px 24px 0 24px" }}>
          <span style={{ width: "22px", height: "22px", background: "#6835FB", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ width: "8px", height: "8px", background: "#C6FF34", borderRadius: "2px" }} /></span>
          <span style={{ fontSize: "15px", fontWeight: 700, letterSpacing: "0.02em", color: "#1A1E28" }}>MAHEK ONE</span>
          <span style={{ fontSize: "15px", color: "#6B7385" }}>Factory</span>
        </div>

        {step === "lang" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "24px 20px 20px 20px", minHeight: 0 }}>
            <div style={{ fontSize: "26px", lineHeight: "32px", fontWeight: 700 }}>Choose your language</div>
            <div style={{ fontSize: "17px", color: "#6B7385", marginTop: "4px" }}>भाषा चुनें · भाषा निवडा</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "22px" }}>
              {LG.map(([k, l, sh, sub]) => {
                const on = st.lang === k;
                return (
                  <button key={k} onClick={() => this.setState({ lang: k })} style={{ display: "flex", alignItems: "center", gap: "14px", width: "100%", height: "84px", padding: "0 16px", borderRadius: "18px", border: on ? "3px solid #6835FB" : "1.5px solid #DDE1E8", background: on ? "#F7F4FF" : "#FFFFFF", cursor: "pointer" }}>
                    <span style={{ width: "52px", height: "52px", borderRadius: "14px", background: on ? "#6835FB" : "#F1ECFF", color: on ? "#FFFFFF" : "#5223E0", fontSize: "24px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{sh}</span>
                    <span style={{ flex: 1, textAlign: "left" }}>
                      <span style={{ display: "block", fontSize: "22px", fontWeight: 700 }}>{l}</span>
                      <span style={{ display: "block", fontSize: "14px", color: "#6B7385" }}>{sub}</span>
                    </span>
                    <span style={{ width: "24px", height: "24px", borderRadius: "50%", flex: "none", border: on ? "7px solid #6835FB" : "2px solid #C2C8D2", background: "#FFFFFF" }} />
                  </button>
                );
              })}
            </div>
            <button onClick={() => { save(null, "lang", st.lang); this.setState({ signStep: "id" }); }} style={{ ...btn("p", 62), marginTop: "auto" }}>{T.next}</button>
          </div>
        )}

        {step === "id" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "56px 24px 24px 24px", minHeight: 0 }}>
            <div style={{ fontSize: "30px", lineHeight: "36px", fontWeight: 700, color: "#1A1E28" }}>{T.signIn}</div>
            <div style={{ fontSize: "16px", lineHeight: "23px", color: "#6B7385", marginTop: "6px" }}>{T.yourMobile}</div>
            <label style={{ display: "flex", alignItems: "center", gap: "12px", height: "64px", marginTop: "28px", padding: "0 16px", borderRadius: "14px", border: "1.5px solid " + (st.idErr ? "#B3261E" : "#C2C8D2"), background: "#FFFFFF" }}>
              <span style={{ fontSize: "18px", fontWeight: 600, color: "#6B7385" }}>+91</span>
              <span style={{ width: "1px", height: "28px", background: "#DDE1E8" }} />
              <input value={p} onChange={(e) => this.setState({ phone: String(e.target.value).replace(/\D/g, "").slice(0, 10), idErr: "" })} onKeyDown={(e) => e.key === "Enter" && void this.idNext()} inputMode="numeric" autoComplete="tel" maxLength={10} placeholder="98502 20231" aria-label={T.yourMobile} style={{ flex: 1, minWidth: 0, height: "100%", border: "none", outline: "none", background: "transparent", fontSize: "24px", fontWeight: 600, letterSpacing: "0.03em", color: "#1A1E28" }} />
            </label>
            {st.idErr && <div style={{ fontSize: "15px", lineHeight: "21px", color: "#B3261E", fontWeight: 600, marginTop: "10px" }}>{st.idErr}</div>}
            <button onClick={() => void this.idNext()} style={{ ...btn(ok10 && !st.busy ? "p" : "off", 58), marginTop: "16px" }}>{st.busy ? T.sending : T.cont}</button>
            <button onClick={() => this.openScan("badge")} style={{ height: "48px", marginTop: "8px", border: "none", background: "transparent", color: "#5223E0", fontSize: "16px", fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", cursor: "pointer" }}>{ic("badge", 24)}{T.scanBadge}</button>
            <button onClick={() => this.setState({ signStep: "lang" })} style={{ marginTop: "auto", height: "40px", border: "none", background: "transparent", color: "#6B7385", fontSize: "14px", fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", cursor: "pointer" }}>{ic("globe", 18)}{T.language} · {LG.find((x) => x[0] === st.lang)?.[1]}</button>
          </div>
        )}

        {step === "otp" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "28px 24px 20px 24px", minHeight: 0 }}>
            <button onClick={() => this.setState({ signStep: who?.hasPin ? "pin" : "id", otpErr: "" })} style={{ alignSelf: "flex-start", height: "40px", padding: "0 8px 0 0", border: "none", background: "transparent", color: "#5223E0", fontSize: "15px", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>{ic("back", 24)}{T.back}</button>
            <div style={{ fontSize: "26px", lineHeight: "32px", fontWeight: 700, marginTop: "20px" }}>{T.smsCode}</div>
            <div style={{ fontSize: "16px", lineHeight: "23px", color: "#6B7385", marginTop: "6px" }}>
              {(st.otpTo ? "We sent a 6-digit code to " + st.otpTo + "." : "We are sending a 6-digit code to your phone.") + (who?.hasPin ? " You will set a new PIN after this." : " You will choose your PIN after this.")}
            </div>
            <input value={st.otp} onChange={(e) => { const q = String(e.target.value).replace(/\D/g, "").slice(0, 6); this.setState({ otp: q, otpErr: "" }); if (q.length === 6) void this.tryOtp(q); }} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus placeholder="______" aria-label={T.smsCode} style={{ ...pinBox(!!st.otpErr, "24px"), letterSpacing: "0.4em" }} />
            {st.otpErr && <div style={{ fontSize: "15px", lineHeight: "21px", fontWeight: 600, color: "#B3261E", marginTop: "10px" }}>{st.otpErr}</div>}
            <button onClick={() => void this.tryOtp(st.otp)} style={{ ...btn(st.otp.length === 6 && !st.busy ? "p" : "off", 58), marginTop: "16px" }}>{T.cont}</button>
            <button onClick={() => void this.sendCode()} style={{ alignSelf: "center", marginTop: "8px", height: "44px", border: "none", background: "transparent", color: st.otpT > 0 ? "#9BA3B2" : "#5223E0", fontSize: "15px", fontWeight: 700, cursor: st.otpT > 0 ? "default" : "pointer" }}>{st.otpT > 0 ? T.resendIn + " 0:" + String(st.otpT).padStart(2, "0") : T.resend}</button>
          </div>
        )}

        {step === "pin" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "28px 24px 20px 24px", minHeight: 0 }}>
            {head}
            <div style={{ fontSize: "26px", lineHeight: "32px", fontWeight: 700, marginTop: "32px" }}>{T.enterPin}</div>
            <input type="password" value={st.pin} onChange={(e) => { const q = String(e.target.value).replace(/\D/g, "").slice(0, 4); this.setState({ pin: q, pinErr: "" }); if (q.length === 4) void this.tryPin(q); }} inputMode="numeric" autoComplete="current-password" maxLength={4} autoFocus placeholder="••••" aria-label={T.enterPin} style={pinBox(!!st.pinErr, "18px")} />
            <div style={{ minHeight: "22px", marginTop: "10px", fontSize: "15px", fontWeight: 600, color: "#B3261E" }}>{st.pinErr}</div>
            <button onClick={() => void this.sendCode(true)} style={{ alignSelf: "flex-start", height: "40px", padding: 0, border: "none", background: "transparent", color: "#5223E0", fontSize: "15px", fontWeight: 600, cursor: "pointer" }}>{T.forgotPin}</button>
            <button onClick={() => void this.tryPin(st.pin)} style={{ ...btn(st.pin.length === 4 && !st.busy ? "p" : "off", 58), marginTop: "16px" }}>{T.signIn}</button>
            <div style={{ flex: 1 }} />
          </div>
        )}

        {step === "newpin" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "28px 24px 20px 24px", minHeight: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={avStyle(st.me ? st.me.key.length : 0, 52)}>{st.me?.ini}</span>
              <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: "block", fontSize: "18px", fontWeight: 700 }}>{st.me?.n}</span></span>
            </div>
            <div style={{ fontSize: "26px", lineHeight: "32px", fontWeight: 700, marginTop: "32px" }}>{st.newPin1 ? "Type the same PIN again" : "Choose a new PIN"}</div>
            <div style={{ fontSize: "16px", lineHeight: "23px", color: "#6B7385", marginTop: "6px" }}>4 numbers. You will type it every time you sign in.</div>
            <input key={st.newPin1 ? "again" : "first"} type="password" value={st.newPin} onChange={(e) => { const q = String(e.target.value).replace(/\D/g, "").slice(0, 4); this.setState({ newPin: q, pinErr: "" }); if (q.length === 4) void this.tryNewPin(q); }} inputMode="numeric" autoComplete="new-password" maxLength={4} autoFocus placeholder="••••" aria-label="New PIN" style={pinBox(!!st.pinErr, "18px")} />
            <div style={{ minHeight: "22px", marginTop: "10px", fontSize: "15px", fontWeight: 600, color: "#B3261E" }}>{st.pinErr}</div>
            <button onClick={() => void this.tryNewPin(st.newPin)} style={{ ...btn(st.newPin.length === 4 && !st.busy ? "p" : "off", 58), marginTop: "16px" }}>{T.cont}</button>
            <div style={{ flex: 1 }} />
          </div>
        )}
      </div>
    );
  }

  /* ---------------------------------------------------------------- the shell */

  renderBar(head: boolean): ReactNode {
    const st = this.state, T = this.T(), me = st.me!, db = this.db();
    const q = st.queue.filter((x) => x.status === "pending").length;
    const n = st.net;
    const c = q ? ["#FDF6E7", "#8A5C05", "#B77B08"] : n === "offline" ? ["#F7F8FA", "#3D4453", "#6B7385"] : n === "weak" ? ["#FDF6E7", "#8A5C05", "#B77B08"] : ["#E9F5EE", "#1D7A45", "#1D7A45"];
    const areaWord = (T as Record<string, string>)[me.area] ?? "";
    /* Several departments: the pill under the name says which one the screens
       are showing, and opens the switch. */
    const multi = myDepts(me).length > 1;
    return (
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: "10px", padding: "8px 16px 10px 16px", background: "#FFFFFF", borderBottom: "1px solid #EDEFF3" }}>
        <button onClick={() => this.setState({ sheet: null, route: "settings" })} aria-label={T.settings} style={this.av(me.key, 44)}>{me.ini}</button>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: "17px", fontWeight: 700, lineHeight: "22px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{me.n + (multi || (head && !me.scope) ? "" : !areaWord ? "" : " · " + areaWord)}</span>
          {multi ? this.deptPill() : <span style={{ display: "block", fontSize: "13px", color: "#6B7385", lineHeight: "17px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{db.loc + " · " + db.shift}</span>}
        </span>
        <button onClick={() => void this.refreshAll()} aria-label="Refresh" style={{ width: "36px", height: "36px", borderRadius: "18px", border: "none", background: "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flex: "none" }}>
          <span style={{ display: "flex", animation: st.refreshing ? "fx-spin 1.2s linear infinite" : "none" }}>{ic("sync", 20, "#5223E0")}</span>
        </button>
        <button onClick={() => this.setState({ route: "sync" })} style={{ height: "36px", padding: "0 12px", borderRadius: "18px", border: "none", background: c[0], color: c[1], fontSize: "13px", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", whiteSpace: "nowrap", flex: "none" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: c[2], animation: q ? "fx-pulse 1.4s ease-in-out infinite" : "none" }} />
          {q ? q + " · " + T.pending : (T as Record<string, string>)[n]}
        </button>
      </div>
    );
  }

  renderNav(head: boolean): ReactNode {
    const st = this.state, T = this.T();
    const revN = st.db?.review.length ?? 0;
    const navW: [string, string, string][] = [["home", "home", T.home], ["more", "list", T.more], ["scan", "qr", T.scan], ["sync", "sync", T.sync], ["settings", "badge", T.settings]];
    const navH: [string, string, string][] = [["today", "list", T.today], ["review", "alert", T.review], ["scan", "qr", T.scan], ["teams", "people", T.teams], ["more", "chart", T.more]];
    const pendN = st.queue.filter((q) => q.status === "pending").length;
    /* A page reached from More or Settings keeps its tab lit. */
    const tabOf: Record<string, string> = { help: "settings", stock: "more", qc: "more", req: "more", drum: "more", machines: head ? "more" : "machines", sync: head ? "more" : "sync" };
    return (
      <div style={{ flex: "none", height: "78px", background: "#FFFFFF", borderTop: "1px solid #EDEFF3", display: "flex", alignItems: "center", justifyContent: "space-around", padding: "0 6px 8px 6px" }}>
        {(head ? navH : navW).map(([k, icn, l]) => {
          const on = (tabOf[st.route] ?? st.route) === k;
          const isScan = k === "scan";
          return (
            <button key={k} onClick={() => (isScan ? this.openScan("home") : this.setState({ route: k }))} style={{ flex: 1, height: "70px", border: "none", background: "transparent", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "4px", color: on ? "#5223E0" : "#6B7385", cursor: "pointer" }}>
              <span style={isScan ? { width: "58px", height: "58px", marginTop: "-22px", borderRadius: "50%", background: "#6835FB", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 16px rgba(104,53,251,0.35)", position: "relative" } : { width: "48px", height: "30px", borderRadius: "15px", background: on ? "#F1ECFF" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                {ic(icn, isScan ? 28 : 24, isScan ? "#FFFFFF" : undefined)}
                {k === "sync" && pendN > 0 && <span style={{ position: "absolute", top: "-4px", right: "-8px", minWidth: "18px", height: "18px", padding: "0 5px", borderRadius: "9px", background: "#B77B08", color: "#FFFFFF", fontSize: "11px", fontWeight: 700, lineHeight: "18px", textAlign: "center" }}>{pendN}</span>}
                {k === "review" && revN > 0 && <span style={{ position: "absolute", top: "-4px", right: "-8px", minWidth: "18px", height: "18px", padding: "0 5px", borderRadius: "9px", background: "#B3261E", color: "#FFFFFF", fontSize: "11px", fontWeight: 700, lineHeight: "18px", textAlign: "center" }}>{revN}</span>}
              </span>
              <span style={{ fontSize: "12px", fontWeight: 600 }}>{l}</span>
            </button>
          );
        })}
      </div>
    );
  }

  /* ---------------------------------------------------------------- home */

  renderHome(): ReactNode {
    const st = this.state, T = this.T(), me = st.me!, db = this.db();
    const now = this.now();
    /* Every department of theirs, or the one picked at the top. */
    const d = this.dept();
    const mine = this.tasks().filter((t) => inDept(me, d, t.proc));
    const open = mine.filter((t) => t.status !== "done");
    const done = mine.filter((t) => t.status === "done");
    const q = st.queue.filter((x) => x.status === "pending").length;
    return (
      <div className="fx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 16px 24px 16px", display: "flex", flexDirection: "column", gap: "14px" }}>
        {q > 0 && (
          <button onClick={() => this.setState({ route: "sync" })} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 14px", border: "1px solid #F9E9C4", background: "#FDF6E7", borderRadius: "14px", color: "#8A5C05", fontSize: "15px", fontWeight: 600, textAlign: "left", cursor: "pointer" }}>
            {ic("clock", 22, "#8A5C05")}<span style={{ flex: 1 }}>{q + " " + T.waitingSend}</span>{ic("chev", 24)}
          </button>
        )}
        <button onClick={() => this.openScan("home")} style={{ background: "#6835FB", border: "none", borderRadius: "20px", padding: "18px 20px", color: "#FFFFFF", display: "flex", alignItems: "center", gap: "16px", textAlign: "left", cursor: "pointer", minHeight: "112px", boxShadow: "0 8px 20px rgba(104,53,251,0.28)" }}>
          <span style={{ width: "76px", height: "76px", flex: "none", borderRadius: "18px", background: "rgba(255,255,255,0.14)", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic("qr", 44, "#FFFFFF")}</span>
          <span>
            <span style={{ display: "block", fontSize: "26px", lineHeight: "30px", fontWeight: 700 }}>{T.scanQR}</span>
            <span style={{ display: "block", fontSize: "15px", color: "#DDD2FF", marginTop: "4px" }}>{T.scanAny}</span>
          </span>
        </button>
        {startsOwnBatch(me) && (
          <button onClick={() => this.setState({ sheet: { type: "start" }, asg: this.defaultAsg("mixing") })} style={{ background: "#FFFFFF", border: "2px solid #6835FB", borderRadius: "20px", padding: "14px 18px", color: "#3D14A8", display: "flex", alignItems: "center", gap: "14px", textAlign: "left", cursor: "pointer", minHeight: "76px" }}>
            <span style={{ width: "48px", height: "48px", flex: "none", borderRadius: "14px", background: "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic("flask", 28, "#6835FB")}</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontSize: "19px", lineHeight: "24px", fontWeight: 700 }}>Start a mixing batch</span>
              <span style={{ display: "block", fontSize: "14px", color: "#6B7385", marginTop: "2px" }}>Pick the base. The recipe opens with it.</span>
            </span>
            {ic("chev", 24)}
          </button>
        )}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: "4px" }}>
          <span style={{ fontSize: "20px", fontWeight: 700 }}>{T.myTasks}</span>
          <span style={{ fontSize: "14px", color: "#6B7385" }}>{open.length + " / " + mine.length}</span>
        </div>
        {this.deptChips()}
        {!open.length && <div style={{ background: "#FFFFFF", border: "1px solid #DDE1E8", borderRadius: "16px", padding: "28px 20px", textAlign: "center", fontSize: "16px", color: "#6B7385" }}>You have no work right now. New work will show here.</div>}
        {open.map((t) => {
          const over = t.due < now && t.status === "ready";
          const blocked = t.status === "blocked";
          const held = t.status === "held";
          const pend = t.status === "pending" || held;
          const started = !!st.started[t.id];
          return (
            <div key={t.id} style={{ background: "#FFFFFF", border: "1px solid " + (over ? "#F6CFCF" : "#DDE1E8"), borderRadius: "20px", padding: "14px", boxShadow: over ? "inset 4px 0 0 #B3261E" : "none" }}>
              <div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
                <span style={artWell(76, 16)}>{this.taskArt(t, 64)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", height: "24px", padding: "0 9px", borderRadius: "12px", background: "#F1ECFF", color: "#3D14A8", fontSize: "12px", fontWeight: 700 }}>{ic(PC[t.proc], 15)}{(T as Record<string, string>)[t.proc] + " · " + t.id}</span>
                  <span style={{ display: "block", fontSize: "18px", lineHeight: "23px", fontWeight: 700, marginTop: "6px" }}>{taskName(db, t)}</span>
                  <span style={{ display: "block", fontSize: "15px", color: "#3D4453", marginTop: "2px" }}>{taskTarget(db, t)}</span>
                  <span style={{ display: "block", fontSize: "14px", fontWeight: over ? 700 : 500, color: over ? "#B3261E" : "#6B7385", marginTop: "2px" }}>{(over ? "Late · due at " : "Do by ") + t.due}</span>
                </span>
              </div>
              {(blocked || pend) && <div style={{ marginTop: "12px", padding: "10px 12px", borderRadius: "12px", fontSize: "14px", lineHeight: "20px", background: blocked ? "#F7F8FA" : "#FDF6E7", color: blocked ? "#3D4453" : "#8A5C05" }}>{blocked ? db.orders[t.order!]?.blocked : held ? "With your supervisor. You do not need to do it again." : "Saved on this phone. It will send when the network comes back."}</div>}
              <button onClick={() => !blocked && !pend && this.startTask(t.id)} style={{ ...btn(blocked || pend ? "off" : "p", 56), marginTop: "12px" }}>{blocked ? "Waiting" : held ? "With supervisor" : pend ? T.pending : started ? T.cont : T.start}</button>
            </div>
          );
        })}
        {done.length > 0 && (
          <>
            <div style={{ fontSize: "15px", fontWeight: 600, color: "#6B7385", marginTop: "6px" }}>{T.done} · {done.length}</div>
            <div style={{ background: "#FFFFFF", border: "1px solid #DDE1E8", borderRadius: "16px", overflow: "hidden" }}>
              {done.map((t) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 14px", borderTop: "1px solid #F3F4F7" }}>
                  <span style={{ width: "32px", height: "32px", borderRadius: "50%", background: "#E9F5EE", color: "#1D7A45", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic("check", 18, "#1D7A45")}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: "15px", fontWeight: 600 }}>{taskName(db, t)}</span>
                    <span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{t.id + " · " + nf(t.out?.good) + " " + (t.out?.unit ?? "") + (t.out?.rej ? " good · " + t.out.rej + " rejected" : "") + " · " + (t.out?.at ?? "")}</span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  /* ---------------------------------------------------------------- scan */

  /** The camera's answer. No camera, or none allowed, opens straight in Type mode — once; "Scan instead" is not bounced back. */
  camState(s: "live" | "none" | "denied") {
    this.setState((st) => {
      const sc = st.scan;
      const toType = !!sc && (s === "none" || s === "denied") && sc.typed == null && !sc.camAsked;
      return { cam: s, scan: toType ? { ...sc!, typed: "" } : sc };
    });
  }

  /** Back to the camera from Type mode. The typed text is dropped; the camera is not offered Type mode again on its own. A browser asks for the camera again when it mounts. */
  scanInstead() {
    const sc = this.state.scan;
    if (!sc) return;
    this.setState({ scan: { ...sc, typed: null, camAsked: true } });
  }

  /** Type mode: the camera is off, the box takes the whole screen and the keyboard opens on it. */
  renderTyping(labels: { code: string; what: string; good: boolean }[]): ReactNode {
    const st = this.state, T = this.T(), sc = st.scan!, P = sc.purpose, m = sc.meta, db = st.db;
    const rmName = m.item && db?.rm[m.item] ? db.rm[m.item].n : "";
    const what = { badge: "your company badge", home: "a task sheet, order, lot or box label", rm: "the " + rmName + " drum", sfg: "the base-liquid tank", pm: "the empty-can stack", fg: "the filled-can pallet", load: "the box label going on the lorry", drum: "the GRN label on the empty drum", lr: "the LR receipt" }[P];
    const typed = sc.typed ?? "", ready = !!typed.trim();
    const noCam = st.cam === "none" || st.cam === "denied";
    const lr = P === "lr";
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "10px", padding: "14px 16px 18px 16px" }}>
        {noCam && <div style={{ padding: "10px 12px", borderRadius: "12px", background: "rgba(255,231,168,0.12)", color: "#FFE7A8", fontSize: "14px", lineHeight: "20px" }}>{st.cam === "denied" ? T.camOffType : T.noCamType}</div>}
        <div style={{ fontSize: "22px", lineHeight: "28px", fontWeight: 700 }}>{lr ? T.typeLr : T.typeTitle}</div>
        {!!what && <div style={{ fontSize: "15px", color: "#C2C8D2" }}>{T.lookingFor + ": " + what}</div>}
        <input value={typed} onChange={(e) => this.setState({ scan: { ...sc, typed: String(e.target.value).toUpperCase().slice(0, 60) } })} onKeyDown={(e) => e.key === "Enter" && this.submitTyped()} autoFocus autoComplete="off" aria-label={lr ? T.typeLr : T.typeCode} style={{ width: "100%", height: "64px", minHeight: "64px", boxSizing: "border-box", marginTop: "6px", borderRadius: "16px", border: "2px solid #C6FF34", background: "rgba(255,255,255,0.06)", color: "#FFFFFF", padding: "0 16px", ...mono, fontSize: "24px", fontWeight: 600, letterSpacing: "1px", outline: "none" }} />
        <div style={{ fontSize: "13px", lineHeight: "18px", color: "#9BA3B2" }}>{lr ? T.typeLrEg : T.typeEg}</div>
        <button onClick={() => this.submitTyped()} style={{ width: "100%", height: "56px", marginTop: "6px", border: "none", borderRadius: "14px", background: ready ? "#C6FF34" : "rgba(255,255,255,0.12)", color: ready ? "#0E1016" : "#9BA3B2", fontSize: "17px", fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", cursor: ready ? "pointer" : "default" }}>{ic("enterKey", 20, ready ? "#0E1016" : "#9BA3B2")}{lr ? T.checkLr : T.checkCode}</button>
        <button onClick={() => this.scanInstead()} style={{ width: "100%", height: "54px", border: "1.5px solid rgba(255,255,255,0.28)", background: "transparent", borderRadius: "14px", color: "#FFFFFF", fontSize: "16px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", cursor: "pointer" }}>{ic(st.cam === "denied" ? "camOn" : "scanFrame", 22, "#FFFFFF")}{st.cam === "denied" ? T.camOn : T.scanInstead}</button>
        {labels.length > 0 && (
          <>
            <div style={{ fontSize: "12px", fontWeight: 600, color: "#9BA3B2", marginTop: "6px" }}>{T.testLabels}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {labels.map((b) => (
                <button key={b.code} onClick={() => void this.doScan(b.code)} style={{ padding: "8px 12px", borderRadius: "12px", border: "1px solid " + (b.good ? "rgba(198,255,52,0.45)" : "rgba(255,255,255,0.2)"), background: "rgba(255,255,255,0.06)", color: "#FFFFFF", textAlign: "left", cursor: "pointer" }}>
                  <span style={{ display: "block", ...mono, fontSize: "13px", fontWeight: 600 }}>{b.code}</span>
                  <span style={{ display: "block", fontSize: "11px", opacity: 0.75, marginTop: "1px" }}>{b.what}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  renderScan(): ReactNode {
    const st = this.state, T = this.T(), sc = st.scan!, f = st.flow, m = sc.meta, P = sc.purpose, r = sc.res;
    const typing = sc.typed != null;
    const db = st.db;
    const rmName = m.item && db?.rm[m.item] ? db.rm[m.item].n : "";
    const title = { badge: T.scanBadge, home: T.scanQR, rm: rmName, sfg: "Base liquid", pm: "Empty cans", fg: "Filled cans", load: f ? (f.task.order ?? "") : "", drum: "Empty drum", lr: "LR number" }[P] || T.scanQR;
    const hint = { badge: "Show your company badge", home: "Scan a task sheet, order or lot label", rm: "Scan the " + rmName + " drum", sfg: "Scan the base-liquid tank", pm: "Scan the empty-can stack", fg: "Scan the filled-can pallet", load: "Scan each pallet before loading", drum: "Scan the GRN label on the empty drum", lr: "Scan the barcode printed on the LR" }[P];
    const hasManual = ["rm", "sfg", "pm", "fg", "load"].indexOf(P) > -1;
    const noCam = st.cam === "none" || st.cam === "denied";
    const labels = noCam && (this.props.dev || st.cam === "none") ? this.scanLabels() : [];
    const corner = (pos: CSSProperties, b: string, rad: string): ReactNode => <span style={{ position: "absolute", width: "44px", height: "44px", ...pos, [b.split("|")[0]]: "5px solid #C6FF34", [b.split("|")[1]]: "5px solid #C6FF34", borderRadius: rad } as CSSProperties} />;
    return (
      <div style={{ flex: 1, minHeight: 0, background: "#0E1016", color: "#FFFFFF", display: "flex", flexDirection: "column", position: "relative" }}>
        {!r && !typing && <CameraScanner torch={sc.torch} paused={!!r || !!st.sheet} onCode={(c) => void this.doScan(c)} onState={(s) => this.camState(s)} />}
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", position: "relative" }}>
          <button onClick={() => this.setState({ scan: null })} aria-label="Close" style={{ width: "48px", height: "48px", borderRadius: "50%", border: "none", background: "rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>{ic("x", 24, "#FFFFFF")}</button>
          <span style={{ flex: 1, fontSize: "17px", fontWeight: 700, textAlign: "center" }}>{title}</span>
          {typing ? <span style={{ width: "48px", height: "48px", flex: "none" }} /> : <button onClick={() => this.setState({ scan: { ...sc, torch: !sc.torch } })} aria-label="Torch" style={{ width: "48px", height: "48px", borderRadius: "50%", border: "none", background: sc.torch ? "#C6FF34" : "rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>{ic("torch", 23, "#FFFFFF")}</button>}
        </div>
        {typing ? this.renderTyping(labels) : (
          <>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 24px", position: "relative" }}>
          <div style={{ position: "relative", width: "240px", height: "240px", borderRadius: "24px", background: sc.torch ? "rgba(198,255,52,0.10)" : "rgba(255,255,255,0.03)" }}>
            {corner({ left: 0, top: 0 }, "borderLeft|borderTop", "20px 0 0 0")}
            {corner({ right: 0, top: 0 }, "borderRight|borderTop", "0 20px 0 0")}
            {corner({ left: 0, bottom: 0 }, "borderLeft|borderBottom", "0 0 0 20px")}
            {corner({ right: 0, bottom: 0 }, "borderRight|borderBottom", "0 0 20px 0")}
            <span style={{ position: "absolute", left: "14px", right: "14px", height: "3px", borderRadius: "2px", background: "#C6FF34", boxShadow: "0 0 14px #C6FF34", animation: "fx-scan 2.4s ease-in-out infinite" }} />
          </div>
          <div style={{ fontSize: "20px", lineHeight: "26px", fontWeight: 700, marginTop: "22px", textAlign: "center" }}>{hint}</div>
          <div style={{ fontSize: "15px", color: "#C2C8D2", marginTop: "4px", textAlign: "center" }}>{st.cam === "denied" ? "The camera is off. Allow the camera for this app, or type the code." : T.scanHint}</div>
        </div>
          <div style={{ flex: "none", background: "#1A1E28", borderRadius: "22px 22px 0 0", padding: "14px 16px 18px 16px", position: "relative" }}>
            {labels.length > 0 && (
              <>
                <div style={{ fontSize: "12px", fontWeight: 600, color: "#9BA3B2" }}>{T.testLabels}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px", maxHeight: "150px", overflowY: "auto" }}>
                  {labels.map((b) => (
                    <button key={b.code} onClick={() => void this.doScan(b.code)} style={{ padding: "8px 12px", borderRadius: "12px", border: "1px solid " + (b.good ? "rgba(198,255,52,0.45)" : "rgba(255,255,255,0.2)"), background: "rgba(255,255,255,0.06)", color: "#FFFFFF", textAlign: "left", cursor: "pointer" }}>
                      <span style={{ display: "block", ...mono, fontSize: "13px", fontWeight: 600 }}>{b.code}</span>
                      <span style={{ display: "block", fontSize: "11px", opacity: 0.75, marginTop: "1px" }}>{b.what}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <button onClick={() => this.setState({ scan: { ...sc, typed: "" } })} style={{ width: "100%", height: "54px", marginTop: labels.length ? "12px" : 0, border: "1.5px solid rgba(255,255,255,0.28)", background: "transparent", borderRadius: "14px", color: "#FFFFFF", fontSize: "16px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", cursor: "pointer" }}>{ic("typeField", 23, "#FFFFFF")}{P === "lr" ? T.typeLr : T.typeCode}</button>
            {hasManual && <button onClick={() => this.manualPick()} style={{ width: "100%", height: "54px", marginTop: "10px", border: "1.5px solid rgba(255,255,255,0.28)", background: "transparent", borderRadius: "14px", color: "#FFFFFF", fontSize: "16px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", cursor: "pointer" }}>{ic("picture", 22, "#FFFFFF")}{T.noLabel}</button>}
          </div>
          </>
        )}
        {r && (
          <div style={{ position: "absolute", inset: 0, background: "rgba(14,16,22,0.55)", display: "flex", alignItems: "flex-end", zIndex: 5 }}>
            <div style={{ width: "100%", background: "#FFFFFF", color: "#1A1E28", borderRadius: "26px 26px 0 0", padding: "18px 18px 20px 18px", animation: "fx-up 200ms cubic-bezier(0.2,0,0.2,1)" }}>
              {r.ok ? this.renderScanOk(r as Extract<ScanResult, { ok: true }> & { manual?: boolean }) : (
                <div>
                  <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                    <span style={{ width: "52px", height: "52px", flex: "none", borderRadius: "50%", background: "#FCECEC", color: "#B3261E", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic("alertRound", 30, "#B3261E")}</span>
                    <span style={{ flex: 1 }}>
                      <span style={{ display: "block", fontSize: "20px", lineHeight: "25px", fontWeight: 700, color: "#B3261E" }}>{r.title}</span>
                      <span style={{ display: "block", ...mono, fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>{r.code}</span>
                    </span>
                  </div>
                  <div style={{ fontSize: "16px", lineHeight: "23px", color: "#1A1E28", marginTop: "12px" }}>{r.text}</div>
                  <div style={{ marginTop: "12px", padding: "12px 14px", borderRadius: "12px", background: "#F7F8FA", fontSize: "15px", lineHeight: "22px", color: "#1A1E28" }}><span style={{ fontWeight: 700 }}>What to do: </span>{r.fix}</div>
                  <div style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
                    <button onClick={() => this.speak(r.title + ". " + r.fix)} aria-label={T.listen} style={{ ...btn("s", 58), width: "64px", flex: "none" }}>{ic("speaker", 20)}</button>
                    <button onClick={() => this.setState({ scan: { ...sc, res: null } })} style={{ ...btn("p", 58), flex: 2 }}>{typing ? T.retry : T.scanAgain}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  renderScanOk(r: Extract<ScanResult, { ok: true }> & { manual?: boolean }): ReactNode {
    const st = this.state, T = this.T(), sc = st.scan!, P = sc.purpose;
    let artEl: ReactNode = null, name = "", code = r.code, facts: { l: string; v: string }[] = [], acceptL = T.yes;
    if (r.kind === "emp") {
      const who = st.pinFor;
      artEl = <span style={avStyle(who ? who.key.length : 0, 80)}>{who?.ini}</span>;
      name = who?.n ?? "";
      facts = [{ l: "Employee ID", v: r.code }, { l: "Work", v: "Factory" }];
      acceptL = "Yes, this is me";
    } else if (r.kind === "task") {
      const t = this.task(r.task)!;
      artEl = this.taskArt(t, 80);
      name = taskName(this.db(), t);
      code = t.id;
      facts = [{ l: "Work", v: (T as Record<string, string>)[t.proc] }, { l: "Target", v: taskTarget(this.db(), t).split(" · ")[0] }];
      acceptL = T.start;
    } else {
      const x = this.db().lots[r.lot];
      artEl = this.lotArt(x, 80);
      name = lotName(this.db(), x);
      facts = [{ l: "Available", v: nf(x.avail) + " " + lotUnit(this.db(), x) }, { l: "Where", v: x.loc.replace(" Plant", "") }];
      acceptL = P === "home" ? T.ok : T.yes;
    }
    return (
      <div>
        <div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
          <span style={artWell(96, 18)}>{artEl}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", height: "24px", padding: "0 10px", borderRadius: "12px", background: "#E9F5EE", color: "#1D7A45", fontSize: "13px", fontWeight: 700 }}>{ic("check", 14, "#1D7A45")}{T.found}</span>
            <span style={{ display: "block", fontSize: "20px", lineHeight: "25px", fontWeight: 700, marginTop: "6px" }}>{name}</span>
            <span style={{ display: "block", ...mono, fontSize: "14px", fontWeight: 600, color: "#3D4453", marginTop: "2px" }}>{code}</span>
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "14px" }}>
          {facts.map((f) => (
            <div key={f.l} style={{ background: "#F7F8FA", borderRadius: "12px", padding: "10px 12px" }}>
              <div style={{ fontSize: "12px", color: "#6B7385" }}>{f.l}</div>
              <div style={{ fontSize: "18px", fontWeight: 700, marginTop: "2px" }}>{f.v}</div>
            </div>
          ))}
        </div>
        {r.manual && <div style={{ marginTop: "12px", padding: "10px 12px", borderRadius: "12px", background: "#FDF6E7", color: "#8A5C05", fontSize: "14px", lineHeight: "20px", fontWeight: 600 }}>{T.manualWarn}</div>}
        <div style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
          <button onClick={() => this.setState({ scan: { ...sc, res: null } })} style={{ ...btn("s", 58), flex: 1 }}>{T.wrong}</button>
          <button onClick={() => this.acceptScan()} style={{ ...btn("p", 58), flex: 2 }}>{acceptL}</button>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- the job */

  renderFlow(): ReactNode {
    const st = this.state, T = this.T(), f = st.flow!, t = f.task, d = f.d, db = this.db();
    const steps = STEPS[t.proc];
    const key = steps[f.step];
    const li = this.li();
    const block = stepCheck(db, t, d, key);
    const back = () => {
      if (f.step === 0) {
        this.setState({ flow: null, drafts: { ...st.drafts, [t.id]: f } });
        this.toast("Saved on this phone. Tap Continue to come back.");
      } else this.setState({ flow: { ...f, step: f.step - 1 } });
    };
    const next = () => {
      if (block) return this.toast(block, "warn");
      if (key === "review") return void this.submit();
      const flow = { ...f, step: f.step + 1 };
      this.setState({ flow, drafts: { ...st.drafts, [t.id]: flow } });
    };
    const say: Record<string, string> = {
      identify: taskName(db, t) + ". " + taskTarget(db, t),
      team: STEP_T.team[li],
      materials: STEP_T.materials[li] + ". " + (d.rm ?? []).map((r) => db.rm[r.item]?.n + " " + nf(r.per * (d.batches ?? 1)) + " L").join(", "),
    };
    const listen = () => this.speak(key === "review" ? this.readBack(f) : say[key] || STEP_T[key][li]);
    const nextL = key === "review" ? T.submit : key === "identify" ? T.yes : T.next;
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "#F7F8FA" }}>
        <div style={{ flex: "none", background: "#FFFFFF", borderBottom: "1px solid #EDEFF3", padding: "6px 12px 12px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button onClick={back} aria-label={T.back} style={{ width: "48px", height: "48px", borderRadius: "50%", border: "none", background: "#F7F8FA", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flex: "none" }}>{ic("back", 24)}</button>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{(T as Record<string, string>)[t.proc] + " · " + t.id}</span>
              <span style={{ display: "block", fontSize: "16px", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{taskName(db, t)}</span>
            </span>
            <button onClick={listen} style={{ height: "44px", padding: "0 14px", borderRadius: "22px", border: "1px solid #DDD2FF", background: "#F1ECFF", color: "#5223E0", fontSize: "15px", fontWeight: 700, display: "flex", gap: "6px", alignItems: "center", cursor: "pointer", flex: "none" }}>{ic("speaker", 20)}{T.listen}</button>
          </div>
          <div style={{ display: "flex", gap: "5px", marginTop: "12px" }}>
            {steps.map((k, i) => <span key={k} style={{ flex: 1, height: "6px", borderRadius: "3px", background: i < f.step ? "#1A1E28" : i === f.step ? "#6835FB" : "#DDE1E8" }} />)}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px", marginTop: "10px" }}>
            <span style={{ fontSize: "23px", lineHeight: "28px", fontWeight: 700 }}>{STEP_T[key][li]}</span>
            <span style={{ fontSize: "13px", color: "#6B7385", whiteSpace: "nowrap" }}>{f.step + 1 + " / " + steps.length}</span>
          </div>
        </div>
        <div className="fx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 20px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          {key === "identify" && this.stepIdentify(t, d)}
          {key === "team" && this.stepTeam(t, d)}
          {key === "review" && this.stepReview(f)}
          {key !== "identify" && key !== "team" && key !== "review" && this.stepForm(key, t, d)}
        </div>
        <div style={{ flex: "none", background: "#FFFFFF", borderTop: "1px solid #EDEFF3", padding: "10px 16px 16px 16px" }}>
          {block && <div style={{ fontSize: "14px", lineHeight: "20px", color: "#8A5C05", fontWeight: 600, marginBottom: "8px", textAlign: "center" }}>{block}</div>}
          {key === "identify" ? (
            /* Both answers to "is this the right product?" sit together — the "no" was hidden in the scroll. */
            <div style={{ display: "flex", gap: "10px" }}>
              <button onClick={() => this.openReport(t)} style={{ ...btn("s", 62), flex: 1 }}>{T.wrong}</button>
              <button onClick={next} style={{ ...btn(block ? "off" : "p", 62), flex: 2 }}>{nextL}</button>
            </div>
          ) : (
            <button onClick={next} style={btn(block ? "off" : "p", 62)}>{key === "review" && st.sending ? T.sending : nextL}</button>
          )}
        </div>
      </div>
    );
  }

  stepIdentify(t: Task, d?: Draft): ReactNode {
    const T = this.T(), db = this.db();
    let chips: string[] = [], rows: { l: string; v: string; c: string }[] = [], rowsTitle = "";
    let own = false, mixLines: { item: string; per: number }[] = [];
    const recipeBtn: CSSProperties = { flex: 1, height: "46px", borderRadius: "12px", border: "1.5px solid #D9CCFF", background: "#FFFFFF", color: "#3D14A8", fontSize: "15px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", cursor: "pointer" };
    if (t.proc === "mixing") {
      const sf = db.sfg[t.item!];
      const nb = d?.batches ?? t.batches ?? 1;
      own = !!d?.ownRecipe;
      mixLines = recipeLines(db, t, d);
      chips = [nb + " × " + nf(own ? batchLitres(mixLines) : sf.batch) + " L", "Due " + t.due];
      rowsTitle = (own ? "Your recipe" : "Batch sheet") + " · for " + nb + " batch" + (nb > 1 ? "es" : "");
      rows = mixLines.map((r) => ({ l: db.rm[r.item]?.n ?? r.item, v: nf(r.per * nb) + " L", c: db.rm[r.item]?.col ?? "#3D4453" }));
    }
    if (t.proc === "filling") {
      const k = db.sku[t.item!];
      chips = [nf(t.target) + " " + (k.kind === "drum" ? "drums" : "cans"), k.size, "Due " + t.due];
      rowsTitle = "What you need";
      rows = [{ l: "Base liquid", v: nf((t.target ?? 0) * k.l) + " L", c: db.sfg[k.sfg]?.col ?? "#2B5CBF" }, { l: db.pm[k.pm] ?? "Empty cans", v: nf(t.target), c: "#9BA3B2" }];
    }
    if (t.proc === "packing") {
      const b = db.box[t.item!], k = db.sku[b.sku];
      chips = [nf(t.target) + " boxes", b.cpb + " × " + k.size, "Due " + t.due];
      rowsTitle = "What you need";
      rows = [{ l: "Filled cans", v: nf((t.target ?? 0) * b.cpb), c: k.col }, { l: "Box type", v: b.type, c: "#A88A55" }, { l: "One batch is", v: b.batch + " boxes", c: "#6835FB" }];
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ ...card, padding: "20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <span style={artWell(168, 26)}>{this.taskArt(t, 140)}</span>
          <div style={{ fontSize: "23px", lineHeight: "28px", fontWeight: 700, marginTop: "14px" }}>{taskName(db, t)}</div>
          <div style={{ ...mono, fontSize: "14px", color: "#6B7385", marginTop: "4px" }}>{t.id + " · " + (db.sfg[t.item!]?.short ?? db.sku[t.item!]?.tag ?? (db.box[t.item!] ? db.box[t.item!].cpb + "×" + db.sku[db.box[t.item!].sku]?.tag : ""))}</div>
          <div style={{ display: "flex", gap: "8px", marginTop: "14px", flexWrap: "wrap", justifyContent: "center" }}>
            {chips.map((c) => <span key={c} style={{ background: "#F1ECFF", color: "#3D14A8", borderRadius: "16px", padding: "6px 14px", fontSize: "15px", fontWeight: 700 }}>{c}</span>)}
            {own && <span style={{ background: "#FDF6E7", color: "#8A5C05", borderRadius: "16px", padding: "6px 14px", fontSize: "15px", fontWeight: 700 }}>Own recipe</span>}
          </div>
        </div>
        {rows.length > 0 && (
          <div style={{ ...card, padding: "4px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", padding: "10px 0 4px 0" }}>
              <span style={{ fontSize: "13px", fontWeight: 600, color: "#6B7385" }}>{rowsTitle}</span>
              {own && <span style={{ fontSize: "12px", fontWeight: 700, color: "#8A5C05", background: "#FDF6E7", borderRadius: "8px", padding: "2px 8px" }}>changed</span>}
            </div>
            {rows.map((r) => (
              <div key={r.l} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 0", borderTop: "1px solid #F3F4F7" }}>
                <span style={{ width: "12px", height: "12px", borderRadius: "3px", flex: "none", background: r.c }} />
                <span style={{ flex: 1, fontSize: "16px" }}>{r.l}</span>
                <span style={{ fontSize: "17px", fontWeight: 700 }}>{r.v}</span>
              </div>
            ))}
            {t.proc === "mixing" && d && (
              <div style={{ display: "flex", gap: "8px", padding: "4px 0 14px 0" }}>
                <button onClick={() => this.openRecipe(mixLines)} style={recipeBtn}>{ic("pen", 18, "#3D14A8")}{own ? "Change" : "Use my own recipe"}</button>
                {own && <button onClick={() => this.useBatchSheet(t)} style={recipeBtn}>{ic("sync", 18, "#3D14A8")}Batch sheet</button>}
              </div>
            )}
          </div>
        )}
        <div style={{ fontSize: "19px", fontWeight: 700, textAlign: "center", marginTop: "4px" }}>{T.isRight}</div>
      </div>
    );
  }

  stepTeam(t: Task, d: Draft): ReactNode {
    const T = this.T(), me = this.state.me!;
    const pick = (role: PeopleSheet["role"], multi: boolean) =>
      this.setState({ sheet: { type: "people", role, multi, sel: multi ? (d.team.helpers || []).slice() : [d.team[role as "owner"]].filter(Boolean) as string[], area: t.proc } });
    const G: [PeopleSheet["role"], string, boolean, boolean][] = [["owner", "In charge", false, true], ["op", t.proc === "dispatch" ? "Lead loader" : "Machine operator", false, true], ["helpers", "Helpers", true, false], ["ver", "Checked by (optional)", false, false]];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {G.map(([k, l, multi, req]) => {
          const ids = k === "helpers" ? d.team.helpers : ([d.team[k as "owner"]].filter(Boolean) as string[]);
          return (
            <button key={k} onClick={() => pick(k, multi)} style={{ background: "#FFFFFF", border: "1px solid " + (req && !ids.length ? "#F6CFCF" : "#DDE1E8"), borderRadius: "18px", padding: "14px", textAlign: "left", cursor: "pointer", display: "block", width: "100%" }}>
              <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "14px", fontWeight: 700, color: "#3D4453" }}>{l}</span>
                <span style={{ fontSize: "15px", fontWeight: 700, color: "#5223E0" }}>{T.change}</span>
              </span>
              <span style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "10px" }}>
                {ids.map((p) => (
                  <span key={p} style={{ display: "flex", alignItems: "center", gap: "8px", background: "#F7F8FA", borderRadius: "28px", padding: "4px 14px 4px 4px" }}>
                    <span style={this.av(p, 36)}>{this.ini(p)}</span>
                    <span style={{ fontSize: "16px", fontWeight: 600 }}>{this.name(p)}</span>
                  </span>
                ))}
                {!ids.length && <span style={{ fontSize: "15px", fontWeight: 600, color: req ? "#B3261E" : "#6B7385", padding: "8px 0" }}>{req ? "Required — tap to choose" : k === "helpers" ? "No helpers — tap to add" : "Nobody — tap to add"}</span>}
              </span>
            </button>
          );
        })}
        <div style={{ fontSize: "13px", lineHeight: "19px", color: "#6B7385", padding: "0 4px" }}>{"Saved by " + me.n + ". The work counts once for the whole team."}</div>
      </div>
    );
  }

  stepReview(f: Flow): ReactNode {
    const rv = this.reviewVM(f);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ ...card, padding: "14px", display: "flex", gap: "14px", alignItems: "center" }}>
          <span style={artWell(84, 16)}>{rv.art}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: "19px", lineHeight: "24px", fontWeight: 700 }}>{rv.name}</span>
            <span style={{ display: "block", ...mono, fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>{rv.code}</span>
          </span>
        </div>
        <div style={{ ...card, padding: "2px 16px" }}>
          {rv.rows.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "baseline", gap: "10px", padding: "12px 0", borderTop: "1px solid #F3F4F7" }}>
              <span style={{ flex: 1, fontSize: "15px", color: "#3D4453" }}>{r.l}</span>
              <span style={{ fontSize: "18px", fontWeight: 700, textAlign: "right" }}>{r.v}</span>
            </div>
          ))}
        </div>
        <div style={{ ...card, padding: "2px 16px" }}>
          {rv.team.map((r) => (
            <div key={r.l} style={{ display: "flex", alignItems: "baseline", gap: "10px", padding: "11px 0", borderTop: "1px solid #F3F4F7" }}>
              <span style={{ flex: 1, fontSize: "14px", color: "#6B7385" }}>{r.l}</span>
              <span style={{ fontSize: "16px", fontWeight: 600, textAlign: "right" }}>{r.v}</span>
            </div>
          ))}
        </div>
        {rv.warns.map((m, i) => <MsgBox key={i} m={m} />)}
        <div style={{ fontSize: "12px", lineHeight: "17px", color: "#9BA3B2", textAlign: "center" }}>{rv.key}</div>
      </div>
    );
  }

  /* The form steps — materials, output, base liquid, can size, count, pallets, boxes, order, load, checks. */
  stepForm(key: string, t: Task, d: Draft): ReactNode {
    const T = this.T(), db = this.db();
    const info: { l: string; v: string; style?: CSSProperties }[] = [];
    const lines: { art: ReactNode; title: string; qty: string; lots: string }[] = [];
    const tiles: { title: string; cols: number; items: { l: string; sub?: string; art: ReactNode; pick: () => void; style: CSSProperties }[] }[] = [];
    const lots: LotRow[] = [];
    const fields: QField[] = [];
    const checks: { l: string; sub?: string; mark: ReactNode; flip: () => void; box: CSSProperties; style: CSSProperties }[] = [];
    const msgs: Msg[] = [];
    let sub = "", bar: { l: string; v: string; fill: CSSProperties } | null = null, down = false;
    const infoCard = (l: string, v: string, warn?: boolean) => ({ l, v, style: { background: warn ? "#FDF6E7" : "#FFFFFF", border: "1px solid #DDE1E8", borderRadius: "14px", padding: "10px 12px" } });

    if (key === "materials") {
      sub = "Scan each drum. Then type how much you poured. If a drum runs out, add another drum for the rest.";
      (d.rm ?? []).forEach((r, i) => {
        const x = r.lot ? db.lots[r.lot] : undefined;
        const p = rmPlan(d, i);
        const nm = db.rm[r.item]?.n ?? r.item;
        const err = x && (r.qty ?? 0) > x.avail ? "Only " + nf(x.avail) + " L left in this drum. Pour it all, then add another drum for the rest." : "";
        const short = p.last && p.poured < p.need ? p.need - p.poured : 0;
        const over = p.last && p.poured > p.need ? p.poured - p.need : 0;
        lots.push({
          art: art("rm", db.rm[r.item]?.col, db.rm[r.item]?.code, 52), name: nm + (r.extra ? " · next drum" : ""),
          need: r.extra ? "Still needed: " + nf(p.rest) + " L of " + nf(p.need) + " L" : (d.ownRecipe ? "Your recipe: " : "Sheet: ") + nf(p.need) + " L",
          lot: r.lot, manual: r.manual,
          scan: () => this.openScan("rm", { item: r.item, idx: i }), qtyL: T.used, qtyV: r.qty ? nf(r.qty) + " L" : "Tap to enter", qtyDone: !!r.qty, done: !!(x && r.qty && !err), err,
          qtyOpen: () => this.rmKp(i),
          note: x && !r.qty && x.avail < p.rest ? "This drum has only " + nf(x.avail) + " L. Pour it all — then add another drum for the other " + nf(p.rest - x.avail) + " L." : short && r.qty ? nf(p.poured) + " of " + nf(p.need) + " L poured — " + nf(Math.round(short * 1000) / 1000) + " L still needed." : over ? nf(Math.round(over * 1000) / 1000) + " L more than the sheet. Type less." : "",
          add: p.last && r.lot && p.poured < p.need ? () => this.setD((z) => { z.rm = addRmDrum(z.rm!, i); }) : undefined,
          remove: r.extra ? () => this.setD((z) => { z.rm = removeRmDrum(z.rm!, i); }) : undefined,
        });
      });
      down = true;
    }
    if (key === "output") {
      const sf = db.sfg[t.item!];
      const { exp, dev, over } = mixDeviation(db, t, d);
      const inp = (d.rm ?? []).reduce((a, r) => a + (r.qty || 0), 0);
      fields.push(
        { l: "Number of batches", v: d.batches ?? null, unit: (d.batches ?? 1) > 1 ? "batches" : "batch", open: () => this.openKp({ l: "Number of batches", unit: "", v: d.batches, max: MIX_BATCH_MAX, set: (v) => this.setD((z) => { z.batches = v; }) }), step: true, minus: () => this.setD((z) => { z.batches = Math.max(1, (z.batches ?? 1) - 1); }), plus: () => this.setD((z) => { z.batches = Math.min(MIX_BATCH_MAX, (z.batches ?? 1) + 1); }) },
        { l: "Litres made", v: d.out ?? null, unit: "L", open: () => this.openKp({ l: "How many litres of " + sf.short + " base were made?", unit: "L", v: d.out, max: Math.min(Math.round(exp * 1.2), Math.max(inp, 1)), maxL: inp && exp * 1.2 > inp ? "More than you poured (" + nf(inp) + " L). Check the tank again." : "Too much. Check the tank again.", quick: [{ l: nf(exp) + " L", v: exp }], set: (v) => this.setD((z) => { z.out = v; }) }), sub: "Read the tank gauge after mixing." },
      );
      info.push(infoCard("Expected", nf(exp) + " L"), infoCard("Materials poured", nf(inp) + " L"), infoCard("Difference", d.out ? (dev >= 0 ? "+" : "") + dev.toFixed(1) + "%" : "—", over), infoCard("Allowed", "±" + sf.tol + "%"));
      if (over) msgs.push(msg("This is more or less than normal. You can send it. Your supervisor will check it.", "warn"));
      else if (d.out) msgs.push(msg("This is normal.", "ok"));
      down = true;
    }
    if (key === "sfg") {
      const k = db.sku[d.sku!];
      sub = t.sfg ? "Scan the tank you fill from. It should be " + t.sfg + "." : "Scan the " + (db.sfg[k.sfg]?.short ?? "") + " base tank you fill from.";
      lots.push({ art: art("tank", db.sfg[k.sfg]?.col, db.sfg[k.sfg]?.short, 52), name: db.sfg[k.sfg]?.n ?? "", need: "Needed: about " + nf((t.target ?? 0) * k.l) + " L", lot: d.sfg ?? null, manual: d.sfgManual, scan: () => this.openScan("sfg"), done: !!d.sfg });
    }
    if (key === "pack") {
      const base = db.sku[t.item!].sfg;
      const opts = Object.keys(db.sku).filter((k) => db.sku[k].sfg === base && db.sku[k].n === db.sku[t.item!].n);
      tiles.push({
        title: "Which size are you filling?", cols: Math.min(3, opts.length),
        items: opts.map((k) => ({ l: db.sku[k].size, sub: k === t.item ? "On task sheet" : "Not on sheet", art: art(db.sku[k].kind, db.sku[k].col, db.sku[k].tag, 60), pick: () => this.setD((z) => { if (z.sku !== k) { z.sku = k; z.pm = null; } }), style: { padding: "10px 6px", borderRadius: "16px", border: d.sku === k ? "3px solid #6835FB" : "1px solid #DDE1E8", background: d.sku === k ? "#F7F4FF" : "#FFFFFF", cursor: "pointer" } })),
      });
      if (d.sku !== t.item) msgs.push(msg("Your work sheet says " + db.sku[t.item!].size + ". Change it only if your supervisor tells you.", "warn"));
      const k = db.sku[d.sku!];
      lots.push({ art: art(k.kind, "#9BA3B2", k.tag, 52), name: db.pm[k.pm] ?? "Empty " + k.kind + "s", need: "Needed: " + nf(t.target) + " pcs", lot: d.pm ?? null, manual: d.pmManual, scan: () => this.openScan("pm"), done: !!d.pm });
    }
    if (key === "count") {
      const k = db.sku[d.sku!];
      const unit = k.kind === "drum" ? "drums" : "cans";
      const sfgL = db.lots[d.sfg!]?.avail ?? 0, pmN = db.lots[d.pm!]?.avail ?? 0;
      fields.push(
        { l: unit === "drums" ? "Drums filled" : "Cans filled", v: d.filled ?? null, unit, open: () => this.openKp({ l: "How many " + unit + " did you fill?", unit, v: d.filled, max: Math.min(pmN, Math.floor(sfgL / k.l)), maxL: "Not enough base liquid or empty " + unit + " for that many", quick: [{ l: "Target " + nf(t.target), v: t.target ?? 0 }], set: (v) => this.setD((z) => { z.filled = v; }) }), sub: "Count every " + unit.slice(0, -1) + " you filled — good and bad." },
        { l: "Bad / damaged", v: d.rej ?? 0, unit, open: () => this.openKp({ l: "How many are bad?", unit, v: d.rej, max: d.filled || 0, maxL: "Cannot be more than filled", quick: [{ l: "None", v: 0 }], allowZero: true, set: (v) => this.setD((z) => { z.rej = v; if (!v) z.rejR = null; }) }), step: true, minus: () => this.setD((z) => { z.rej = Math.max(0, (z.rej || 0) - 1); if (!z.rej) z.rejR = null; }), plus: () => this.setD((z) => { z.rej = Math.min(z.filled || 0, (z.rej || 0) + 1); }), err: (d.rej ?? 0) > (d.filled ?? 0) ? "More than filled" : "" },
      );
      if ((d.rej ?? 0) > 0)
        tiles.push({ title: "Why were they damaged?", cols: 2, items: REJ.map((r) => ({ l: r, art: null, pick: () => this.setD((z) => { z.rejR = r; }), style: { height: "54px", borderRadius: "14px", border: d.rejR === r ? "2px solid #B3261E" : "1px solid #DDE1E8", background: d.rejR === r ? "#FCECEC" : "#FFFFFF", color: d.rejR === r ? "#B3261E" : "#1A1E28", cursor: "pointer" } })) });
      const good = Math.max(0, (d.filled || 0) - (d.rej || 0));
      info.push(infoCard("Good " + unit, nf(good)), infoCard("Good %", d.filled ? ((good / d.filled) * 100).toFixed(1) + "%" : "—"), infoCard("Base liquid used", nf((d.filled || 0) * k.l) + " L"), infoCard("Empty " + unit + " used", nf(d.filled || 0)));
      down = true;
    }
    if (key === "fglot") {
      const b = db.box[d.box!], k = db.sku[b.sku];
      sub = "Scan each pallet of filled " + k.size + " cans you pack from. You can add more than one.";
      (d.fg ?? []).forEach((g, i) => lots.push({ art: art("can", k.col, k.tag, 52), name: "Pallet " + (i + 1), need: k.n + " " + k.size, lot: g.lot, manual: g.manual, scan: () => this.setD((z) => { z.fg!.splice(i, 1); }), done: true }));
      lots.push({ art: art("can", "#C2C8D2", "+", 52), name: (d.fg ?? []).length ? "Add another pallet" : "First pallet", need: "Filled " + k.size + " cans", lot: null, scan: () => this.openScan("fg"), scanL: T.scanLabel });
      const have = (d.fg ?? []).reduce((a, g) => a + (db.lots[g.lot]?.avail ?? 0), 0);
      if ((d.fg ?? []).length) info.push(infoCard("Cans scanned", nf(have)), infoCard("Enough for", nf(Math.floor(have / b.cpb)) + " boxes"));
    }
    if (key === "boxes") {
      const b = db.box[d.box!];
      const have = (d.fg ?? []).reduce((a, g) => a + (db.lots[g.lot]?.avail ?? 0), 0);
      const prior = t.carry || 0;
      const total = prior + (d.boxes || 0);
      const full = Math.floor(total / b.batch), rem = total % b.batch;
      info.push(infoCard("Cans per box", String(b.cpb)), infoCard("Box type", b.type), infoCard("Cans available", nf(have)), infoCard("Cans needed", nf((d.boxes || 0) * b.cpb)));
      fields.push({ l: "Boxes packed", v: d.boxes ?? null, unit: "boxes", open: () => this.openKp({ l: "How many full boxes did you pack?", unit: "boxes", v: d.boxes, max: Math.floor(have / b.cpb), maxL: "Not enough filled cans scanned for that many", quick: [{ l: "Target " + nf(t.target), v: t.target ?? 0 }], set: (v) => this.setD((z) => { z.boxes = v; }) }), sub: "Count only full, sealed boxes." });
      bar = { l: "Next batch", v: rem + " / " + b.batch + " boxes", fill: { height: "12px", width: Math.round((rem / b.batch) * 100) + "%", background: rem ? "#B77B08" : "#1D7A45", borderRadius: "6px" } };
      if (prior) msgs.push(msg(prior + " boxes were packed before. They are added first.", "info"));
      if (d.boxes) {
        if (full) msgs.push(msg(full + " full batch" + (full > 1 ? "es" : "") + " of " + b.batch + " boxes are ready to sell.", "ok"));
        if (rem) msgs.push(msg(rem + " boxes wait for the next batch. They can be sold when it has " + b.batch + ".", "warn"));
      }
      down = true;
    }
    if (key === "order") {
      const ord = db.orders[t.order!];
      if (ord) {
        info.push(infoCard("Customer", ord.cust), infoCard("Town", ord.city), infoCard("Truck", ord.vehicle), infoCard("Transporter", ord.trans));
        ord.lines.forEach((ln) => {
          const b = db.box[ln.sku], k = db.sku[b ? b.sku : ln.sku];
          lines.push({ art: b ? art("box", k?.col, b.cpb + "×" + k?.tag, 56) : art(k?.kind ?? "can", k?.col, k?.tag, 56), title: ln.label, qty: nf(ln.qty) + " " + ln.unit, lots: ln.alloc.length ? ln.alloc.map((a) => a[0] + " × " + a[1]).join("   ") : "No lots given yet" });
        });
        if (ord.blocked) msgs.push(msg(ord.blocked, "warn"));
      }
      msgs.push(msg("Load only the items shown here.", "info"));
    }
    if (key === "load") {
      const ord = db.orders[t.order!];
      let need = 0, got = 0;
      ord?.lines.forEach((ln) =>
        ln.alloc.forEach((a) => {
          const v = d.loads?.[a[0]];
          need += a[1];
          got += v || 0;
          const b = db.box[ln.sku], k = db.sku[b ? b.sku : ln.sku];
          lots.push({
            art: b ? art("box", k?.col, b.cpb + "×" + k?.tag, 52) : art(k?.kind ?? "can", k?.col, k?.tag, 52), name: a[0], need: "Load " + a[1] + " " + ln.unit + " · " + ln.label.split(" · ")[0],
            lot: v !== undefined ? a[0] : null, scan: () => this.openScan("load"), qtyL: "Loaded", qtyV: v != null ? v + " " + ln.unit : "Tap to enter", qtyDone: v === a[1], done: v === a[1],
            err: v != null && v !== a[1] ? (v > a[1] ? "Too many — the order takes " + a[1] : "Short by " + (a[1] - v) + ". Load " + a[1] + " or tell the dispatch head.") : "",
            qtyOpen: () => this.openKp({ l: "How many did you load from " + a[0] + "?", unit: ln.unit, v, max: a[1], maxL: "This order takes " + a[1] + " from this lot", quick: [{ l: "All " + a[1], v: a[1] }], set: (q) => this.setD((z) => { z.loads = { ...(z.loads ?? {}), [a[0]]: q }; }) }),
          });
        }),
      );
      bar = { l: "Loaded", v: got + " / " + need, fill: { height: "12px", width: Math.round((got / Math.max(1, need)) * 100) + "%", background: got === need ? "#1D7A45" : "#6835FB", borderRadius: "6px" } };
    }
    if (key === "checklist") {
      CHECK_ITEMS.forEach(([k, l]) => {
        const on = !!d.checks?.[k];
        checks.push({ l, mark: on ? ic("check", 20, "#FFFFFF") : null, flip: () => this.setD((z) => { z.checks = { ...(z.checks ?? {}), [k]: !z.checks?.[k] }; }), box: { width: "32px", height: "32px", borderRadius: "10px", flex: "none", border: on ? "none" : "2px solid #C2C8D2", background: on ? "#1D7A45" : "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center" }, style: { display: "flex", alignItems: "center", gap: "14px", width: "100%", minHeight: "64px", padding: "12px 14px", borderRadius: "16px", border: "1px solid " + (on ? "#BFE3CD" : "#DDE1E8"), background: "#FFFFFF", cursor: "pointer" } });
      });
      checks.push({
        l: d.photo ? "Photo taken · " + d.photo : "Take a photo of the loaded truck", sub: "The photo is kept as proof.", mark: ic("camera", 20, d.photo ? "#FFFFFF" : "#5223E0"),
        flip: () => (d.photo ? this.setD((z) => { z.photo = null; z.photoId = null; }) : this.photoInput?.click()),
        box: { width: "32px", height: "32px", borderRadius: "10px", flex: "none", background: d.photo ? "#1D7A45" : "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center" },
        style: { display: "flex", alignItems: "center", gap: "14px", width: "100%", minHeight: "64px", padding: "12px 14px", borderRadius: "16px", border: "1px solid " + (d.photo ? "#BFE3CD" : "#DDD2FF"), background: "#FFFFFF", cursor: "pointer" },
      });
      msgs.push(msg("This only says the truck is loaded right. The office will send the order.", "info"));
    }

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {sub && <div style={{ fontSize: "15px", lineHeight: "22px", color: "#3D4453" }}>{sub}</div>}
        {info.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            {info.map((f) => (
              <div key={f.l} style={f.style}>
                <div style={{ fontSize: "12px", color: "#6B7385" }}>{f.l}</div>
                <div style={{ fontSize: "18px", lineHeight: "23px", fontWeight: 700, marginTop: "2px" }}>{f.v}</div>
              </div>
            ))}
          </div>
        )}
        {lines.map((ln, i) => (
          <div key={i} style={{ ...card, padding: "14px", display: "flex", gap: "12px", alignItems: "center" }}>
            <span style={artWell(60, 14)}>{ln.art}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: "16px", fontWeight: 700, lineHeight: "21px" }}>{ln.title}</span>
              <span style={{ display: "block", fontSize: "20px", fontWeight: 700, marginTop: "2px" }}>{ln.qty}</span>
              <span style={{ display: "block", ...mono, fontSize: "12px", color: "#6B7385", marginTop: "2px" }}>{ln.lots}</span>
            </span>
          </div>
        ))}
        {tiles.map((tg) => (
          <div key={tg.title}>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#3D4453", marginBottom: "8px" }}>{tg.title}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(" + tg.cols + ",minmax(0,1fr))", gap: "8px" }}>
              {tg.items.map((it) => (
                <button key={it.l} onClick={it.pick} style={it.style}>
                  {it.art && <span style={{ display: "flex", justifyContent: "center" }}>{it.art}</span>}
                  <span style={{ display: "block", fontSize: "15px", fontWeight: 700, marginTop: it.art ? "4px" : 0 }}>{it.l}</span>
                  {it.sub && <span style={{ display: "block", fontSize: "12px", color: "#6B7385" }}>{it.sub}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
        {lots.map((r, i) => this.lotRowEl(r, i))}
        {fields.map((f) => this.fieldEl(f))}
        {bar && (
          <div style={{ ...card, padding: "14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "15px" }}>
              <span style={{ color: "#3D4453", fontWeight: 600 }}>{bar.l}</span>
              <span style={{ fontWeight: 700 }}>{bar.v}</span>
            </div>
            <div style={{ height: "12px", borderRadius: "6px", background: "#EDEFF3", marginTop: "10px", overflow: "hidden" }}><div style={bar.fill} /></div>
          </div>
        )}
        {checks.map((c, i) => (
          <button key={i} onClick={c.flip} style={c.style}>
            <span style={c.box}>{c.mark}</span>
            <span style={{ flex: 1, textAlign: "left" }}>
              <span style={{ display: "block", fontSize: "16px", fontWeight: 600, lineHeight: "21px" }}>{c.l}</span>
              {c.sub && <span style={{ display: "block", fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>{c.sub}</span>}
            </span>
          </button>
        ))}
        {down && this.downEl(d)}
        {msgs.map((m, i) => <MsgBox key={i} m={m} />)}
      </div>
    );
  }

  lotRowEl(o: LotRow, i: number): ReactNode {
    const T = this.T(), db = this.db();
    const x = o.lot ? db.lots[o.lot] : undefined;
    const scanned = !!o.lot;
    return (
      <div key={i} style={{ background: "#FFFFFF", border: "1px solid " + (o.err ? "#F6CFCF" : o.done ? "#BFE3CD" : "#DDE1E8"), borderRadius: "18px", padding: "14px" }}>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <span style={artWell(58, 14)}>{o.art}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: "17px", lineHeight: "22px", fontWeight: 700 }}>{o.name}</span>
            <span style={{ display: "block", fontSize: "14px", color: "#6B7385", marginTop: "1px" }}>{o.need}</span>
          </span>
          {o.done && <span style={{ width: "34px", height: "34px", borderRadius: "50%", background: "#1D7A45", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic("check", 18, "#FFFFFF")}</span>}
        </div>
        {!scanned && <button onClick={o.scan} style={{ marginTop: "12px", width: "100%", height: "56px", border: "none", borderRadius: "14px", background: "#6835FB", color: "#FFFFFF", fontSize: "17px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", cursor: "pointer" }}>{ic("qr", 22)}{o.scanL || T.scanLabel}</button>}
        {scanned && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "12px", background: "#F7F8FA", borderRadius: "12px", padding: "8px 6px 8px 12px" }}>
              <span style={{ ...mono, fontSize: "14px", fontWeight: 600 }}>{o.lot}</span>
              {o.manual && <span style={{ fontSize: "11px", fontWeight: 700, color: "#8A5C05", background: "#FDF6E7", borderRadius: "8px", padding: "2px 6px" }}>By photo</span>}
              <span style={{ flex: 1, fontSize: "13px", color: "#6B7385", textAlign: "right" }}>{x ? nf(x.avail) + " " + lotUnit(db, x) + " left" : ""}</span>
              <button onClick={o.scan} style={{ height: "36px", border: "none", background: "transparent", color: "#5223E0", fontSize: "14px", fontWeight: 700, cursor: "pointer", padding: "0 8px" }}>{T.change}</button>
            </div>
            {o.qtyOpen && (
              <button onClick={o.qtyOpen} style={{ width: "100%", marginTop: "10px", minHeight: "68px", borderRadius: "14px", border: "2px solid " + (o.err ? "#B3261E" : o.qtyDone ? "#C2C8D2" : "#6835FB"), background: o.qtyDone ? "#FFFFFF" : "#F7F4FF", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", cursor: "pointer" }}>
                <span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{o.qtyL}</span>
                <span style={{ fontSize: "28px", fontWeight: 700, color: "#1A1E28" }}>{o.qtyV}</span>
              </button>
            )}
          </div>
        )}
        {o.err && <div style={{ marginTop: "10px", fontSize: "15px", lineHeight: "21px", fontWeight: 700, color: "#B3261E" }}>{o.err}</div>}
        {o.note && !o.err && <div style={{ marginTop: "10px", fontSize: "14px", lineHeight: "20px", fontWeight: 600, color: "#8A5C05", background: "#FDF6E7", borderRadius: "12px", padding: "8px 12px" }}>{o.note}</div>}
        {(o.add || o.remove) && (
          <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
            {o.add && <button onClick={o.add} style={{ flex: 1, height: "52px", borderRadius: "14px", border: "2px solid #6835FB", background: "#F7F4FF", color: "#5223E0", fontSize: "16px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", cursor: "pointer" }}>{ic("plus", 20)}Add another drum</button>}
            {o.remove && <button onClick={o.remove} style={{ flex: o.add ? "none" : 1, height: "52px", padding: "0 16px", borderRadius: "14px", border: "1.5px solid #C2C8D2", background: "#FFFFFF", color: "#B3261E", fontSize: "15px", fontWeight: 700, cursor: "pointer" }}>Remove this drum</button>}
          </div>
        )}
      </div>
    );
  }

  fieldEl(f: QField): ReactNode {
    const has = f.v != null && f.v !== 0 ? true : f.v === 0 && f.l === "Bad / damaged";
    const sq = (onClick: (() => void) | undefined, icn: string, label: string) => (
      <button onClick={onClick} aria-label={label} style={{ width: "60px", borderRadius: "14px", border: "1.5px solid #C2C8D2", background: "#FFFFFF", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic(icn, 24)}</button>
    );
    return (
      <div key={f.l} style={{ ...card, padding: "14px" }}>
        <div style={{ fontSize: "16px", fontWeight: 700, color: "#3D4453" }}>{f.l}</div>
        <div style={{ display: "flex", alignItems: "stretch", gap: "10px", marginTop: "10px" }}>
          {f.step && sq(f.minus, "minus", "Less")}
          <button onClick={f.open} style={{ flex: 1, minHeight: "72px", borderRadius: "14px", border: "2px solid " + (f.err ? "#B3261E" : has ? "#C2C8D2" : "#6835FB"), background: has ? "#FFFFFF" : "#F7F4FF", display: "flex", alignItems: "baseline", justifyContent: "center", padding: "14px 8px", cursor: "pointer" }}>
            <span style={{ fontSize: "34px", fontWeight: 700, color: "#1A1E28" }}>{f.v == null ? "—" : nf(f.v)}</span>
            <span style={{ fontSize: "16px", color: "#6B7385", marginLeft: "6px" }}>{f.unit}</span>
          </button>
          {f.step && sq(f.plus, "plus", "More")}
        </div>
        {f.sub && <div style={{ fontSize: "14px", color: "#6B7385", marginTop: "8px" }}>{f.sub}</div>}
        {f.err && <div style={{ fontSize: "15px", lineHeight: "21px", color: "#B3261E", marginTop: "8px", fontWeight: 700 }}>{f.err}</div>}
      </div>
    );
  }

  downEl(d: Draft): ReactNode {
    const T = this.T();
    return (
      <div style={{ ...card, padding: "14px" }}>
        <div style={{ fontSize: "16px", fontWeight: 700, color: "#3D4453" }}>{T.stopped}</div>
        <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
          <button onClick={() => this.setD((z) => { z.down = false; z.downR = null; z.downMin = null; })} style={{ ...btn(d.down === false ? "p" : "s", 54), flex: 1 }}>{T.noStop}</button>
          <button onClick={() => this.setD((z) => { z.down = true; })} style={{ ...btn(d.down ? "d" : "s", 54), flex: 1 }}>Yes, it stopped</button>
        </div>
        {d.down && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px", marginTop: "12px" }}>
              {DOWN.map(([l, icn]) => (
                <button key={l} onClick={() => this.setD((z) => { z.downR = l; })} style={{ height: "78px", borderRadius: "14px", border: d.downR === l ? "2px solid #B3261E" : "1px solid #DDE1E8", background: d.downR === l ? "#FCECEC" : "#FFFFFF", color: d.downR === l ? "#B3261E" : "#3D4453", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "6px", cursor: "pointer", padding: "4px" }}>
                  {ic(icn, 24)}<span style={{ fontSize: "13px", fontWeight: 700, lineHeight: "16px" }}>{l}</span>
                </button>
              ))}
            </div>
            <button onClick={() => this.openKp({ l: "How many minutes did it stop?", unit: T.minutes, v: d.downMin, max: 480, maxL: "More than one shift — ask the supervisor", quick: [{ l: "15", v: 15 }, { l: "30", v: 30 }, { l: "60", v: 60 }], set: (v) => this.setD((z) => { z.downMin = v; }) })} style={{ width: "100%", marginTop: "10px", height: "60px", borderRadius: "14px", border: "1.5px solid " + (d.downMin ? "#C2C8D2" : "#B77B08"), background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", cursor: "pointer" }}>
              <span style={{ fontSize: "15px", color: "#3D4453", fontWeight: 600 }}>How long</span>
              <span style={{ fontSize: "24px", fontWeight: 700 }}>{d.downMin ? d.downMin + " " + T.minutes : "Tap to enter"}</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ---------------------------------------------------------------- result */

  renderResult(): ReactNode {
    const st = this.state, T = this.T(), r = st.result!;
    /* "failed" is amber, not red: it is never an error the worker is stuck
       with — it is one thing to check, with a way to finish either way. */
    const C2: Record<string, [string, string, string, string]> = { done: ["#E9F5EE", "#1D7A45", "check", T.completed], pending: ["#FDF6E7", "#8A5C05", "clock", T.pending], retry: ["#FDF6E7", "#8A5C05", "clock", T.pending], held: ["#FDF6E7", "#8A5C05", "people", "Sent to your supervisor"], failed: ["#FDF6E7", "#8A5C05", "alert", T.failed], sending: ["#F1ECFF", "#5223E0", "sync", T.sending] };
    const c = C2[r.kind];
    const next = () => this.setState({ result: null, flow: null });
    const home = { l: T.nextTask, run: next, style: btn("p", 60), icon: null as ReactNode };
    let text = "", title = c[3], rows: { l: string; v: string }[] = [], label: { code: string; name: string; meta: string } | null = null;
    type Act = { l: string; run: () => void; style: CSSProperties; icon: ReactNode };
    let acts: Act[] = [];
    if (r.kind === "sending") text = "Please wait. Do not close the app.";
    if (r.kind === "done") {
      text = r.msg + (r.replay ? " (It was already saved — nothing was sent twice.)" : "");
      rows = r.rows.map((q) => ({ l: q[0], v: q[1] }));
      label = r.label;
      acts = ([] as Act[]).concat([home, { l: T.listen, run: () => this.speak(T.completed + ". " + r.msg), style: { ...btn("s", 48), border: "none", color: "#5223E0" }, icon: ic("speaker", 20) }]);
    }
    if (r.kind === "held") {
      text = r.text;
      title = r.title;
      rows = [{ l: "Job", v: r.task }, { l: "ID", v: r.key }];
      acts = [home, { l: T.listen, run: () => this.speak(r.title + ". " + r.text), style: { ...btn("s", 48), border: "none", color: "#5223E0" }, icon: ic("speaker", 20) }];
    }
    if (r.kind === "pending" || r.kind === "retry") {
      text = "Saved on this phone only. It will send by itself when the network comes back.";
      rows = [{ l: "Job", v: r.kind === "pending" ? r.task : st.flow?.task.id ?? "—" }, { l: "ID", v: r.key }];
      acts = [{ l: "See waiting jobs", run: () => this.setState({ result: null, route: "sync" }), style: btn("s", 56), icon: ic("sync", 22) }, home];
    }
    if (r.kind === "failed") {
      text = r.text;
      title = r.title;
      text = r.text.replace("Nothing was saved.", "Nothing is lost.") + " Fix it now, or send it to your supervisor.";
      rows = [{ l: "What to do", v: r.fix }];
      const f = st.flow;
      acts = [
        r.step && f
          ? { l: T.fixIt, run: () => this.setState({ result: null, flow: { ...f, step: Math.max(0, STEPS[f.task.proc].indexOf(r.step!)) } }), style: btn("p", 60), icon: null }
          : f
            ? { l: T.retry, run: () => void this.submit(), style: btn("p", 60), icon: ic("sync", 22, "#FFFFFF") }
            : home,
        /* The way to finish without fixing anything: the work is received,
           kept as it is, and the Production Head decides. */
        ...(f ? [{ l: "Send to supervisor", run: () => void this.submit(true), style: btn("s", 56), icon: ic("people", 22) } as Act] : []),
        { l: T.listen, run: () => this.speak(r.title + ". " + r.fix), style: { ...btn("s", 48), border: "none", color: "#5223E0" }, icon: ic("speaker", 20) },
      ];
    }
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "#FFFFFF" }}>
        <div className="fx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 20px 12px 20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "10px" }}>
          <span style={{ width: "112px", height: "112px", borderRadius: "50%", background: c[0], display: "flex", alignItems: "center", justifyContent: "center", flex: "none", animation: r.kind === "sending" ? "fx-spin 1.2s linear infinite" : "none" }}>{ic(c[2], 56, c[1])}</span>
          <div style={{ fontSize: "28px", lineHeight: "34px", fontWeight: 700, color: c[1] }}>{title}</div>
          <div style={{ fontSize: "17px", lineHeight: "25px", color: "#3D4453", maxWidth: "320px" }}>{text}</div>
          {rows.length > 0 && (
            <div style={{ width: "100%", background: "#F7F8FA", borderRadius: "18px", padding: "2px 16px", marginTop: "6px", textAlign: "left" }}>
              {rows.map((q) => (
                <div key={q.l} style={{ display: "flex", alignItems: "baseline", gap: "10px", padding: "11px 0", borderTop: "1px solid #EDEFF3" }}>
                  <span style={{ flex: 1, fontSize: "15px", color: "#3D4453" }}>{q.l}</span>
                  <span style={{ fontSize: "17px", fontWeight: 700, textAlign: "right" }}>{q.v}</span>
                </div>
              ))}
            </div>
          )}
          {label && (
            <div style={{ width: "100%", border: "2px dashed #C2C8D2", borderRadius: "18px", padding: "14px", display: "flex", gap: "14px", alignItems: "center", textAlign: "left", marginTop: "4px" }}>
              <span style={{ padding: "6px", background: "#FFFFFF", border: "1px solid #DDE1E8", borderRadius: "8px", flex: "none" }}>{qr(label.code, 88)}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: "11px", fontWeight: 700, letterSpacing: "0.06em", color: "#6B7385" }}>MAHEK ONE · LOT LABEL</span>
                <span style={{ display: "block", ...mono, fontSize: "15px", fontWeight: 600, marginTop: "4px" }}>{label.code}</span>
                <span style={{ display: "block", fontSize: "14px", marginTop: "2px" }}>{label.name}</span>
                <span style={{ display: "block", fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>{label.meta}</span>
              </span>
            </div>
          )}
        </div>
        <div style={{ flex: "none", padding: "12px 20px 18px 20px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {acts.map((a) => <button key={a.l} onClick={a.run} style={a.style}>{a.icon}{a.l}</button>)}
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- sync + help */

  renderSync(): ReactNode {
    const st = this.state, T = this.T(), db = this.db();
    const q = st.queue;
    const pend = q.filter((x) => x.status === "pending");
    const n = st.net;
    const c: [string, string, string, string, string] = pend.length
      ? n === "offline" ? ["#FDF6E7", "#8A5C05", "wifioff", pend.length + " " + T.waitingSend, "No network. They will send by themselves when the network comes back."] : ["#F1ECFF", "#3D14A8", "sync", "Sending now", "The network is back."]
      : n === "offline" ? ["#F7F8FA", "#3D4453", "wifioff", T.offline, "You can keep working. New jobs will wait here until the network comes back."] : ["#E9F5EE", "#1D7A45", "check", T.allSaved, n === "weak" ? "The network is weak. Sending may take longer." : "Connected."];
    return (
      <div className="fx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", gap: "14px", alignItems: "center", padding: "16px", borderRadius: "18px", background: c[0], color: c[1] }}>
          <span style={{ width: "56px", height: "56px", borderRadius: "50%", background: "rgba(255,255,255,0.7)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic(c[2], 30, c[1])}</span>
          <span style={{ flex: 1 }}>
            <span style={{ display: "block", fontSize: "20px", fontWeight: 700 }}>{c[3]}</span>
            <span style={{ display: "block", fontSize: "15px", lineHeight: "21px", marginTop: "2px" }}>{c[4]}</span>
          </span>
        </div>
        {!q.length && <div style={{ fontSize: "15px", lineHeight: "21px", color: "#6B7385", textAlign: "center", padding: "6px 0" }}>Nothing is waiting to send.</div>}
        {q.slice().reverse().map((x) => {
          const t = x.flow.task;
          const badge = x.status === "done" ? ["#E9F5EE", "#1D7A45", T.completed] : x.status === "held" ? ["#FDF6E7", "#8A5C05", "With supervisor"] : x.status === "failed" ? ["#FDF6E7", "#8A5C05", "Check it"] : ["#FDF6E7", "#8A5C05", T.pending];
          /* How long it has waited, said plainly: past two days it goes to the supervisor rather than straight in. */
          const ageH = x.savedIso ? (Date.now() - Date.parse(x.savedIso)) / 3_600_000 : 0;
          const ageL = x.status === "pending" && ageH >= 1 ? " · waiting " + (ageH >= 24 ? Math.floor(ageH / 24) + " d " + Math.floor(ageH % 24) + " h" : Math.floor(ageH) + " h") + (ageH > OFFLINE_HOURS ? " — your supervisor will check it" : "") : "";
          return (
            <button key={x.key} onClick={() => x.status === "failed" && x.result && this.setState({ flow: x.flow, result: x.result, queue: st.queue.filter((z) => z.key !== x.key) })} style={{ ...card, padding: "14px", display: "flex", gap: "12px", alignItems: "center", width: "100%", textAlign: "left", cursor: x.status === "failed" ? "pointer" : "default" }}>
              <span style={artWell(56, 14)}>{this.taskArt(t, 48)}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: "16px", fontWeight: 700 }}>{taskName(db, t)}</span>
                <span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{t.id + " · saved on phone " + x.at + ageL + (x.doneAt ? " · sent " + x.doneAt : "") + " · " + x.key}</span>
              </span>
              <Pill l={badge[2]} bg={badge[0]} fg={badge[1]} />
            </button>
          );
        })}
        {pend.length > 0 && <button onClick={() => (st.net === "offline" ? this.toast("Still no network. They will send by themselves.") : void this.flushQueue())} style={btn("p", 56)}>{ic("sync", 22, "#FFFFFF")}{T.retry}</button>}
        <div style={{ fontSize: "14px", lineHeight: "20px", color: "#6B7385", padding: "0 4px" }}>Work waiting here is not saved yet. It will send by itself. It is sent only once, even if you tap many times.</div>
      </div>
    );
  }

  /* ================================================================ More and Settings
   * The name used to open one long sheet that mixed the day's work with the
   * phone's settings. WORK is the More tab — what somebody does on the floor
   * besides their tasks. SETTINGS is its own page — who they are, the
   * language, the PIN, help and signing out — opened from the bottom bar or
   * by tapping their name.
   * ------------------------------------------------------------------------- */

  menuRow(l: string, s: string, icn: string, run: () => void, tone?: "danger", badge?: number): ReactNode {
    const red = tone === "danger";
    return (
      <button key={l} onClick={run} style={{ display: "flex", alignItems: "center", gap: "14px", width: "100%", minHeight: "68px", padding: "12px 14px", borderRadius: "16px", border: "1px solid " + (red ? "#F6CFCF" : "#DDE1E8"), background: "#FFFFFF", cursor: "pointer" }}>
        <span style={{ width: "44px", height: "44px", borderRadius: "12px", background: red ? "#FCECEC" : "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic(icn, 22, red ? "#B3261E" : "#5223E0")}</span>
        <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
          <span style={{ display: "block", fontSize: "17px", lineHeight: "22px", fontWeight: 700, color: red ? "#B3261E" : "#1A1E28" }}>{l}</span>
          {!!s && <span style={{ display: "block", fontSize: "14px", lineHeight: "19px", color: "#6B7385", marginTop: "2px" }}>{s}</span>}
        </span>
        {!!badge && <span style={{ minWidth: "26px", height: "26px", padding: "0 8px", borderRadius: "13px", background: "#FDF6E7", color: "#8A5C05", fontSize: "13px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{String(badge)}</span>}
        <span style={{ display: "flex", flex: "none" }}>{ic("chev", 22, "#9BA3B2")}</span>
      </button>
    );
  }

  pageHead(title: string, sub?: string, back?: () => void): ReactNode {
    const T = this.T();
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "12px", minHeight: "48px" }}>
        {back && <button onClick={back} aria-label={T.back} style={{ width: "44px", height: "44px", borderRadius: "22px", border: "none", background: "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flex: "none" }}>{ic("back", 22, "#5223E0")}</button>}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: "24px", lineHeight: "30px", fontWeight: 700 }}>{title}</span>
          {!!sub && <span style={{ display: "block", fontSize: "14px", lineHeight: "19px", color: "#6B7385", marginTop: "2px" }}>{sub}</span>}
        </span>
      </div>
    );
  }

  sectionLabel(l: string): ReactNode {
    return <div style={{ fontSize: "13px", lineHeight: "18px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#6B7385", marginTop: "6px" }}>{l}</div>;
  }

  renderMore(): ReactNode {
    const st = this.state, T = this.T(), me = st.me!;
    const pendN = st.queue.filter((q) => q.status === "pending").length;
    const tools: ReactNode[] = [];
    if (me.counts) tools.push(this.menuRow("Stock check", "Count any stock and check it against the book", "chart", () => this.openStock()));
    if (me.qc) tools.push(this.menuRow("Quality check", "Test base liquid lots and approve or reject them", "flask", () => this.openQc()));
    const buy = me.reqs?.length ? this.menuRow("Purchase requirement", "Ask the office to buy what " + (me.reqs.length > 1 ? "your departments need" : REQ_WORD[me.reqs[0]] + " needs") + ", and track it", "cart", () => this.openReq()) : null;
    if (me.drums) tools.push(this.menuRow("Empty drum entry", "Scan and weigh a drum once it is empty", "box", () => this.openDrum()));
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 16px 24px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
        {this.pageHead(T.more, "Work besides your tasks")}
        {buy && this.sectionLabel("Purchase")}
        {buy}
        {this.sectionLabel("Work")}
        {tools.length ? tools : <div style={{ ...card, padding: "20px", fontSize: "15px", lineHeight: "21px", color: "#6B7385", textAlign: "center" }}>Nothing else to do here. Your tasks are on Home.</div>}
        {me.head && this.menuRow(T.machines, "Machines and stoppages on the floor", "wrench", () => this.setState({ route: "machines" }))}
        {me.head && this.menuRow(T.sync, pendN ? pendN + " waiting to send" : "Everything is sent", "sync", () => this.setState({ route: "sync" }), undefined, pendN)}
        {me.head && this.sectionLabel(T.settings)}
        {me.head && this.menuRow(T.settings, "Language, PIN, help and sign out", "badge", () => this.setState({ route: "settings" }))}
      </div>
    );
  }

  pickLanguage() {
    const T = this.T();
    const LN: Record<Lang, string> = { en: "English", hi: "हिन्दी · Hindi", mr: "मराठी · Marathi" };
    this.setState({
      sheet: {
        type: "reason", title: T.language, sub: "Buttons, steps and spoken help change to this language.", reasons: Object.values(LN), okL: T.ok, sel: LN[this.state.lang],
        done: (r) => {
          const k = (Object.keys(LN) as Lang[]).find((x) => LN[x] === r) ?? "en";
          save(null, "lang", k);
          void call("setLang", k);
          this.setState({ lang: k, sheet: null });
          this.toast(k === "en" ? "Language: English" : k === "hi" ? "भाषा: हिन्दी" : "भाषा: मराठी");
        },
      },
    });
  }

  askSignOut() {
    const T = this.T();
    const pendN = this.state.queue.filter((q) => q.status === "pending").length;
    if (pendN)
      return this.setState({ sheet: { type: "reason", title: "Sign out with " + pendN + " job" + (pendN > 1 ? "s" : "") + " waiting?", sub: "It stays on this phone and sends later. No one else can change it.", reasons: ["Yes, sign out"], okL: T.signOut, danger: true, done: () => void this.signOut() } });
    void this.signOut();
  }

  renderSettings(): ReactNode {
    const st = this.state, T = this.T(), me = st.me!, db = this.db();
    const emp = db.emp[me.key];
    const LN: Record<Lang, string> = { en: "English", hi: "हिन्दी", mr: "मराठी" };
    /* Role and badge, each once: "Production Head · production head · —" was three ways of saying one thing. */
    const role = [emp?.role, emp?.id].filter((x): x is string => !!x && x !== "—" && x !== "-").filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i).join(" · ");
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 16px 24px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
        {this.pageHead(T.settings)}
        <div style={{ ...card, padding: "16px", display: "flex", alignItems: "center", gap: "14px" }}>
          <span style={this.av(me.key, 56)}>{me.ini}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: "19px", lineHeight: "24px", fontWeight: 700 }}>{me.n}</span>
            {!!role && <span style={{ display: "block", fontSize: "14px", lineHeight: "19px", color: "#6B7385", marginTop: "2px" }}>{role}</span>}
            <span style={{ display: "block", fontSize: "14px", lineHeight: "19px", color: "#6B7385", marginTop: "2px" }}>{db.loc + " · " + db.shift.split(" · ")[0]}</span>
          </span>
        </div>
        {this.sectionLabel("App")}
        {this.menuRow(T.language, LN[st.lang], "globe", () => this.pickLanguage())}
        {this.menuRow("Change my PIN", "4 numbers you sign in with", "badge", () => this.setState({ signStep: "newpin", newPin: "", newPin1: "", pinErr: "" }))}
        {this.props.dev && this.menuRow("Network (preview only)", (T as Record<string, string>)[st.net] + " — tap to change", st.net === "offline" ? "wifioff" : "wifi", () => { const nx = ({ online: "weak", weak: "offline", offline: "online" } as const)[st.net]; this.setNet(nx); this.toast((T as Record<string, string>)[nx]); })}
        {this.menuRow(T.help, "Short videos and audio", "help", () => this.setState({ route: "help" }))}
        {this.sectionLabel("Account")}
        {this.menuRow(T.signOut, "Unsent work stays on this phone", "out", () => this.askSignOut(), "danger")}
        <div style={{ fontSize: "12px", lineHeight: "16px", color: "#9BA3B2", textAlign: "center", marginTop: "8px" }}>{"Mahek One Factory · " + PAGE_BUILD}</div>
      </div>
    );
  }

  renderHelp(): ReactNode {
    const st = this.state, T = this.T(), area = st.me!.area;
    const list = HELP.filter((h) => ["scan", "sync"].indexOf(h[0]) > -1 || area === "head" || h[0] === area).concat(HELP.filter((h) => ["scan", "sync"].indexOf(h[0]) < 0 && h[0] !== area && area !== "head"));
    const p = st.play;
    return (
      <div className="fx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        {this.pageHead(T.help, "Short videos and audio", () => this.setState({ route: "settings" }))}
        {list.map((h) => {
          const on = !!p && p.id === h[0];
          const i = on ? Math.min(h[4].length - 1, Math.floor((p!.t / Math.max(1, p!.dur)) * h[4].length)) : 0;
          const playL = on && p!.on ? "Pause" : on && p!.t >= p!.dur ? "Play again" : "Play video";
          return (
            <div key={h[0]} style={{ ...card, padding: "14px" }}>
              <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                <span style={{ width: "64px", height: "64px", borderRadius: "16px", background: "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic(h[3], 28, "#5223E0")}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: "17px", lineHeight: "22px", fontWeight: 700 }}>{h[1]}</span>
                  <span style={{ display: "block", fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>{"Video · " + h[2] + (h[0] === area ? " · for your work" : "")}</span>
                </span>
              </div>
              {on && (
                <div style={{ marginTop: "12px" }}>
                  <div style={{ height: "8px", borderRadius: "4px", background: "#EDEFF3", overflow: "hidden" }}><div style={{ height: "8px", width: Math.round((p!.t / p!.dur) * 100) + "%", background: "#6835FB" }} /></div>
                  <div style={{ fontSize: "16px", lineHeight: "23px", fontWeight: 600, marginTop: "10px", padding: "12px", borderRadius: "12px", background: "#F7F4FF", color: "#3D14A8" }}>{h[4][i]}</div>
                </div>
              )}
              <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                <button onClick={() => { this.setState({ play: on && p!.on ? { ...p!, on: false } : { id: h[0], t: on && p!.t < p!.dur ? p!.t : 0, dur: 9, on: true } }); if (!(on && p!.on)) this.speak(h[4][i]); }} style={{ ...btn("p", 50), flex: 1, fontSize: "16px" }}>{ic(on && p!.on ? "pause" : "play", 20, "#FFFFFF")}{playL}</button>
                <button onClick={() => this.speak(h[1] + ". " + h[4].join(" "))} style={{ ...btn("s", 50), flex: 1, fontSize: "16px" }}>{ic("speaker", 20)}{T.listen}</button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  /* ---------------------------------------------------------------- the head's screens */

  renderToday(): ReactNode {
    const st = this.state, T = this.T(), db = this.db(), now = this.now();
    /* A supervisor of several departments sees all of them, or the one picked at the top. */
    const dsel = this.dept();
    const tasks = this.tasks().filter((t) => inDept(st.me!, dsel, t.proc));
    const sum = <X,>(a: X[], f: (x: X) => number) => a.reduce((x, y) => x + f(y), 0);
    const by = (p: Proc) => tasks.filter((t) => t.proc === p);
    const mix = by("mixing"), fil = by("filling"), pk = by("packing"), ds = by("dispatch");
    const cans = fil.filter((t) => db.sku[t.item!]?.kind !== "drum"), drums = fil.filter((t) => db.sku[t.item!]?.kind === "drum");
    const dn = (a: Task[]) => a.filter((t) => t.status === "done");
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
    const K = (l: string, icn: string, act: number, plan: number, unit: string, sub: string) => ({ l, icn, act, plan, unit, sub });
    const rej = sum(dn(fil), (t) => t.out?.rej || 0), fgood = sum(dn(cans), (t) => t.out?.good ?? 0);
    const mixPlan = sum(mix, (t) => (t.batches ?? 1) * (db.sfg[t.item!]?.batch ?? 0)), mixAct = sum(dn(mix), (t) => t.out?.good ?? 0);
    const kpis = [
      K("Mixing", "flask", mixAct, mixPlan, "litres of base", pct(mixAct, mixPlan) + "% of plan"),
      K("Filling", "fill", fgood, sum(cans, (t) => t.target ?? 0), "good cans", "+ " + nf(sum(dn(drums), (t) => t.out?.good ?? 0)) + " / " + nf(sum(drums, (t) => t.target ?? 0)) + " drums · " + rej + " rejected"),
      K("Packing", "box", sum(dn(pk), (t) => t.out?.good ?? 0), sum(pk, (t) => t.target ?? 0), "boxes", "Only full batches count as stock"),
      K("Dispatch", "truck", dn(ds).length, ds.length, "orders checked", ds.filter((t) => t.status === "blocked").length + " waiting for ERP"),
    ];
    const status = (t: Task) => jobStatus(t, now, !!st.started[t.id]);
    const flags: [string, number, string, string, string][] = [["Late", tasks.filter((t) => status(t)[3] === "late").length, "late", "#FCECEC", "#B3261E"], ["To check", db.review.length, "review", "#FDF6E7", "#8A5C05"], ["Waiting to send", st.queue.filter((x) => x.status === "pending").length, "progress", "#F1ECFF", "#3D14A8"]];
    const filters: [string, string][] = [["all", "All"], ["late", "Late"], ["todo", "Not started"], ["progress", "Working"], ["done", "Done"], ["blocked", "Blocked"], ["Mixing", "Mixing"], ["Filling", "Filling"], ["Packing", "Packing"], ["Dispatch", "Dispatch"]];
    const PROC: Record<string, Proc> = { Mixing: "mixing", Filling: "filling", Packing: "packing", Dispatch: "dispatch" };
    /* Dispatch work comes from orders, so it is never given by hand. */
    const giveable = myDepts(st.me!).filter((p) => p !== "dispatch");
    const ORDER: Record<string, number> = { late: 0, progress: 1, todo: 2, blocked: 3, done: 4 };
    const list = tasks
      .filter((t) => st.hf === "all" || (PROC[st.hf] ? t.proc === PROC[st.hf] : status(t)[3] === st.hf))
      .sort((a, b) => ORDER[status(a)[3]] - ORDER[status(b)[3]] || (a.due > b.due ? 1 : -1));
    return (
      <>
        <div className="fx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 96px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ fontSize: "14px", color: "#6B7385" }}>{db.dateLine + " · " + db.loc + " · " + db.shift.split(" · ")[0] + " · now " + now}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            {kpis.filter((k) => inDept(st.me!, dsel, PROC[k.l])).map((k) => (
              <button key={k.l} onClick={() => this.setState({ hf: k.l })} style={{ ...card, padding: "14px", textAlign: "left", cursor: "pointer" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 700, color: "#3D4453" }}>{ic(k.icn, 16)}{k.l}</span>
                <span style={{ display: "block", fontSize: "24px", lineHeight: "30px", fontWeight: 700, marginTop: "6px" }}>{nf(k.act)}<span style={{ fontSize: "15px", fontWeight: 600, color: "#6B7385" }}>{" / " + nf(k.plan)}</span></span>
                <span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{k.unit}</span>
                <span style={{ display: "block", height: "6px", borderRadius: "3px", background: "#EDEFF3", marginTop: "8px", overflow: "hidden" }}><span style={{ display: "block", height: "6px", width: Math.min(100, pct(k.act, Math.max(1, k.plan))) + "%", background: "#6835FB", borderRadius: "3px" }} /></span>
                <span style={{ display: "block", fontSize: "12px", color: "#6B7385", marginTop: "6px" }}>{k.sub}</span>
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px" }}>
            {flags.map((f) => (
              <button key={f[0]} onClick={() => (f[2] === "review" ? this.setState({ route: "review" }) : this.setState({ hf: f[2] }))} style={{ padding: "10px 8px", borderRadius: "14px", border: "none", background: f[1] ? f[3] : "#F7F8FA", color: f[1] ? f[4] : "#6B7385", textAlign: "center", cursor: "pointer" }}>
                <span style={{ display: "block", fontSize: "22px", fontWeight: 700 }}>{f[1]}</span>
                <span style={{ display: "block", fontSize: "12px", fontWeight: 600, lineHeight: "15px" }}>{f[0]}</span>
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "2px" }}>
            {filters.map(([k, l]) => <button key={k} onClick={() => this.setState({ hf: k })} style={{ height: "38px", padding: "0 14px", borderRadius: "19px", border: st.hf === k ? "none" : "1px solid #DDE1E8", background: st.hf === k ? "#1A1E28" : "#FFFFFF", color: st.hf === k ? "#FFFFFF" : "#3D4453", fontSize: "14px", fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer", flex: "none" }}>{l}</button>)}
          </div>
          {!list.length && <div style={{ ...card, padding: "24px", textAlign: "center", fontSize: "15px", color: "#6B7385" }}>No jobs in this group.</div>}
          {list.map((t) => {
            const js = status(t);
            const tm = t.team;
            return (
              <button key={t.id} onClick={() => this.setState({ sheet: { type: "job", id: t.id } })} style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%", padding: "12px", borderRadius: "18px", border: "1px solid " + (js[3] === "late" ? "#F6CFCF" : "#DDE1E8"), background: "#FFFFFF", cursor: "pointer", boxShadow: js[3] === "late" ? "inset 4px 0 0 #B3261E" : "none" }}>
                <span style={artWell(54, 14)}>{this.taskArt(t, 46)}</span>
                <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  <span style={{ display: "flex", marginBottom: "4px" }}><Pill l={js[0]} bg={js[1]} fg={js[2]} /></span>
                  <span style={{ display: "block", fontSize: "15px", lineHeight: "20px", fontWeight: 700 }}>{taskName(db, t)}</span>
                  <span style={{ display: "block", fontSize: "13px", color: "#6B7385", marginTop: "1px" }}>{(T as Record<string, string>)[t.proc] + " · " + t.id + " · " + (t.status === "done" ? nf(t.out?.good) + " " + t.out?.unit + " at " + t.out?.at : taskTarget(db, t).split(" · ")[0] + " · due " + t.due)}</span>
                  <span style={{ display: "block", fontSize: "13px", color: "#3D4453", marginTop: "1px" }}>{[tm.owner, tm.op, ...tm.helpers].filter(Boolean).map((k) => this.name(k).split(" ")[0]).join(" · ") + (tm.helpers.length ? "" : " · no helper")}</span>
                </span>
              </button>
            );
          })}
        </div>
        {giveable.length > 0 && <button onClick={() => this.setState({ sheet: { type: "assign" }, asg: this.defaultAsg(dsel && (giveable as Proc[]).includes(dsel) ? dsel : giveable[0]) })} style={{ position: "absolute", right: "16px", bottom: "94px", height: "56px", padding: "0 20px", border: "none", borderRadius: "28px", background: "#6835FB", color: "#FFFFFF", fontSize: "16px", fontWeight: 700, display: "flex", alignItems: "center", gap: "8px", boxShadow: "0 8px 20px rgba(104,53,251,0.35)", cursor: "pointer", zIndex: 5 }}>{ic("plus", 22, "#FFFFFF")}Give a task</button>}
      </>
    );
  }

  defaultAsg(proc: Proc): NonNullable<State["asg"]> {
    const db = this.db();
    const item =
      proc === "mixing" ? (Object.keys(db.sfg).find((k) => db.sfg[k].recipe.length) ?? "")
      : proc === "filling" ? (Object.keys(db.sku)[0] ?? "")
      : (Object.keys(db.box)[0] ?? "");
    return { proc, item, qty: proc === "mixing" ? 1 : proc === "filling" ? 600 : 50, due: "14:00" };
  }

  renderReview(): ReactNode {
    const db = this.db();
    const K: Record<string, [string, string, string]> = { tolerance: ["Outside the limit", "#FDF6E7", "#8A5C05"], manual: ["Picked by photo", "#FDF6E7", "#8A5C05"], correction: ["Correction", "#EDF2FC", "#2B5CBF"], attribution: ["Team missing", "#F7F8FA", "#3D4453"], issue: ["Problem reported", "#FCECEC", "#B3261E"] };
    return (
      <div className="fx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 20px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ fontSize: "15px", lineHeight: "21px", color: "#3D4453" }}>Jobs the app could not accept on its own. Every decision needs a reason and is kept in the history.</div>
        {!db.review.length && <div style={{ ...card, padding: "28px 18px", textAlign: "center", fontSize: "16px", color: "#3D4453" }}>Nothing to check. Every job is within the rules.</div>}
        {db.review.map((it) => {
          const k = K[it.kind] ?? K.issue;
          return (
            <div key={it.id} style={{ ...card, padding: "14px" }}>
              <Pill l={k[0]} bg={k[1]} fg={k[2]} />
              <div style={{ fontSize: "17px", lineHeight: "22px", fontWeight: 700, marginTop: "8px" }}>{it.title}</div>
              <div style={{ fontSize: "15px", lineHeight: "22px", color: "#1A1E28", marginTop: "4px" }}>{it.text}</div>
              <div style={{ fontSize: "13px", color: "#6B7385", marginTop: "6px" }}>{it.meta + " · " + it.task}</div>
              <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                {it.acts.map((a, i) => <button key={a} onClick={() => this.decide(it, a, i)} style={{ ...btn(i ? "s" : "p", 50), flex: 1, fontSize: "15px" }}>{a}</button>)}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  renderTeams(): ReactNode {
    const db = this.db(), T = this.T(), tasks = this.tasks();
    const sum = <X,>(a: X[], f: (x: X) => number) => a.reduce((x, y) => x + f(y), 0);
    return (
      <div className="fx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 20px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", gap: "10px", padding: "12px 14px", borderRadius: "14px", background: "#F1ECFF", color: "#3D14A8", fontSize: "14px", lineHeight: "20px", fontWeight: 600 }}>Each job is counted once for the team. A 1,000 L batch is 1,000 L for the mixing team — never 1,000 L for each of the three people.</div>
        {(this.dept() ? [this.dept()!] : myDepts(this.state.me!)).map((p) => {
          const all = tasks.filter((t) => t.proc === p);
          const done = all.filter((t) => t.status === "done");
          const unit = { mixing: "litres", filling: "good cans + drums", packing: "boxes", dispatch: "orders checked" }[p];
          const out = sum(done, (t) => t.out?.good ?? 0), rej = sum(done, (t) => t.out?.rej || 0);
          const ppl: Record<string, { role: string; jobs: number; done: number }> = {};
          all.forEach((t) => {
            const add = (k: string | null, role: string) => {
              if (!k) return;
              ppl[k] = ppl[k] || { role, jobs: 0, done: 0 };
              ppl[k].jobs++;
              if (t.status === "done") ppl[k].done++;
            };
            add(t.team.owner, "Responsible");
            add(t.team.op, p === "dispatch" ? "Lead loader" : "Machine operator");
            t.team.helpers.forEach((h) => add(h, "Helper"));
          });
          return (
            <div key={p} style={{ ...card, padding: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ width: "40px", height: "40px", borderRadius: "12px", background: "#F1ECFF", color: "#5223E0", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic(PC[p], 22)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: "17px", fontWeight: 700 }}>{(T as Record<string, string>)[p]}</span>
                  <span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{done.length + " of " + all.length + " jobs done today"}</span>
                </span>
                <span style={{ textAlign: "right", flex: "none", maxWidth: "42%" }}>
                  <span style={{ display: "block", fontSize: "22px", fontWeight: 700 }}>{nf(out)}</span>
                  <span style={{ display: "block", fontSize: "12px", color: "#6B7385" }}>{unit}</span>
                </span>
              </div>
              {p === "filling" && <div style={{ fontSize: "13px", color: "#3D4453", marginTop: "8px" }}>{rej + " rejected · " + (out ? ((out / (out + rej)) * 100).toFixed(1) : "0") + "% accepted"}</div>}
              <div style={{ marginTop: "10px", borderTop: "1px solid #F3F4F7" }}>
                {Object.keys(ppl).map((k) => (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 0", borderBottom: "1px solid #F3F4F7" }}>
                    <span style={this.av(k, 36)}>{this.ini(k)}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: "15px", lineHeight: "20px", fontWeight: 700 }}>{this.name(k)}</span>
                      <span style={{ display: "block", fontSize: "13px", lineHeight: "18px", color: "#6B7385" }}>{ppl[k].role + (db.emp[k]?.confirm ? " · name to confirm" : "")}</span>
                      <span style={{ display: "block", fontSize: "13px", lineHeight: "18px", color: "#3D4453" }}>{"In " + ppl[k].done + " of " + ppl[k].jobs + " jobs · " + (db.hours[k] != null ? db.hours[k] + " h" : "no check-in")}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  renderMachines(): ReactNode {
    const st = this.state, db = this.db(), tasks = this.tasks();
    const D = db.down;
    const keys = Object.keys(D);
    const tot = keys.reduce((a, k) => a + D[k], 0);
    const mx = Math.max(1, ...keys.map((k) => D[k]));
    const icon = (l: string) => (DOWN.find((x) => x[0] === l) || [0, "clock"])[1] as string;
    const fil = tasks.filter((t) => t.proc === "filling" && t.status === "done");
    const good = fil.reduce((a, t) => a + (t.out?.good ?? 0), 0), rej = fil.reduce((a, t) => a + (t.out?.rej || 0), 0);
    const pend = st.queue.filter((x) => x.status === "pending").length;
    const noHelp = tasks.filter((t) => t.status === "done" && !t.team.helpers.length).length;
    const row = (l: string, v: string, warn: boolean) => (
      <div key={l} style={{ display: "flex", justifyContent: "space-between", gap: "10px", padding: "10px 0", borderTop: "1px solid #F3F4F7", fontSize: "15px" }}>
        <span style={{ color: "#3D4453" }}>{l}</span>
        <span style={{ fontWeight: 700, color: warn ? "#8A5C05" : "#1A1E28" }}>{v}</span>
      </div>
    );
    const tol = db.review.filter((x) => x.kind === "tolerance").length;
    return (
      <div className="fx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 20px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ ...card, padding: "14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: "17px", fontWeight: 700 }}>Machine stops · this week</span>
            <span style={{ fontSize: "15px", fontWeight: 700 }}>{Math.floor(tot / 60) + " h " + (tot % 60) + " min"}</span>
          </div>
          <div style={{ fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>Biggest cause first. Planned cleaning is counted separately in ERP.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "12px" }}>
            {!keys.length && <div style={{ fontSize: "14px", color: "#6B7385" }}>No machine stops recorded this week.</div>}
            {keys.sort((a, b) => D[b] - D[a]).map((l) => (
              <div key={l}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 600 }}>{ic(icon(l), 16)}{l}</span>
                  <span style={{ fontWeight: 700 }}>{D[l] + " min"}</span>
                </div>
                <div style={{ height: "10px", borderRadius: "5px", background: "#EDEFF3", marginTop: "5px", overflow: "hidden" }}><div style={{ height: "10px", width: Math.round((D[l] / mx) * 100) + "%", background: l === "Breakdown" || l === "Power cut" ? "#B3261E" : "#6835FB", borderRadius: "5px" }} /></div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ ...card, padding: "4px 14px" }}>
          <div style={{ fontSize: "17px", fontWeight: 700, padding: "10px 0 4px 0" }}>Quality · today</div>
          {row("Filling · accepted", good + rej ? ((good / (good + rej)) * 100).toFixed(1) + "%" : "—", false)}
          {row("Filling · rejected", nf(rej) + " cans", rej > 0)}
          {row("Mixing outside limit", tol + " batch", tol > 0)}
        </div>
        <div style={{ ...card, padding: "4px 14px" }}>
          <div style={{ fontSize: "17px", fontWeight: 700, padding: "10px 0 4px 0" }}>Data checks</div>
          {row("Waiting to send", String(pend), pend > 0)}
          {row("Double taps blocked", String(db.dup), false)}
          {row("Corrections", String(db.corr), false)}
          {row("Jobs with no helper", String(noHelp), noHelp > 0)}
          {row("Picked by photo", String(db.review.filter((x) => x.kind === "manual").length), false)}
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- sheets */

  renderSheet(): ReactNode {
    const st = this.state, T = this.T(), sh = st.sheet!;
    const close = () => this.setState({ sheet: null });
    let title = "", sub = "", body: ReactNode = null, acts: { l: string; run: () => void; style: CSSProperties }[] = [];

    if (sh.type === "kp") {
      const v = sh.v;
      const n = v === "" ? null : Number(v);
      const err = n != null && sh.max != null && n > sh.max ? sh.maxL || "Maximum " + nf(sh.max) : "";
      title = sh.l;
      sub = sh.sub ?? "";
      body = (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "10px", height: "80px", padding: "0 18px", borderRadius: "18px", border: "2px solid " + (err ? "#B3261E" : "#6835FB"), background: "#F7F4FF", cursor: "text" }}>
            <input key={sh.l} value={v} onChange={(e) => this.setState({ sheet: { ...sh, v: sh.decimals ? String(e.target.value).replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 7) : String(e.target.value).replace(/[^\d]/g, "").slice(0, 6) } })} inputMode={sh.decimals ? "decimal" : "numeric"} autoFocus placeholder="0" aria-label={sh.l} style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: "40px", fontWeight: 700, color: "#1A1E28", textAlign: "right" }} />
            <span style={{ fontSize: "18px", color: "#6B7385", flex: "none" }}>{sh.unit}</span>
          </label>
          {err && <div style={{ fontSize: "15px", lineHeight: "21px", fontWeight: 700, color: "#B3261E", textAlign: "center" }}>{err}</div>}
          {!!sh.quick?.length && (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
              {sh.quick.map((q) => <button key={q.l} onClick={() => this.setState({ sheet: { ...sh, v: String(q.v) } })} style={{ height: "44px", padding: "0 16px", borderRadius: "22px", border: "1.5px solid #DDD2FF", background: "#F7F4FF", color: "#3D14A8", fontSize: "15px", fontWeight: 700, cursor: "pointer" }}>{q.l}</button>)}
            </div>
          )}
        </div>
      );
      acts = [
        { l: T.back, run: sh.back ?? close, style: { ...btn("s", 58), flex: 1 } },
        { l: T.ok, run: () => { if (err) return; if (n == null || (n <= 0 && !sh.allowZero)) return this.toast("Enter a number more than 0"); this.setState({ sheet: null }); sh.set(n); }, style: { ...btn(err || n == null ? "off" : "p", 58), flex: 2 } },
      ];
    }

    if (sh.type === "people") {
      const db = this.db();
      const RL = { owner: "Who is in charge?", op: "Who ran the machine?", helpers: "Who helped? Choose all", ver: "Who checked the work?" };
      const pool = Object.keys(db.emp)
        .filter((k) => db.emp[k].area !== "head" || sh.role === "ver" || sh.role === "owner")
        .sort((a, b) => Number(worksIn(db.emp[b], sh.area)) - Number(worksIn(db.emp[a], sh.area)));
      title = RL[sh.role];
      sub = sh.multi ? "Tap everyone who helped. Tap again to remove." : "Tap one person.";
      body = (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "10px" }}>
            {pool.map((k) => {
              const on = sh.sel.indexOf(k) > -1;
              return (
                <button key={k} onClick={() => this.setState({ sheet: { ...sh, sel: sh.multi ? (on ? sh.sel.filter((z) => z !== k) : sh.sel.concat([k])) : [k] } })} style={{ position: "relative", background: on ? "#F7F4FF" : "#FFFFFF", border: on ? "3px solid #6835FB" : "1px solid #DDE1E8", borderRadius: "16px", padding: "12px 4px", display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", cursor: "pointer", minHeight: "116px" }}>
                  <span style={this.av(k, 52)}>{this.ini(k)}</span>
                  <span style={{ fontSize: "15px", fontWeight: 700, lineHeight: "18px", textAlign: "center" }}>{db.emp[k].n.split(" ")[0]}</span>
                  <span style={{ fontSize: "11px", color: "#6B7385", lineHeight: "14px", textAlign: "center" }}>{db.emp[k].role.split(" · ")[0]}</span>
                  {on && <span style={{ position: "absolute", top: "8px", right: "8px", width: "24px", height: "24px", borderRadius: "50%", background: "#6835FB", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic("check", 18, "#FFFFFF")}</span>}
                </button>
              );
            })}
          </div>
          {Object.values(db.emp).some((e) => e.confirm) && <MsgBox m={msg("Some names are still being checked by HR.", "info")} />}
        </>
      );
      acts = [
        { l: T.back, run: close, style: { ...btn("s", 58), flex: 1 } },
        {
          l: T.ok,
          run: () => {
            const sel = sh.sel;
            if (!sh.multi && !sel.length && sh.role !== "ver") return;
            this.setState({ sheet: null });
            if (sh.onDone) return sh.onDone(sel);
            this.setD((z) => { if (sh.role === "helpers") z.team.helpers = sel; else z.team[sh.role as "owner"] = sel[0] || null; });
          },
          style: { ...btn(sh.multi || sh.sel.length || sh.role === "ver" ? "p" : "off", 58), flex: 2 },
        },
      ];
    }

    if (sh.type === "tiles") {
      title = sh.title;
      sub = sh.sub ?? "";
      const empty = !sh.groups.some((g) => g.items.length);
      body = (
        <>
          {sh.groups.map((g, gi) => (
            <div key={gi}>
              {g.title && <div style={{ fontSize: "14px", fontWeight: 700, color: "#3D4453", marginBottom: "8px" }}>{g.title}</div>}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(" + (g.cols || 2) + ",minmax(0,1fr))", gap: "10px" }}>
                {g.items.map((t) => (
                  <button key={t.v} onClick={() => sh.pick(t.v)} style={{ padding: "12px 8px", borderRadius: "16px", border: "1px solid #DDE1E8", background: "#FFFFFF", cursor: "pointer", textAlign: "center" }}>
                    {t.art && <span style={{ display: "flex", justifyContent: "center" }}>{t.art}</span>}
                    <span style={{ display: "block", fontSize: "15px", fontWeight: 700, lineHeight: "20px" }}>{t.l}</span>
                    {t.sub && <span style={{ display: "block", fontSize: "12px", color: "#6B7385", marginTop: "2px" }}>{t.sub}</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {empty && <MsgBox m={msg("Nothing is here. Ask the store team.", "warn")} />}
        </>
      );
      acts = [{ l: T.back, run: close, style: btn("s", 56) }];
    }

    if (sh.type === "reason") {
      title = sh.title;
      sub = sh.sub ?? "";
      body = (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {sh.reasons.map((r) => <button key={r} onClick={() => this.setState({ sheet: { ...sh, sel: r } })} style={{ minHeight: "58px", padding: "12px 16px", borderRadius: "14px", border: sh.sel === r ? "3px solid #6835FB" : "1px solid #DDE1E8", background: sh.sel === r ? "#F7F4FF" : "#FFFFFF", textAlign: "left", cursor: "pointer", fontSize: "15px", fontWeight: 700, lineHeight: "20px" }}>{r}</button>)}
        </div>
      );
      acts = [
        { l: T.back, run: close, style: { ...btn("s", 58), flex: 1 } },
        { l: st.busy ? T.sending : sh.okL || "Send", run: () => { if (sh.sel && !st.busy) sh.done(sh.sel); }, style: { ...btn(sh.sel && !st.busy ? (sh.danger ? "d" : "p") : "off", 58), flex: 2 } },
      ];
    }

    if (sh.type === "dept") {
      const me = st.me!, cur = this.dept();
      title = T.whichWork;
      sub = T.whichWorkSub;
      const row = (p: Proc | null) => {
        const on = cur === p;
        const n = this.tasks().filter((t) => t.status !== "done" && inDept(me, p, t.proc)).length;
        const tint = p ? DEPT_TINT[p] : ["#F1ECFF", "#3D14A8"];
        return (
          <button key={p ?? "all"} onClick={() => this.pickDept(p)} aria-pressed={on} style={{ display: "flex", alignItems: "center", gap: "14px", minHeight: "76px", padding: "12px 14px", borderRadius: "18px", border: on ? "3px solid #6835FB" : "1px solid #DDE1E8", background: on ? "#F7F4FF" : "#FFFFFF", textAlign: "left", cursor: "pointer" }}>
            <span style={{ width: "52px", height: "52px", flex: "none", borderRadius: "14px", background: tint[0], color: tint[1], display: "flex", alignItems: "center", justifyContent: "center" }}>{ic(p ? PC[p] : "list", 28)}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: "18px", lineHeight: "23px", fontWeight: 700 }}>{p ? (T as Record<string, string>)[p] : T.allWork}</span>
              <span style={{ display: "block", fontSize: "14px", color: n ? "#3D4453" : "#6B7385", marginTop: "2px" }}>{n ? n + " " + T.jobsOpen : T.noneOpen}</span>
            </span>
            {on && <span style={{ width: "28px", height: "28px", flex: "none", borderRadius: "50%", background: "#6835FB", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic("check", 18, "#FFFFFF")}</span>}
          </button>
        );
      };
      body = (
        <>
          {row(null)}
          {myDepts(me).map((p) => row(p))}
        </>
      );
      acts = [{ l: T.back, run: close, style: btn("s", 56) }];
    }

    if (sh.type === "job") body = this.jobSheet(sh.id, (t, s, b, a) => { title = t; sub = s; acts = a; return b; });
    if (sh.type === "assign") body = this.assignSheet((t, s, b, a) => { title = t; sub = s; acts = a; return b; });
    if (sh.type === "start") body = this.startSheet((t, s, b, a) => { title = t; sub = s; acts = a; return b; });
    if (sh.type === "recipe") body = this.recipeSheet(sh, (t, s, b, a) => { title = t; sub = s; acts = a; return b; });

    return (
      <div onClick={close} style={{ position: "absolute", inset: 0, background: "rgba(14,16,22,0.5)", zIndex: 40, display: "flex", alignItems: "flex-end" }}>
        <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title} style={{ width: "100%", maxHeight: "92%", background: "#FFFFFF", borderRadius: "26px 26px 0 0", display: "flex", flexDirection: "column", animation: "fx-up 200ms cubic-bezier(0.2,0,0.2,1)" }}>
          <div style={{ width: "44px", height: "5px", borderRadius: "3px", background: "#DDE1E8", margin: "10px auto 0 auto", flex: "none" }} />
          <div style={{ padding: "12px 20px 6px 20px", flex: "none" }}>
            <div style={{ fontSize: "21px", lineHeight: "27px", fontWeight: 700 }}>{title}</div>
            {sub && <div style={{ fontSize: "15px", lineHeight: "21px", color: "#6B7385", marginTop: "4px" }}>{sub}</div>}
          </div>
          <div className="fx-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 20px 14px 20px", display: "flex", flexDirection: "column", gap: "12px" }}>{body}</div>
          {acts.length > 0 && (
            <div style={{ flex: "none", padding: "12px 20px 18px 20px", borderTop: "1px solid #EDEFF3", display: "flex", gap: "10px" }}>
              {acts.map((a) => <button key={a.l} onClick={a.run} style={a.style}>{a.l}</button>)}
            </div>
          )}
        </div>
      </div>
    );
  }

  jobSheet(id: string, out: (title: string, sub: string, body: ReactNode, acts: { l: string; run: () => void; style: CSSProperties }[]) => ReactNode): ReactNode {
    const st = this.state, T = this.T(), db = this.db();
    const t = this.task(id);
    if (!t) return out("Job", "", <MsgBox m={msg("This job is not on today's list any more.", "warn")} />, [{ l: "Close", run: () => this.setState({ sheet: null }), style: btn("s", 56) }]);
    const js = jobStatus(t, this.now(), !!st.started[t.id]);
    const tm = t.team;
    const done = t.status === "done";
    const pick = (role: PeopleSheet["role"], multi?: boolean) =>
      done ? undefined : () =>
        this.setState({
          sheet: {
            type: "people", role, multi: !!multi, sel: multi ? tm.helpers.slice() : ([tm[role as "owner"]].filter(Boolean) as string[]), area: t.proc,
            onDone: (sel) => void this.headCall(call("changeTeam", t.id, role, sel), () => this.setState({ sheet: { type: "job", id: t.id } })),
          },
        });
    const rows: { l: string; v: string; run?: () => void }[] = [{ l: "Target", v: taskTarget(db, t) }, { l: "Due", v: t.due }];
    if (done) rows.push({ l: "Output", v: nf(t.out?.good) + " " + t.out?.unit + (t.out?.rej ? " · " + t.out.rej + " rejected" : "") }, { l: "Lot", v: t.out?.lot || "—" });
    rows.push({ l: "Responsible", v: this.name(tm.owner), run: pick("owner") }, { l: t.proc === "dispatch" ? "Lead loader" : "Operator", v: this.name(tm.op), run: pick("op") }, { l: "Helpers", v: tm.helpers.length ? tm.helpers.map((k) => this.name(k)).join(", ") : "None", run: pick("helpers", true) });
    const audit = db.audit.filter((a) => a.task === t.id);
    const close = () => this.setState({ sheet: null });
    const askCorrection = () =>
      this.setState({
        sheet: {
          type: "reason", title: "What needs correcting?", sub: t.id + " · the saved record is not changed until this is approved.",
          reasons: ["Output count was wrong", "Rejected count was wrong", "Wrong team recorded", "Wrong lot recorded"], okL: "Send for approval",
          done: (rr) => {
            if (rr === "Rejected count was wrong" && t.proc === "filling") {
              const filled = (t.out?.good ?? 0) + (t.out?.rej ?? 0);
              return this.openKp({ l: "How many are really bad?", unit: t.out?.unit ?? "cans", v: t.out?.rej ?? 0, max: filled, maxL: "Cannot be more than filled", allowZero: true, set: (v) => void this.headCall(call("requestCorrection", t.id, rr, taskName(db, t), v), close) });
            }
            void this.headCall(call("requestCorrection", t.id, rr, taskName(db, t), null), close);
          },
        },
      });
    const body = (
      <>
        <div style={{ background: "#F7F8FA", borderRadius: "16px", padding: "2px 14px" }}>
          {rows.map((r) => (
            <button key={r.l} onClick={r.run ?? (() => {})} style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", padding: "12px 0", border: "none", borderTop: "1px solid #EDEFF3", background: "transparent", cursor: r.run ? "pointer" : "default" }}>
              <span style={{ flex: 1, fontSize: "14px", color: "#6B7385", textAlign: "left" }}>{r.l}</span>
              <span style={{ fontSize: "16px", fontWeight: 700, textAlign: "right" }}>{r.v}</span>
              {r.run && <span style={{ color: "#9BA3B2", display: "flex" }}>{ic("chev", 24)}</span>}
            </button>
          ))}
        </div>
        <MsgBox m={done ? msg("This job is saved in ERP. To change it, ask for a correction — the original stays in the history.", "info") : msg("You can change the team until the job is saved.", "info")} />
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#3D4453", marginBottom: "6px" }}>History · cannot be changed</div>
          {!audit.length && <div style={{ fontSize: "14px", color: "#6B7385", padding: "8px 0" }}>Nothing yet.</div>}
          {audit.map((a, i) => (
            <div key={i} style={{ display: "flex", gap: "10px", padding: "8px 0", borderTop: "1px solid #F3F4F7", fontSize: "14px", lineHeight: "20px" }}>
              <span style={{ color: "#6B7385", width: "44px", flex: "none" }}>{a.at}</span>
              <span style={{ flex: 1 }}><span style={{ fontWeight: 700 }}>{a.who}</span> · {a.t}</span>
            </div>
          ))}
        </div>
      </>
    );
    return out(taskName(db, t), (T as Record<string, string>)[t.proc] + " · " + t.id + " · " + js[0], body, done ? [{ l: "Close", run: close, style: { ...btn("s", 56), flex: 1 } }, { l: "Ask for correction", run: askCorrection, style: { ...btn("p", 56), flex: 2, fontSize: "16px" } }] : [{ l: "Close", run: close, style: btn("s", 56) }]);
  }

  /**
   * A mixing worker starting a batch himself: the base and how many batches,
   * nothing else. The server checks the recipe again and puts him in charge;
   * the job then opens straight into its batch sheet.
   */
  /** The recipe editor, opened with what this job's first step shows — the batch sheet, or the worker's own recipe. */
  openRecipe(lines: { item: string; per: number }[]) {
    this.setState({ sheet: { type: "recipe", lines: lines.map((l) => ({ item: l.item, per: l.per })), adding: false, q: "" } });
  }

  /** Back to the ERP's batch sheet: the drums are asked for again from it. */
  useBatchSheet(t: Task) {
    this.setD((z) => {
      z.rm = recipeRm(recipeLines(this.db(), t, null));
      delete z.ownRecipe;
    });
    this.toast("Back to the batch sheet");
  }

  recipeSheet(sh: RecipeSheet, out: (title: string, sub: string, body: ReactNode, acts: { l: string; run: () => void; style: CSSProperties }[]) => ReactNode): ReactNode {
    const T = this.T(), db = this.db(), f = this.state.flow;
    const close = () => this.setState({ sheet: null });
    if (!f || f.task.proc !== "mixing") return out("Your recipe", "", <MsgBox m={msg("Open the mixing job again.", "warn")} />, [{ l: T.back, run: close, style: { ...btn("s", 56), flex: 1 } }]);
    const t = f.task, d = f.d;
    const put = (p: Partial<RecipeSheet>) => this.setState({ sheet: { ...sh, ...p } });
    const nb = d.batches ?? t.batches ?? 1;
    if (sh.adding) {
      const q = (sh.q ?? "").trim().toLowerCase();
      const used = new Set(sh.lines.map((l) => l.item));
      const here: Record<string, number> = {};
      for (const x of Object.values(db.lots)) if (x.type === "rm" && x.loc === db.loc && x.status === "ok" && x.avail > 0) here[x.item] = (here[x.item] ?? 0) + x.avail;
      const all = Object.keys(db.rm)
        .filter((k) => !q || db.rm[k].n.toLowerCase().includes(q) || db.rm[k].code.toLowerCase().includes(q))
        .sort((a, b) => db.rm[a].n.localeCompare(db.rm[b].n));
      const tile = (k: string) => {
        const inIt = used.has(k);
        return (
          <button key={k} onClick={() => (inIt ? undefined : put({ adding: false, q: "", lines: [...sh.lines, { item: k, per: null }] }))} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "10px", borderRadius: "14px", border: "1px solid #DDE1E8", background: "#FFFFFF", cursor: inIt ? "default" : "pointer", textAlign: "left", opacity: inIt ? 0.45 : 1, minWidth: 0 }}>
            <span style={{ flex: "none", display: "flex" }}>{art("rm", db.rm[k].col, db.rm[k].code, 40)}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: "15px", fontWeight: 700, lineHeight: "19px" }}>{db.rm[k].n}</span>
              <span style={{ display: "block", fontSize: "12px", color: "#6B7385", marginTop: "2px" }}>{inIt ? "In your recipe" : here[k] ? nf(here[k]) + " L here" : "None here"}</span>
            </span>
          </button>
        );
      };
      const group = (title: string, keys: string[]) =>
        keys.length > 0 && (
          <div>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "#6B7385", marginBottom: "8px" }}>{title}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>{keys.map(tile)}</div>
          </div>
        );
      const inStock = all.filter((k) => here[k]), rest = all.filter((k) => !here[k]);
      const body = (
        <>
          <input value={sh.q ?? ""} onChange={(e) => put({ q: String(e.target.value) })} autoFocus placeholder="Search materials" aria-label="Search materials" style={{ height: "52px", borderRadius: "14px", border: "2px solid #6835FB", background: "#F7F4FF", padding: "0 14px", fontSize: "17px", outline: "none", color: "#1A1E28" }} />
          {group("In stock here", inStock)}
          {group(inStock.length ? "Not at this godown" : "All materials", rest)}
          {!all.length && <MsgBox m={msg("No material matches \u201c" + (sh.q ?? "") + "\u201d.", "info")} />}
        </>
      );
      return out("Add a material", "Every raw material in the ERP. One already in your recipe is greyed out.", body, [{ l: T.back, run: () => put({ adding: false, q: "" }), style: { ...btn("s", 56), flex: 1 } }]);
    }
    const lines = sh.lines;
    const sheetLines = recipeLines(db, t, null);
    const onSheet = new Set(sheetLines.map((l) => l.item));
    const problem = recipeProblem(lines, db.rm);
    const total = batchLitres(lines), sheetTotal = batchLitres(sheetLines);
    const same = lines.length === sheetLines.length && lines.every((l, i) => l.item === sheetLines[i].item && l.per === sheetLines[i].per);
    const use = () => {
      if (problem) return this.toast(problem, "warn");
      const done = lines as { item: string; per: number }[];
      this.setState({ sheet: null });
      this.setD((z) => {
        z.rm = recipeRm(done);
        if (same) delete z.ownRecipe;
        else z.ownRecipe = true;
      });
      this.toast(same ? "Back to the batch sheet" : "Your recipe is set for this batch");
    };
    const body = (
      <>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {lines.map((l, i) => {
            const m = db.rm[l.item];
            const nm = m?.n ?? l.item;
            return (
              <div key={l.item} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "10px 0", borderTop: i ? "1px solid #F3F4F7" : "none" }}>
                <span style={{ width: "12px", height: "12px", borderRadius: "3px", flex: "none", background: m?.col ?? "#3D4453" }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: "16px", fontWeight: 600 }}>
                  {nm}
                  {!onSheet.has(l.item) && <span style={{ marginLeft: "6px", fontSize: "11px", fontWeight: 700, color: "#8A5C05", background: "#FDF6E7", borderRadius: "8px", padding: "2px 6px" }}>added</span>}
                </span>
                <button
                  onClick={() => this.openKp({ l: "Litres of " + nm + " for 1 batch", unit: "L", v: l.per, decimals: true, back: () => this.setState({ sheet: sh }), set: (v) => this.setState({ sheet: { ...sh, lines: lines.map((x, j) => (j === i ? { ...x, per: v } : x)) } }) })}
                  style={{ flex: "none", minWidth: "84px", height: "40px", padding: "0 12px", borderRadius: "10px", border: "1.5px solid " + (l.per ? "#D9CCFF" : "#F6CFCF"), background: l.per ? "#F1ECFF" : "#FFFFFF", color: l.per ? "#1A1E28" : "#B3261E", fontSize: l.per ? "16px" : "14px", fontWeight: l.per ? 800 : 700, textAlign: "right", cursor: "pointer" }}
                >
                  {l.per ? nf(l.per) + " L" : "Enter L"}
                </button>
                <button onClick={() => put({ lines: lines.filter((_, j) => j !== i) })} aria-label={"Take " + nm + " off"} style={{ flex: "none", width: "36px", height: "36px", borderRadius: "50%", border: "none", background: "#F7F8FA", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>{ic("x", 18, "#6B7385")}</button>
              </div>
            );
          })}
        </div>
        <button onClick={() => put({ adding: true, q: "" })} style={{ height: "50px", borderRadius: "14px", border: "1.5px dashed #B9A5FF", background: "#FFFFFF", color: "#3D14A8", fontSize: "16px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", cursor: "pointer" }}>{ic("plus", 20, "#3D14A8")}Add a material</button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#F7F8FA", borderRadius: "14px", padding: "12px 14px" }}>
          <span style={{ fontSize: "15px", color: "#3D4453" }}>One batch makes</span>
          <span style={{ fontSize: "16px", fontWeight: 700 }}>{nf(total) + " L"}<span style={{ fontWeight: 500, color: "#6B7385" }}>{"  (sheet " + nf(sheetTotal) + " L)"}</span></span>
        </div>
        {problem && <MsgBox m={msg(problem, "warn")} />}
      </>
    );
    return out("Your recipe", "Litres for 1 batch" + (nb > 1 ? " — you are making " + nb + " batches" : "") + ". Your supervisor will see that you changed the recipe.", body, [
      { l: "Cancel", run: close, style: { ...btn("s", 58), flex: 1 } },
      { l: "Use this recipe", run: use, style: { ...btn(problem ? "off" : "p", 58), flex: 2 } },
    ]);
  }

  startSheet(out: (title: string, sub: string, body: ReactNode, acts: { l: string; run: () => void; style: CSSProperties }[]) => ReactNode): ReactNode {
    const st = this.state, T = this.T(), db = this.db();
    const a = st.asg && st.asg.proc === "mixing" ? st.asg : this.defaultAsg("mixing");
    const bases = Object.keys(db.sfg).filter((k) => db.sfg[k].recipe.length);
    const tile = (on: boolean): CSSProperties => ({ padding: "10px 6px", borderRadius: "14px", border: on ? "3px solid #6835FB" : "1px solid #DDE1E8", background: on ? "#F7F4FF" : "#FFFFFF", cursor: "pointer", textAlign: "center" });
    const sf = db.sfg[a.item];
    const start = async () => {
      if (st.busy || !sf) return;
      this.setState({ busy: true });
      try {
        const r = await call("startBatch", { item: a.item, qty: a.qty });
        if (!r.ok) return this.toast(r.error);
        this.setState({ db: r.data, sheet: null }, () => this.startTask(r.id));
      } catch {
        this.toast("No network. Try again when it is back.");
      } finally {
        this.setState({ busy: false });
      }
    };
    const body = (
      <>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#3D4453", marginBottom: "8px" }}>Base</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
            {bases.map((k) => (
              <button key={k} onClick={() => this.setState({ asg: { ...a, item: k } })} style={tile(a.item === k)}>
                <span style={{ display: "flex", justifyContent: "center" }}>{art("tank", db.sfg[k].col, db.sfg[k].short, 48)}</span>
                <span style={{ display: "block", fontSize: "15px", fontWeight: 700, lineHeight: "20px" }}>{db.sfg[k].short + " base"}</span>
              </button>
            ))}
          </div>
        </div>
        {!bases.length && <MsgBox m={msg("No base has a recipe in the ERP yet. Ask the office to add one in ERP → Recipes.", "warn")} />}
        <div style={{ background: "#F7F8FA", borderRadius: "16px", padding: "2px 14px" }}>
          <button onClick={() => this.openKp({ l: "How many batches?", unit: "batches", v: a.qty, max: MIX_BATCH_MAX, set: (v) => this.setState({ sheet: { type: "start" }, asg: { ...a, qty: v } }) })} style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", padding: "12px 0", border: "none", background: "transparent", cursor: "pointer" }}>
            <span style={{ flex: 1, fontSize: "14px", color: "#6B7385", textAlign: "left" }}>How many</span>
            <span style={{ fontSize: "16px", fontWeight: 700, textAlign: "right" }}>{nf(a.qty) + " batches"}</span>
            <span style={{ color: "#9BA3B2", display: "flex" }}>{ic("chev", 24)}</span>
          </button>
        </div>
        {sf && <MsgBox m={msg(nf(a.qty) + " × " + nf(sf.batch) + " L of " + sf.n + ", from its batch sheet. You can change the recipe on the job\u2019s first step.", "info")} />}
      </>
    );
    return out("Start a mixing batch", "You will be in charge of it. Change the team on the job.", body, [
      { l: T.back, run: () => this.setState({ sheet: null }), style: { ...btn("s", 58), flex: 1 } },
      { l: st.busy ? T.sending : "Start batch", run: () => void start(), style: { ...btn(sf && !st.busy ? "p" : "off", 58), flex: 2 } },
    ]);
  }

  assignSheet(out: (title: string, sub: string, body: ReactNode, acts: { l: string; run: () => void; style: CSSProperties }[]) => ReactNode): ReactNode {
    const st = this.state, T = this.T(), db = this.db();
    const a = st.asg ?? this.defaultAsg(myDepts(st.me!).find((p) => p !== "dispatch") ?? "mixing");
    const set = (p: Partial<NonNullable<State["asg"]>>) => this.setState({ asg: { ...a, ...p } });
    const PR = ([["mixing", "flask"], ["filling", "fill"], ["packing", "box"]] as [Proc, string][]).filter(([k]) => myDepts(st.me!).includes(k));
    const items =
      a.proc === "mixing" ? Object.keys(db.sfg).filter((k) => db.sfg[k].recipe.length).map((k) => ({ v: k, l: db.sfg[k].short + " base", art: art("tank", db.sfg[k].col, db.sfg[k].short, 48) }))
      : a.proc === "filling" ? Object.keys(db.sku).map((k) => ({ v: k, l: db.sku[k].n.replace("Mahek ", "") + " " + db.sku[k].size, art: art(db.sku[k].kind, db.sku[k].col, db.sku[k].tag, 48) }))
      : Object.keys(db.box).map((k) => ({ v: k, l: db.sku[db.box[k].sku].size + " × " + db.box[k].cpb, art: art("box", db.sku[db.box[k].sku].col, db.box[k].cpb + "×" + db.sku[db.box[k].sku].tag, 48) }));
    const tile = (on: boolean, extra?: CSSProperties): CSSProperties => ({ padding: "10px 6px", borderRadius: "14px", border: on ? "3px solid #6835FB" : "1px solid #DDE1E8", background: on ? "#F7F4FF" : "#FFFFFF", cursor: "pointer", textAlign: "center", ...(extra ?? {}) });
    const unit = a.proc === "mixing" ? "batches" : a.proc === "filling" ? (db.sku[a.item]?.kind === "drum" ? "drums" : "cans") : "boxes";
    const tm = db.teams[a.proc];
    const teamL = [tm.owner, tm.op, ...tm.helpers].filter(Boolean).map((k) => this.name(k).split(" ")[0]).join(", ") || "Nobody set — change it on the job";
    const g = (title: string, cols: number, its: { k: string; l: string; art?: ReactNode; on: boolean; pick: () => void; extra?: CSSProperties }[]) => (
      <div key={title}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#3D4453", marginBottom: "8px" }}>{title}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(" + cols + ",minmax(0,1fr))", gap: "8px" }}>
          {its.map((t) => (
            <button key={t.k} onClick={t.pick} style={tile(t.on, t.extra)}>
              {t.art && <span style={{ display: "flex", justifyContent: "center" }}>{t.art}</span>}
              <span style={{ display: "block", fontSize: "15px", fontWeight: 700, lineHeight: "20px" }}>{t.l}</span>
            </button>
          ))}
        </div>
      </div>
    );
    const body = (
      <>
        {g("Work", 3, PR.map(([k, icn]) => ({ k, l: (T as Record<string, string>)[k], art: ic(icn, 26), on: a.proc === k, pick: () => this.setState({ asg: this.defaultAsg(k) }), extra: { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" } })))}
        {g("Product", 2, items.map((it) => ({ k: it.v, l: it.l, art: it.art, on: a.item === it.v, pick: () => set({ item: it.v }) })))}
        {!items.length && <MsgBox m={msg("Nothing is set up for this work in the ERP yet.", "warn")} />}
        {g("Due by", 4, ["12:00", "14:00", "16:00", "18:00"].map((d) => ({ k: d, l: d, on: a.due === d, pick: () => set({ due: d }), extra: { height: "48px" } })))}
        <div style={{ background: "#F7F8FA", borderRadius: "16px", padding: "2px 14px" }}>
          <button onClick={() => this.openKp({ l: "How many " + unit + "?", unit, v: a.qty, max: a.proc === "mixing" ? MIX_BATCH_MAX : 5000, set: (v) => this.setState({ sheet: { type: "assign" }, asg: { ...this.state.asg!, qty: v } }) })} style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", padding: "12px 0", border: "none", background: "transparent", cursor: "pointer" }}>
            <span style={{ flex: 1, fontSize: "14px", color: "#6B7385", textAlign: "left" }}>How many</span>
            <span style={{ fontSize: "16px", fontWeight: 700, textAlign: "right" }}>{nf(a.qty) + " " + unit}</span>
            <span style={{ color: "#9BA3B2", display: "flex" }}>{ic("chev", 24)}</span>
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", padding: "12px 0", borderTop: "1px solid #EDEFF3" }}>
            <span style={{ flex: 1, fontSize: "14px", color: "#6B7385", textAlign: "left" }}>Team</span>
            <span style={{ fontSize: "16px", fontWeight: 700, textAlign: "right" }}>{teamL}</span>
          </div>
        </div>
        {a.proc === "mixing" && db.sfg[a.item] && <MsgBox m={msg("Uses the approved batch sheet for " + db.sfg[a.item].n + ". The formula cannot be changed here.", "info")} />}
      </>
    );
    return out("Give a task", "It appears on the team’s phones straight away.", body, [
      { l: T.back, run: () => this.setState({ sheet: null }), style: { ...btn("s", 58), flex: 1 } },
      {
        l: st.busy ? T.sending : "Send task",
        run: () => {
          if (st.busy || !a.item) return;
          void this.headCall(call("assign", a), () => this.setState({ sheet: null, hf: "all" }));
        },
        style: { ...btn(a.item && !st.busy ? "p" : "off", 58), flex: 2 },
      },
    ]);
  }
}

type LotRow = {
  art: ReactNode;
  name: string;
  need: string;
  lot: string | null;
  manual?: boolean;
  scan: () => void;
  scanL?: string;
  qtyL?: string;
  qtyV?: string;
  qtyDone?: boolean;
  qtyOpen?: () => void;
  done?: boolean;
  err?: string;
  /** A line under the row — how much of the sheet this material still owes. */
  note?: string;
  /** Another drum of this material, for what this one could not give. */
  add?: () => void;
  /** Take off a drum the worker added. */
  remove?: () => void;
};

type QField = {
  l: string;
  v: number | null;
  unit: string;
  open: () => void;
  step?: boolean;
  minus?: () => void;
  plus?: () => void;
  sub?: string;
  err?: string;
};
