import { Component, type CSSProperties, type ReactNode } from "react";
import { AppState, BackHandler, Linking, type NativeEventSubscription } from "react-native";
import * as Speech from "expo-speech";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { L, STEP_T, type Lang, type Words } from "@/lib/factory/i18n";
import {
  jobStatus,
  lotName,
  lotUnit,
  mixDeviation,
  nf,
  resolveScan,
  stepCheck,
  taskCode,
  taskName,
  taskTarget,
  type ScanMeta,
  type ScanPurpose,
  type ScanResult,
} from "@/lib/factory/rules";
import { CHECK_ITEMS, DOWN, OFFLINE_HOURS, REJ, STEPS, SUBMISSION_VERSION, type Draft, type FactoryData, type Lot, type Proc, type SubmitResult, type Task, type Team } from "@/lib/factory/types";
import { hhmm } from "@/lib/factory/time";
import type { Me } from "./types";
import { APP_BUILD, call, dropSession, NotReceived, SITE, uploadPhoto } from "./api";
import { Btn, Div, Input, Root, Span } from "./web";
import { art, ic, qr } from "./art";
import { avStyle, btn, card, initials, mono, msg, MsgBox, Pill, artWell, type Msg } from "./kit";
import { CameraScanner, shrinkPhoto } from "./camera";
import { dropPhoto, forget, keepPhoto, keptPhoto, load, mintKey, readNet, save, watchNet, type Flow, type KpSheet, type Net, type PeopleSheet, type QItem, type ReasonSheet, type Res, type State, type TilesSheet } from "./model";

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
 *
 * THE NATIVE APP IS THE WEB APP'S SCREENS AND RULES, ON THE PHONE. This file
 * is src/app/factory/_ui/factory-app.tsx with its elements swapped for the
 * native ones in ./web.tsx and its browser parts (storage, camera, photo
 * files, speech, network, the back button) swapped for the phone's. Every
 * job goes through the same /api/factory/rpc op the web page sends, so the
 * ERP posting, the 48-hour window, the idempotency key and the Production
 * Head's review are the server's — decided once, for both.
 * ------------------------------------------------------------------------- */

type Props = Record<string, never>;
const DEV = typeof __DEV__ !== "undefined" && __DEV__;

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
  private ivs: ReturnType<typeof setInterval>[] = [];
  private tt: ReturnType<typeof setTimeout> | undefined;
  private ot: ReturnType<typeof setInterval> | undefined;
  private subs: { remove: () => void }[] = [];

  constructor(props: Props) {
    super(props);
    /* THE APP OPENS ON WHAT THIS PHONE LAST SAW, with or without a network:
       the person, their floor and their unsent work are all on the phone. */
    const me = load<Me | null>(null, "me", null);
    const data = me ? load<FactoryData | null>(me.key, "data", null) : null;
    const lang = load<Lang | null>(null, "lang", null);
    const signed = me && data ? me : null;
    this.state = {
      lang: signed?.lang ?? lang ?? "en",
      me: signed,
      db: signed ? data : null,
      signStep: lang ? "id" : "lang",
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
      route: signed?.head ? "today" : "home",
      scan: null,
      flow: null,
      result: null,
      sheet: null,
      net: "online",
      toast: "",
      play: null,
      hf: "all",
      asg: null,
      started: {},
      drafts: {},
      results: {},
      queue: [],
      sending: false,
      busy: false,
      clock: hhmm(new Date()),
      cam: "wait",
      ...(signed ? this.restore(signed.key) : null),
    };
  }

  /* ================================================================ life */

  componentDidMount() {
    this.subs.push({ remove: watchNet((n) => this.setNet(n)) });
    /* Back to the app after a call or a break: send what waited, fetch new work. */
    this.subs.push(AppState.addEventListener("change", (a) => {
      if (a === "active") {
        this.setState({ clock: hhmm(new Date()) });
        void this.flushQueue();
        void this.poll();
      }
    }));
    this.subs.push(BackHandler.addEventListener("hardwareBackPress", this.onBack) as NativeEventSubscription);
    this.ivs.push(setInterval(() => void this.flushQueue(), 30_000));
    this.ivs.push(setInterval(() => this.setState({ clock: hhmm(new Date()) }), 15_000));
    this.ivs.push(
      setInterval(() => {
        const p = this.state.play;
        if (p && p.on) this.setState({ play: { ...p, t: Math.min(p.t + 1, p.dur), on: p.t + 1 < p.dur } });
      }, 1000),
    );
    /* New work reaches the phone without anybody pressing anything. */
    this.ivs.push(setInterval(() => void this.poll(), 45_000));
    /* Signed in from yesterday: refresh the floor now, and send anything waiting. */
    if (this.state.me) void this.poll().then(() => this.flushQueue());
  }

  componentWillUnmount() {
    this.ivs.forEach((i) => clearInterval(i));
    clearTimeout(this.tt);
    clearInterval(this.ot);
    this.subs.forEach((x) => x.remove());
    try {
      void Speech.stop();
    } catch {}
  }

  /** The phone's back button walks back through what is open, the way the screen's own back does. */
  private onBack = () => {
    const st = this.state;
    if (st.sheet) return this.setState({ sheet: null }), true;
    if (st.scan) return this.setState({ scan: null }), true;
    if (st.result && st.result.kind !== "sending") return this.setState({ result: null, flow: null }), true;
    if (st.flow) {
      if (st.flow.step === 0) {
        this.setState({ flow: null, drafts: { ...st.drafts, [st.flow.task.id]: st.flow } });
        this.toast("Saved on this phone. Tap Continue to come back.");
      } else this.setState({ flow: { ...st.flow, step: st.flow.step - 1 } });
      return true;
    }
    if (st.me && st.signStep !== "newpin" && st.route !== (st.me.head ? "today" : "home")) return this.setState({ route: st.me.head ? "today" : "home" }), true;
    if (!st.me && (st.signStep === "pin" || st.signStep === "otp")) return this.setState({ signStep: "id", pinFor: null }), true;
    return false;
  };

  private restore(me: string) {
    return {
      queue: load<QItem[]>(me, "queue", []),
      drafts: load<Record<string, Flow>>(me, "drafts", {}),
      started: load<Record<string, 1>>(me, "started", {}),
      results: load<Record<string, SubmitResult>>(me, "results", {}),
    };
  }

  componentDidUpdate(_: Props, prev: State) {
    const me = this.state.me?.key ?? null;
    if (!me) return;
    if (prev.db !== this.state.db && this.state.db) save(me, "data", this.state.db);
    if (prev.me !== this.state.me) save(null, "me", this.state.me);
    if (prev.queue !== this.state.queue) save(me, "queue", this.state.queue);
    if (prev.drafts !== this.state.drafts) save(me, "drafts", this.state.drafts);
    if (prev.started !== this.state.started) save(me, "started", this.state.started);
    if (prev.results !== this.state.results) save(me, "results", this.state.results);
  }

  private setNet(n: Net) {
    this.setState({ net: n }, () => {
      if (n !== "offline") void this.flushQueue();
    });
  }

  private async poll() {
    const st = this.state;
    if (!st.me || st.net === "offline" || st.sending || st.busy) return;
    if (st.queue.some((x) => x.status === "pending")) return void this.flushQueue();
    try {
      const r = await call("bootstrap");
      if (r.ok) this.setState({ db: r.data });
      else if (r.error === "signedOut") this.setState({ me: null, db: null, signStep: "id" });
    } catch {
      this.setNet("offline");
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

  toast(t: string) {
    clearTimeout(this.tt);
    this.setState({ toast: t });
    this.tt = setTimeout(() => this.setState({ toast: "" }), 3200);
  }

  speak(text: string) {
    try {
      void Speech.stop();
      Speech.speak(text, { language: LANG_SPEECH[this.state.lang], rate: 0.92 });
      this.toast(this.T().listen + " · " + text.slice(0, 60) + (text.length > 60 ? "…" : ""));
    } catch {
      this.toast("Audio is not available on this phone");
    }
  }

  /** Today's work, with anything still waiting in this phone's queue shown as waiting. */
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
    this.ot = setInterval(() => {
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
    dropSession();
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
    if (P === "home") {
      const me = st.me!;
      this.tasks().filter((t) => (me.head || t.proc === me.area) && t.status !== "done").slice(0, 4).forEach((t) => add(taskCode(t), taskName(db, t).slice(0, 22), 1));
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

  async doScan(code: string, manual?: boolean) {
    const st = this.state, sc = st.scan;
    if (!sc || sc.res) return;
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
    const r = resolveScan(code, { db: this.db(), purpose: sc.purpose, meta: sc.meta, area: st.me?.head ? "head" : st.me?.area, task: st.flow?.task, d: st.flow?.d });
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
      this.setState({ flow: f, scan: null }, () => {
        const q = d.rm![m.idx!];
        const need = q.per * (d.batches ?? 1);
        this.openKp({
          l: "How much " + db.rm[q.item].n + " did you pour?", unit: "L", v: q.qty, max: x.avail, maxL: "Only " + nf(x.avail) + " L in this lot",
          quick: [{ l: "As on sheet · " + nf(need) + " L", v: need }],
          set: (v) => this.setD((dd) => { dd.rm = dd.rm!.map((z, i) => (i === m.idx ? { ...z, qty: v } : z)); }),
        });
      });
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

  manualPick() {
    const st = this.state, sc = st.scan!, P = sc.purpose, db = this.db(), f = st.flow!;
    const lots = Object.values(db.lots);
    let pool: Lot[] = [];
    if (P === "rm") pool = lots.filter((x) => x.type === "rm" && x.item === sc.meta.item);
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
    return stepCheck(this.db(), this.state.flow!.task, d, "output");
  }

  reviewVM(f: Flow) {
    const t = f.task, d = f.d, db = this.db(), T = this.T();
    const rv = { art: this.taskArt(t, 76), name: taskName(db, t), code: t.id, rows: [] as { l: string; v: string }[], warns: [] as Msg[], team: [] as { l: string; v: string }[], key: "" };
    const R = (l: string, v: string) => rv.rows.push({ l, v });
    if (t.proc === "mixing") {
      (d.rm ?? []).forEach((r) => R(db.rm[r.item].n + " · " + r.lot, nf(r.qty) + " L"));
      R("Batches", String(d.batches));
      R("Made", nf(d.out) + " L");
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
    return { key: f.key, taskId: f.task.id, d: f.d, savedAt: savedIso, v: SUBMISSION_VERSION, build: APP_BUILD, ...extra };
  }

  /**
   * A photo taken with no network is still on the phone, keyed by the job.
   * Upload it before the job goes, so the job reaches the server complete.
   * Throws NotReceived if it cannot — the job then waits with its photo.
   */
  private async withPhoto(f: Flow): Promise<Flow> {
    if (f.task.proc !== "dispatch" || f.d.photoId || !f.d.photo) return f;
    const uri = await keptPhoto(f.key);
    if (!uri) return f;
    const id = await uploadPhoto(uri); // throws NotReceived: the job waits with its photo
    if (!id) return f; // a photo the server will not take is not a reason to lose the job
    void dropPhoto(f.key);
    return { ...f, d: { ...f.d, photoId: id } };
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
    if (st.net === "offline") return this.enqueue(f, savedIso);
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
   * it never fails for want of a signal: with none, it waits as a file and
   * goes up just before its job does (`withPhoto`).
   */
  async pickPhoto() {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return this.toast("Allow the camera for this app, then take the photo again.");
      const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8, allowsEditing: false, exif: false });
      if (r.canceled || !r.assets?.[0]) return;
      await this.takePhoto(r.assets[0].uri);
    } catch {
      this.toast("The camera did not open. Try again.");
    }
  }

  async takePhoto(raw: string) {
    const f = this.state.flow;
    if (!f) return;
    const uri = await shrinkPhoto(raw);
    const at = this.now();
    const kept = await keepPhoto(f.key, uri);
    if (this.state.net !== "offline") {
      try {
        const id = await uploadPhoto(uri);
        if (id) {
          void dropPhoto(f.key);
          this.setD((z) => { z.photo = at; z.photoId = id; });
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

  /** The lot label prints from the label page, which the phone's browser sends to the printer. */
  printLabel(label: { code: string; name: string; meta: string }) {
    const q = [["code", label.code], ["name", label.name], ["meta", label.meta], ["loc", this.state.db?.loc ?? ""]].map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
    Linking.openURL(SITE + "/factory/label?" + q).then(
      () => this.toast("Label opened to print · " + label.code),
      () => this.toast("Open the label from a phone that can print"),
    );
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
    return (
      <SafeAreaInsetsContext.Consumer>
        {(ins) => (
      <Root style={{ backgroundColor: dark ? "#0E1016" : signing || isResult ? "#FFFFFF" : "#F7F8FA", paddingTop: ins?.top ?? 0, paddingBottom: ins?.bottom ?? 0 }}>
          <StatusBar style={dark ? "light" : "dark"} />
          {signing && this.renderSignin()}
          {shell && this.renderBar(head)}
          {shell && !head && R === "home" && this.renderHome()}
          {isScan && this.renderScan()}
          {isFlow && this.renderFlow()}
          {isResult && this.renderResult()}
          {shell && R === "sync" && this.renderSync()}
          {shell && R === "help" && this.renderHelp()}
          {shell && head && R === "today" && this.renderToday()}
          {shell && head && R === "review" && this.renderReview()}
          {shell && head && R === "teams" && this.renderTeams()}
          {shell && head && R === "machines" && this.renderMachines()}
          {shell && this.renderNav(head)}

          {st.sheet && me && this.renderSheet()}
          {st.toast && (
            <Div role="status" style={{ position: "absolute", left: "16px", right: "16px", bottom: "92px", zIndex: 60, display: "flex", alignItems: "center", gap: "10px", background: "#3D14A8", color: "#FFFFFF", borderRadius: "14px", padding: "14px 16px", fontSize: "15px", lineHeight: "20px", boxShadow: "0 8px 24px rgba(26,30,40,0.25)", animation: "fx-up 150ms cubic-bezier(0.2,0,0.2,1)" }}>
              <Span style={{ width: "24px", height: "24px", borderRadius: "50%", background: "rgba(198,255,52,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic("check", 15, "#C6FF34")}</Span>
              <Span style={{ flex: 1 }}>{st.toast}</Span>
            </Div>
          )}
      </Root>
        )}
      </SafeAreaInsetsContext.Consumer>
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
      <Div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <Span style={avStyle(who ? who.key.length : 0, 52)}>{who?.ini ?? "?"}</Span>
        <Span style={{ flex: 1, minWidth: 0 }}>
          <Span style={{ display: "block", fontSize: "18px", fontWeight: 700 }}>{who?.n}</Span>
          <Span style={{ display: "block", fontSize: "14px", color: "#6B7385" }}>{who?.ph ? "+91 " + who.ph.slice(0, 5) + " " + who.ph.slice(5) : ""}</Span>
        </Span>
        <Btn onClick={() => this.setState({ pinFor: null, pin: "", signStep: "id" })} style={{ height: "40px", padding: "0 4px", border: "none", background: "transparent", color: "#5223E0", fontSize: "15px", fontWeight: 600, cursor: "pointer" }}>{T.change}</Btn>
      </Div>
    );
    return (
      <Div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, background: "#FFFFFF" }}>
        <Div style={{ flex: "none", display: "flex", alignItems: "center", gap: "8px", padding: "20px 24px 0 24px" }}>
          <Span style={{ width: "22px", height: "22px", background: "#6835FB", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center" }}><Span style={{ width: "8px", height: "8px", background: "#C6FF34", borderRadius: "2px" }} /></Span>
          <Span style={{ fontSize: "15px", fontWeight: 700, letterSpacing: "0.02em", color: "#1A1E28" }}>MAHEK ONE</Span>
          <Span style={{ fontSize: "15px", color: "#6B7385" }}>Factory</Span>
        </Div>

        {step === "lang" && (
          <Div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "24px 20px 20px 20px", minHeight: 0 }}>
            <Div style={{ fontSize: "26px", lineHeight: "32px", fontWeight: 700 }}>Choose your language</Div>
            <Div style={{ fontSize: "17px", color: "#6B7385", marginTop: "4px" }}>भाषा चुनें · भाषा निवडा</Div>
            <Div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "22px" }}>
              {LG.map(([k, l, sh, sub]) => {
                const on = st.lang === k;
                return (
                  <Btn key={k} onClick={() => this.setState({ lang: k })} style={{ display: "flex", alignItems: "center", gap: "14px", width: "100%", height: "84px", padding: "0 16px", borderRadius: "18px", border: on ? "3px solid #6835FB" : "1.5px solid #DDE1E8", background: on ? "#F7F4FF" : "#FFFFFF", cursor: "pointer" }}>
                    <Span style={{ width: "52px", height: "52px", borderRadius: "14px", background: on ? "#6835FB" : "#F1ECFF", color: on ? "#FFFFFF" : "#5223E0", fontSize: "24px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{sh}</Span>
                    <Span style={{ flex: 1, textAlign: "left" }}>
                      <Span style={{ display: "block", fontSize: "22px", fontWeight: 700 }}>{l}</Span>
                      <Span style={{ display: "block", fontSize: "14px", color: "#6B7385" }}>{sub}</Span>
                    </Span>
                    <Span style={{ width: "24px", height: "24px", borderRadius: "50%", flex: "none", border: on ? "7px solid #6835FB" : "2px solid #C2C8D2", background: "#FFFFFF" }} />
                  </Btn>
                );
              })}
            </Div>
            <Btn onClick={() => { save(null, "lang", st.lang); this.setState({ signStep: "id" }); }} style={{ ...btn("p", 62), marginTop: "auto" }}>{T.next}</Btn>
          </Div>
        )}

        {step === "id" && (
          <Div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "56px 24px 24px 24px", minHeight: 0 }}>
            <Div style={{ fontSize: "30px", lineHeight: "36px", fontWeight: 700, color: "#1A1E28" }}>{T.signIn}</Div>
            <Div style={{ fontSize: "16px", lineHeight: "23px", color: "#6B7385", marginTop: "6px" }}>{T.yourMobile}</Div>
            <Div style={{ display: "flex", alignItems: "center", gap: "12px", height: "64px", marginTop: "28px", padding: "0 16px", borderRadius: "14px", border: "1.5px solid " + (st.idErr ? "#B3261E" : "#C2C8D2"), background: "#FFFFFF" }}>
              <Span style={{ fontSize: "18px", fontWeight: 600, color: "#6B7385" }}>+91</Span>
              <Span style={{ width: "1px", height: "28px", background: "#DDE1E8" }} />
              <Input value={p} onChange={(e) => this.setState({ phone: String(e.target.value).replace(/\D/g, "").slice(0, 10), idErr: "" })} onKeyDown={(e) => e.key === "Enter" && void this.idNext()} inputMode="numeric" autoComplete="tel" maxLength={10} placeholder="98502 20231" aria-label={T.yourMobile} style={{ flex: 1, minWidth: 0, height: "100%", border: "none", outline: "none", background: "transparent", fontSize: "24px", fontWeight: 600, letterSpacing: "0.03em", color: "#1A1E28" }} />
            </Div>
            {st.idErr && <Div style={{ fontSize: "15px", lineHeight: "21px", color: "#B3261E", fontWeight: 600, marginTop: "10px" }}>{st.idErr}</Div>}
            <Btn onClick={() => void this.idNext()} style={{ ...btn(ok10 && !st.busy ? "p" : "off", 58), marginTop: "16px" }}>{st.busy ? T.sending : T.cont}</Btn>
            <Btn onClick={() => this.openScan("badge")} style={{ height: "48px", marginTop: "8px", border: "none", background: "transparent", color: "#5223E0", fontSize: "16px", fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", cursor: "pointer" }}>{ic("badge", 24)}{T.scanBadge}</Btn>
            <Btn onClick={() => this.setState({ signStep: "lang" })} style={{ marginTop: "auto", height: "40px", border: "none", background: "transparent", color: "#6B7385", fontSize: "14px", fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", cursor: "pointer" }}>{ic("globe", 18)}{T.language} · {LG.find((x) => x[0] === st.lang)?.[1]}</Btn>
          </Div>
        )}

        {step === "otp" && (
          <Div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "28px 24px 20px 24px", minHeight: 0 }}>
            <Btn onClick={() => this.setState({ signStep: who?.hasPin ? "pin" : "id", otpErr: "" })} style={{ alignSelf: "flex-start", height: "40px", padding: "0 8px 0 0", border: "none", background: "transparent", color: "#5223E0", fontSize: "15px", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>{ic("back", 24)}{T.back}</Btn>
            <Div style={{ fontSize: "26px", lineHeight: "32px", fontWeight: 700, marginTop: "20px" }}>{T.smsCode}</Div>
            <Div style={{ fontSize: "16px", lineHeight: "23px", color: "#6B7385", marginTop: "6px" }}>
              {(st.otpTo ? "We sent a 6-digit code to " + st.otpTo + "." : "We are sending a 6-digit code to your phone.") + (who?.hasPin ? " You will set a new PIN after this." : " You will choose your PIN after this.")}
            </Div>
            <Input value={st.otp} onChange={(e) => { const q = String(e.target.value).replace(/\D/g, "").slice(0, 6); this.setState({ otp: q, otpErr: "" }); if (q.length === 6) void this.tryOtp(q); }} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus placeholder="______" aria-label={T.smsCode} style={{ ...pinBox(!!st.otpErr, "24px"), letterSpacing: "0.4em" }} />
            {st.otpErr && <Div style={{ fontSize: "15px", lineHeight: "21px", fontWeight: 600, color: "#B3261E", marginTop: "10px" }}>{st.otpErr}</Div>}
            <Btn onClick={() => void this.tryOtp(st.otp)} style={{ ...btn(st.otp.length === 6 && !st.busy ? "p" : "off", 58), marginTop: "16px" }}>{T.cont}</Btn>
            <Btn onClick={() => void this.sendCode()} style={{ alignSelf: "center", marginTop: "8px", height: "44px", border: "none", background: "transparent", color: st.otpT > 0 ? "#9BA3B2" : "#5223E0", fontSize: "15px", fontWeight: 700, cursor: st.otpT > 0 ? "default" : "pointer" }}>{st.otpT > 0 ? T.resendIn + " 0:" + String(st.otpT).padStart(2, "0") : T.resend}</Btn>
          </Div>
        )}

        {step === "pin" && (
          <Div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "28px 24px 20px 24px", minHeight: 0 }}>
            {head}
            <Div style={{ fontSize: "26px", lineHeight: "32px", fontWeight: 700, marginTop: "32px" }}>{T.enterPin}</Div>
            <Input type="password" value={st.pin} onChange={(e) => { const q = String(e.target.value).replace(/\D/g, "").slice(0, 4); this.setState({ pin: q, pinErr: "" }); if (q.length === 4) void this.tryPin(q); }} inputMode="numeric" autoComplete="current-password" maxLength={4} autoFocus placeholder="••••" aria-label={T.enterPin} style={pinBox(!!st.pinErr, "18px")} />
            <Div style={{ minHeight: "22px", marginTop: "10px", fontSize: "15px", fontWeight: 600, color: "#B3261E" }}>{st.pinErr}</Div>
            <Btn onClick={() => void this.sendCode(true)} style={{ alignSelf: "flex-start", height: "40px", padding: 0, border: "none", background: "transparent", color: "#5223E0", fontSize: "15px", fontWeight: 600, cursor: "pointer" }}>{T.forgotPin}</Btn>
            <Btn onClick={() => void this.tryPin(st.pin)} style={{ ...btn(st.pin.length === 4 && !st.busy ? "p" : "off", 58), marginTop: "16px" }}>{T.signIn}</Btn>
            <Div style={{ flex: 1 }} />
          </Div>
        )}

        {step === "newpin" && (
          <Div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "28px 24px 20px 24px", minHeight: 0 }}>
            <Div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <Span style={avStyle(st.me ? st.me.key.length : 0, 52)}>{st.me?.ini}</Span>
              <Span style={{ flex: 1, minWidth: 0 }}><Span style={{ display: "block", fontSize: "18px", fontWeight: 700 }}>{st.me?.n}</Span></Span>
            </Div>
            <Div style={{ fontSize: "26px", lineHeight: "32px", fontWeight: 700, marginTop: "32px" }}>{st.newPin1 ? "Type the same PIN again" : "Choose a new PIN"}</Div>
            <Div style={{ fontSize: "16px", lineHeight: "23px", color: "#6B7385", marginTop: "6px" }}>4 numbers. You will type it every time you sign in.</Div>
            <Input key={st.newPin1 ? "again" : "first"} type="password" value={st.newPin} onChange={(e) => { const q = String(e.target.value).replace(/\D/g, "").slice(0, 4); this.setState({ newPin: q, pinErr: "" }); if (q.length === 4) void this.tryNewPin(q); }} inputMode="numeric" autoComplete="new-password" maxLength={4} autoFocus placeholder="••••" aria-label="New PIN" style={pinBox(!!st.pinErr, "18px")} />
            <Div style={{ minHeight: "22px", marginTop: "10px", fontSize: "15px", fontWeight: 600, color: "#B3261E" }}>{st.pinErr}</Div>
            <Btn onClick={() => void this.tryNewPin(st.newPin)} style={{ ...btn(st.newPin.length === 4 && !st.busy ? "p" : "off", 58), marginTop: "16px" }}>{T.cont}</Btn>
            <Div style={{ flex: 1 }} />
          </Div>
        )}
      </Div>
    );
  }

  /* ---------------------------------------------------------------- the shell */

  renderBar(head: boolean): ReactNode {
    const st = this.state, T = this.T(), me = st.me!, db = this.db();
    const q = st.queue.filter((x) => x.status === "pending").length;
    const n = st.net;
    const c = q ? ["#FDF6E7", "#8A5C05", "#B77B08"] : n === "offline" ? ["#F7F8FA", "#3D4453", "#6B7385"] : n === "weak" ? ["#FDF6E7", "#8A5C05", "#B77B08"] : ["#E9F5EE", "#1D7A45", "#1D7A45"];
    const areaWord = (T as Record<string, string>)[me.area] ?? "";
    return (
      <Div style={{ flex: "none", display: "flex", alignItems: "center", gap: "10px", padding: "8px 16px 10px 16px", background: "#FFFFFF", borderBottom: "1px solid #EDEFF3" }}>
        <Btn onClick={() => this.setState({ sheet: { type: "menu" } })} aria-label="Menu" style={this.av(me.key, 44)}>{me.ini}</Btn>
        <Span style={{ flex: 1, minWidth: 0 }}>
          <Span style={{ display: "block", fontSize: "17px", fontWeight: 700, lineHeight: "22px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{me.n + (head && !me.scope ? "" : !areaWord ? "" : " · " + areaWord)}</Span>
          <Span style={{ display: "block", fontSize: "13px", color: "#6B7385", lineHeight: "17px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{db.loc + " · " + db.shift}</Span>
        </Span>
        <Btn onClick={() => this.setState({ route: "sync" })} style={{ height: "36px", padding: "0 12px", borderRadius: "18px", border: "none", background: c[0], color: c[1], fontSize: "13px", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", whiteSpace: "nowrap", flex: "none" }}>
          <Span style={{ width: "8px", height: "8px", borderRadius: "50%", background: c[2], animation: q ? "fx-pulse 1.4s ease-in-out infinite" : "none" }} />
          {q ? q + " · " + T.pending : (T as Record<string, string>)[n]}
        </Btn>
      </Div>
    );
  }

  renderNav(head: boolean): ReactNode {
    const st = this.state, T = this.T();
    const revN = st.db?.review.length ?? 0;
    const navW: [string, string, string][] = [["home", "home", T.home], ["scan", "qr", T.scan], ["help", "help", T.help]];
    const navH: [string, string, string][] = [["today", "list", T.today], ["review", "alert", T.review], ["scan", "qr", T.scan], ["teams", "people", T.teams], ["machines", "chart", T.machines]];
    return (
      <Div style={{ flex: "none", height: "78px", background: "#FFFFFF", borderTop: "1px solid #EDEFF3", display: "flex", alignItems: "center", justifyContent: "space-around", padding: "0 6px 8px 6px" }}>
        {(head ? navH : navW).map(([k, icn, l]) => {
          const on = st.route === k;
          const isScan = k === "scan";
          return (
            <Btn key={k} onClick={() => (isScan ? this.openScan("home") : this.setState({ route: k }))} style={{ flex: 1, height: "70px", border: "none", background: "transparent", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "4px", color: on ? "#5223E0" : "#6B7385", cursor: "pointer" }}>
              <Span style={isScan ? { width: "58px", height: "58px", marginTop: "-22px", borderRadius: "50%", background: "#6835FB", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 16px rgba(104,53,251,0.35)", position: "relative" } : { width: "48px", height: "30px", borderRadius: "15px", background: on ? "#F1ECFF" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                {ic(icn, isScan ? 28 : 24, isScan ? "#FFFFFF" : undefined)}
                {k === "review" && revN > 0 && <Span style={{ position: "absolute", top: "-4px", right: "-8px", minWidth: "18px", height: "18px", padding: "0 5px", borderRadius: "9px", background: "#B3261E", color: "#FFFFFF", fontSize: "11px", fontWeight: 700, lineHeight: "18px", textAlign: "center" }}>{revN}</Span>}
              </Span>
              <Span style={{ fontSize: "12px", fontWeight: 600 }}>{l}</Span>
            </Btn>
          );
        })}
      </Div>
    );
  }

  /* ---------------------------------------------------------------- home */

  renderHome(): ReactNode {
    const st = this.state, T = this.T(), me = st.me!, db = this.db();
    const now = this.now();
    const mine = this.tasks().filter((t) => t.proc === me.area);
    const open = mine.filter((t) => t.status !== "done");
    const done = mine.filter((t) => t.status === "done");
    const q = st.queue.filter((x) => x.status === "pending").length;
    return (
      <Div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 16px 24px 16px", display: "flex", flexDirection: "column", gap: "14px" }}>
        {q > 0 && (
          <Btn onClick={() => this.setState({ route: "sync" })} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 14px", border: "1px solid #F9E9C4", background: "#FDF6E7", borderRadius: "14px", color: "#8A5C05", fontSize: "15px", fontWeight: 600, textAlign: "left", cursor: "pointer" }}>
            {ic("clock", 22, "#8A5C05")}<Span style={{ flex: 1 }}>{q + " " + T.waitingSend}</Span>{ic("chev", 24)}
          </Btn>
        )}
        <Btn onClick={() => this.openScan("home")} style={{ background: "#6835FB", border: "none", borderRadius: "20px", padding: "18px 20px", color: "#FFFFFF", display: "flex", alignItems: "center", gap: "16px", textAlign: "left", cursor: "pointer", minHeight: "112px", boxShadow: "0 8px 20px rgba(104,53,251,0.28)" }}>
          <Span style={{ width: "76px", height: "76px", flex: "none", borderRadius: "18px", background: "rgba(255,255,255,0.14)", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic("qr", 44, "#FFFFFF")}</Span>
          <Span>
            <Span style={{ display: "block", fontSize: "26px", lineHeight: "30px", fontWeight: 700 }}>{T.scanQR}</Span>
            <Span style={{ display: "block", fontSize: "15px", color: "#DDD2FF", marginTop: "4px" }}>{T.scanAny}</Span>
          </Span>
        </Btn>
        <Div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: "4px" }}>
          <Span style={{ fontSize: "20px", fontWeight: 700 }}>{T.myTasks}</Span>
          <Span style={{ fontSize: "14px", color: "#6B7385" }}>{open.length + " / " + mine.length}</Span>
        </Div>
        {!open.length && <Div style={{ background: "#FFFFFF", border: "1px solid #DDE1E8", borderRadius: "16px", padding: "28px 20px", textAlign: "center", fontSize: "16px", color: "#6B7385" }}>You have no work right now. New work will show here.</Div>}
        {open.map((t) => {
          const over = t.due < now && t.status === "ready";
          const blocked = t.status === "blocked";
          const held = t.status === "held";
          const pend = t.status === "pending" || held;
          const started = !!st.started[t.id];
          return (
            <Div key={t.id} style={{ background: "#FFFFFF", border: "1px solid " + (over ? "#F6CFCF" : "#DDE1E8"), borderRadius: "20px", padding: "14px", boxShadow: over ? "inset 4px 0 0 #B3261E" : "none" }}>
              <Div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
                <Span style={artWell(76, 16)}>{this.taskArt(t, 64)}</Span>
                <Span style={{ flex: 1, minWidth: 0 }}>
                  <Span style={{ display: "inline-flex", alignItems: "center", gap: "5px", height: "24px", padding: "0 9px", borderRadius: "12px", background: "#F1ECFF", color: "#3D14A8", fontSize: "12px", fontWeight: 700 }}>{ic(PC[t.proc], 15)}{(T as Record<string, string>)[t.proc] + " · " + t.id}</Span>
                  <Span style={{ display: "block", fontSize: "18px", lineHeight: "23px", fontWeight: 700, marginTop: "6px" }}>{taskName(db, t)}</Span>
                  <Span style={{ display: "block", fontSize: "15px", color: "#3D4453", marginTop: "2px" }}>{taskTarget(db, t)}</Span>
                  <Span style={{ display: "block", fontSize: "14px", fontWeight: over ? 700 : 500, color: over ? "#B3261E" : "#6B7385", marginTop: "2px" }}>{(over ? "Late · due at " : "Do by ") + t.due}</Span>
                </Span>
              </Div>
              {(blocked || pend) && <Div style={{ marginTop: "12px", padding: "10px 12px", borderRadius: "12px", fontSize: "14px", lineHeight: "20px", background: blocked ? "#F7F8FA" : "#FDF6E7", color: blocked ? "#3D4453" : "#8A5C05" }}>{blocked ? db.orders[t.order!]?.blocked : held ? "With your supervisor. You do not need to do it again." : "Saved on this phone. It will send when the network comes back."}</Div>}
              <Btn onClick={() => !blocked && !pend && this.startTask(t.id)} style={{ ...btn(blocked || pend ? "off" : "p", 56), marginTop: "12px" }}>{blocked ? "Waiting" : held ? "With supervisor" : pend ? T.pending : started ? T.cont : T.start}</Btn>
            </Div>
          );
        })}
        {done.length > 0 && (
          <>
            <Div style={{ fontSize: "15px", fontWeight: 600, color: "#6B7385", marginTop: "6px" }}>{T.done} · {done.length}</Div>
            <Div style={{ background: "#FFFFFF", border: "1px solid #DDE1E8", borderRadius: "16px", overflow: "hidden" }}>
              {done.map((t) => (
                <Div key={t.id} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 14px", borderTop: "1px solid #F3F4F7" }}>
                  <Span style={{ width: "32px", height: "32px", borderRadius: "50%", background: "#E9F5EE", color: "#1D7A45", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic("check", 18, "#1D7A45")}</Span>
                  <Span style={{ flex: 1, minWidth: 0 }}>
                    <Span style={{ display: "block", fontSize: "15px", fontWeight: 600 }}>{taskName(db, t)}</Span>
                    <Span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{t.id + " · " + nf(t.out?.good) + " " + (t.out?.unit ?? "") + (t.out?.rej ? " good · " + t.out.rej + " rejected" : "") + " · " + (t.out?.at ?? "")}</Span>
                  </Span>
                </Div>
              ))}
            </Div>
          </>
        )}
      </Div>
    );
  }

  /* ---------------------------------------------------------------- scan */

  renderScan(): ReactNode {
    const st = this.state, T = this.T(), sc = st.scan!, f = st.flow, m = sc.meta, P = sc.purpose, r = sc.res;
    const db = st.db;
    const rmName = m.item && db?.rm[m.item] ? db.rm[m.item].n : "";
    const title = { badge: T.scanBadge, home: T.scanQR, rm: rmName, sfg: "Base liquid", pm: "Empty cans", fg: "Filled cans", load: f ? (f.task.order ?? "") : "" }[P] || T.scanQR;
    const hint = { badge: "Show your company badge", home: "Scan a task sheet, order or lot label", rm: "Scan the " + rmName + " drum", sfg: "Scan the base-liquid tank", pm: "Scan the empty-can stack", fg: "Scan the filled-can pallet", load: "Scan each pallet before loading" }[P];
    const hasManual = ["rm", "sfg", "pm", "fg", "load"].indexOf(P) > -1;
    const noCam = st.cam === "none" || st.cam === "denied";
    const labels = noCam && (DEV || st.cam === "none") ? this.scanLabels() : [];
    const corner = (pos: CSSProperties, b: string, rad: string): ReactNode => <Span style={{ position: "absolute", width: "44px", height: "44px", ...pos, [b.split("|")[0]]: "5px solid #C6FF34", [b.split("|")[1]]: "5px solid #C6FF34", borderRadius: rad } as CSSProperties} />;
    return (
      <Div style={{ flex: 1, minHeight: 0, background: "#0E1016", color: "#FFFFFF", display: "flex", flexDirection: "column", position: "relative" }}>
        {!r && <CameraScanner torch={sc.torch} paused={!!r || !!st.sheet} onCode={(c) => void this.doScan(c)} onState={(s) => this.setState({ cam: s })} />}
        <Div style={{ flex: "none", display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", position: "relative" }}>
          <Btn onClick={() => this.setState({ scan: null })} aria-label="Close" style={{ width: "48px", height: "48px", borderRadius: "50%", border: "none", background: "rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>{ic("x", 24, "#FFFFFF")}</Btn>
          <Span style={{ flex: 1, fontSize: "17px", fontWeight: 700, textAlign: "center" }}>{title}</Span>
          <Btn onClick={() => this.setState({ scan: { ...sc, torch: !sc.torch } })} aria-label="Torch" style={{ width: "48px", height: "48px", borderRadius: "50%", border: "none", background: sc.torch ? "#C6FF34" : "rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>{ic("torch", 22, "#FFFFFF")}</Btn>
        </Div>
        <Div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 24px", position: "relative" }}>
          <Div style={{ position: "relative", width: "240px", height: "240px", borderRadius: "24px", background: sc.torch ? "rgba(198,255,52,0.10)" : "rgba(255,255,255,0.03)" }}>
            {corner({ left: 0, top: 0 }, "borderLeft|borderTop", "20px 0 0 0")}
            {corner({ right: 0, top: 0 }, "borderRight|borderTop", "0 20px 0 0")}
            {corner({ left: 0, bottom: 0 }, "borderLeft|borderBottom", "0 0 0 20px")}
            {corner({ right: 0, bottom: 0 }, "borderRight|borderBottom", "0 0 20px 0")}
            <Span style={{ position: "absolute", left: "14px", right: "14px", height: "3px", borderRadius: "2px", background: "#C6FF34", boxShadow: "0 0 14px #C6FF34", animation: "fx-scan 2.4s ease-in-out infinite" }} />
          </Div>
          <Div style={{ fontSize: "20px", lineHeight: "26px", fontWeight: 700, marginTop: "22px", textAlign: "center" }}>{hint}</Div>
          <Div style={{ fontSize: "15px", color: "#C2C8D2", marginTop: "4px", textAlign: "center" }}>{st.cam === "denied" ? "The camera is off. Allow the camera for this app, or pick from photos." : T.scanHint}</Div>
        </Div>
        {(labels.length > 0 || hasManual) && (
          <Div style={{ flex: "none", background: "#1A1E28", borderRadius: "22px 22px 0 0", padding: "14px 16px 18px 16px", position: "relative" }}>
            {labels.length > 0 && (
              <>
                <Div style={{ fontSize: "12px", fontWeight: 600, color: "#9BA3B2" }}>{T.testLabels}</Div>
                <Div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px", maxHeight: "150px", overflowY: "auto" }}>
                  {labels.map((b) => (
                    <Btn key={b.code} onClick={() => void this.doScan(b.code)} style={{ padding: "8px 12px", borderRadius: "12px", border: "1px solid " + (b.good ? "rgba(198,255,52,0.45)" : "rgba(255,255,255,0.2)"), background: "rgba(255,255,255,0.06)", color: "#FFFFFF", textAlign: "left", cursor: "pointer" }}>
                      <Span style={{ display: "block", ...mono, fontSize: "13px", fontWeight: 600 }}>{b.code}</Span>
                      <Span style={{ display: "block", fontSize: "11px", opacity: 0.75, marginTop: "1px" }}>{b.what}</Span>
                    </Btn>
                  ))}
                </Div>
              </>
            )}
            {hasManual && <Btn onClick={() => this.manualPick()} style={{ width: "100%", height: "54px", marginTop: labels.length ? "12px" : 0, border: "1.5px solid rgba(255,255,255,0.28)", background: "transparent", borderRadius: "14px", color: "#FFFFFF", fontSize: "16px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", cursor: "pointer" }}>{ic("camera", 22, "#FFFFFF")}{T.noLabel}</Btn>}
          </Div>
        )}
        {r && (
          <Div style={{ position: "absolute", inset: 0, background: "rgba(14,16,22,0.55)", display: "flex", alignItems: "flex-end", zIndex: 5 }}>
            <Div style={{ width: "100%", background: "#FFFFFF", color: "#1A1E28", borderRadius: "26px 26px 0 0", padding: "18px 18px 20px 18px", animation: "fx-up 200ms cubic-bezier(0.2,0,0.2,1)" }}>
              {r.ok ? this.renderScanOk(r as Extract<ScanResult, { ok: true }> & { manual?: boolean }) : (
                <Div>
                  <Div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                    <Span style={{ width: "52px", height: "52px", flex: "none", borderRadius: "50%", background: "#FCECEC", color: "#B3261E", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic("x", 28, "#B3261E")}</Span>
                    <Span style={{ flex: 1 }}>
                      <Span style={{ display: "block", fontSize: "20px", lineHeight: "25px", fontWeight: 700, color: "#B3261E" }}>{r.title}</Span>
                      <Span style={{ display: "block", ...mono, fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>{r.code}</Span>
                    </Span>
                  </Div>
                  <Div style={{ fontSize: "16px", lineHeight: "23px", color: "#1A1E28", marginTop: "12px" }}>{r.text}</Div>
                  <Div style={{ marginTop: "12px", padding: "12px 14px", borderRadius: "12px", background: "#F7F8FA", fontSize: "15px", lineHeight: "22px", color: "#1A1E28" }}><Span style={{ fontWeight: 700 }}>What to do: </Span>{r.fix}</Div>
                  <Div style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
                    <Btn onClick={() => this.speak(r.title + ". " + r.fix)} aria-label={T.listen} style={{ ...btn("s", 58), width: "64px", flex: "none" }}>{ic("speaker", 20)}</Btn>
                    <Btn onClick={() => this.setState({ scan: { ...sc, res: null } })} style={{ ...btn("p", 58), flex: 2 }}>{T.scanAgain}</Btn>
                  </Div>
                </Div>
              )}
            </Div>
          </Div>
        )}
      </Div>
    );
  }

  renderScanOk(r: Extract<ScanResult, { ok: true }> & { manual?: boolean }): ReactNode {
    const st = this.state, T = this.T(), sc = st.scan!, P = sc.purpose;
    let artEl: ReactNode = null, name = "", code = r.code, facts: { l: string; v: string }[] = [], acceptL = T.yes;
    if (r.kind === "emp") {
      const who = st.pinFor;
      artEl = <Span style={avStyle(who ? who.key.length : 0, 80)}>{who?.ini}</Span>;
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
      <Div>
        <Div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
          <Span style={artWell(96, 18)}>{artEl}</Span>
          <Span style={{ flex: 1, minWidth: 0 }}>
            <Span style={{ display: "inline-flex", alignItems: "center", gap: "4px", height: "24px", padding: "0 10px", borderRadius: "12px", background: "#E9F5EE", color: "#1D7A45", fontSize: "13px", fontWeight: 700 }}>{ic("check", 14, "#1D7A45")}{T.found}</Span>
            <Span style={{ display: "block", fontSize: "20px", lineHeight: "25px", fontWeight: 700, marginTop: "6px" }}>{name}</Span>
            <Span style={{ display: "block", ...mono, fontSize: "14px", fontWeight: 600, color: "#3D4453", marginTop: "2px" }}>{code}</Span>
          </Span>
        </Div>
        <Div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "14px" }}>
          {facts.map((f) => (
            <Div key={f.l} style={{ background: "#F7F8FA", borderRadius: "12px", padding: "10px 12px" }}>
              <Div style={{ fontSize: "12px", color: "#6B7385" }}>{f.l}</Div>
              <Div style={{ fontSize: "18px", fontWeight: 700, marginTop: "2px" }}>{f.v}</Div>
            </Div>
          ))}
        </Div>
        {r.manual && <Div style={{ marginTop: "12px", padding: "10px 12px", borderRadius: "12px", background: "#FDF6E7", color: "#8A5C05", fontSize: "14px", lineHeight: "20px", fontWeight: 600 }}>{T.manualWarn}</Div>}
        <Div style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
          <Btn onClick={() => this.setState({ scan: { ...sc, res: null } })} style={{ ...btn("s", 58), flex: 1 }}>{T.wrong}</Btn>
          <Btn onClick={() => this.acceptScan()} style={{ ...btn("p", 58), flex: 2 }}>{acceptL}</Btn>
        </Div>
      </Div>
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
      if (block) return this.toast(block);
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
      <Div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "#F7F8FA" }}>
        <Div style={{ flex: "none", background: "#FFFFFF", borderBottom: "1px solid #EDEFF3", padding: "6px 12px 12px 12px" }}>
          <Div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Btn onClick={back} aria-label={T.back} style={{ width: "48px", height: "48px", borderRadius: "50%", border: "none", background: "#F7F8FA", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flex: "none" }}>{ic("back", 24)}</Btn>
            <Span style={{ flex: 1, minWidth: 0 }}>
              <Span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{(T as Record<string, string>)[t.proc] + " · " + t.id}</Span>
              <Span style={{ display: "block", fontSize: "16px", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{taskName(db, t)}</Span>
            </Span>
            <Btn onClick={listen} style={{ height: "44px", padding: "0 14px", borderRadius: "22px", border: "1px solid #DDD2FF", background: "#F1ECFF", color: "#5223E0", fontSize: "15px", fontWeight: 700, display: "flex", gap: "6px", alignItems: "center", cursor: "pointer", flex: "none" }}>{ic("speaker", 20)}{T.listen}</Btn>
          </Div>
          <Div style={{ display: "flex", gap: "5px", marginTop: "12px" }}>
            {steps.map((k, i) => <Span key={k} style={{ flex: 1, height: "6px", borderRadius: "3px", background: i < f.step ? "#1A1E28" : i === f.step ? "#6835FB" : "#DDE1E8" }} />)}
          </Div>
          <Div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px", marginTop: "10px" }}>
            <Span style={{ fontSize: "23px", lineHeight: "28px", fontWeight: 700 }}>{STEP_T[key][li]}</Span>
            <Span style={{ fontSize: "13px", color: "#6B7385", whiteSpace: "nowrap" }}>{f.step + 1 + " / " + steps.length}</Span>
          </Div>
        </Div>
        <Div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 20px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          {key === "identify" && this.stepIdentify(t)}
          {key === "team" && this.stepTeam(t, d)}
          {key === "review" && this.stepReview(f)}
          {key !== "identify" && key !== "team" && key !== "review" && this.stepForm(key, t, d)}
        </Div>
        <Div style={{ flex: "none", background: "#FFFFFF", borderTop: "1px solid #EDEFF3", padding: "10px 16px 16px 16px" }}>
          {block && <Div style={{ fontSize: "14px", lineHeight: "20px", color: "#8A5C05", fontWeight: 600, marginBottom: "8px", textAlign: "center" }}>{block}</Div>}
          <Btn onClick={next} style={btn(block ? "off" : "p", 62)}>{key === "review" && st.sending ? T.sending : nextL}</Btn>
        </Div>
      </Div>
    );
  }

  stepIdentify(t: Task): ReactNode {
    const T = this.T(), db = this.db();
    let chips: string[] = [], rows: { l: string; v: string; c: string }[] = [], rowsTitle = "";
    if (t.proc === "mixing") {
      const sf = db.sfg[t.item!];
      const nb = t.batches ?? 1;
      chips = [nb + " × " + nf(sf.batch) + " L", "Due " + t.due];
      rowsTitle = "Batch sheet · for " + nb + " batch" + (nb > 1 ? "es" : "");
      rows = sf.recipe.map((r) => ({ l: db.rm[r[0]]?.n ?? r[0], v: nf(r[1] * nb) + " L", c: db.rm[r[0]]?.col ?? "#3D4453" }));
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
      <Div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <Div style={{ ...card, padding: "20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <Span style={artWell(168, 26)}>{this.taskArt(t, 140)}</Span>
          <Div style={{ fontSize: "23px", lineHeight: "28px", fontWeight: 700, marginTop: "14px" }}>{taskName(db, t)}</Div>
          <Div style={{ ...mono, fontSize: "14px", color: "#6B7385", marginTop: "4px" }}>{t.id + " · " + (db.sfg[t.item!]?.short ?? db.sku[t.item!]?.tag ?? (db.box[t.item!] ? db.box[t.item!].cpb + "×" + db.sku[db.box[t.item!].sku]?.tag : ""))}</Div>
          <Div style={{ display: "flex", gap: "8px", marginTop: "14px", flexWrap: "wrap", justifyContent: "center" }}>
            {chips.map((c) => <Span key={c} style={{ background: "#F1ECFF", color: "#3D14A8", borderRadius: "16px", padding: "6px 14px", fontSize: "15px", fontWeight: 700 }}>{c}</Span>)}
          </Div>
        </Div>
        {rows.length > 0 && (
          <Div style={{ ...card, padding: "4px 16px" }}>
            <Div style={{ fontSize: "13px", fontWeight: 600, color: "#6B7385", padding: "10px 0 4px 0" }}>{rowsTitle}</Div>
            {rows.map((r) => (
              <Div key={r.l} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 0", borderTop: "1px solid #F3F4F7" }}>
                <Span style={{ width: "12px", height: "12px", borderRadius: "3px", flex: "none", background: r.c }} />
                <Span style={{ flex: 1, fontSize: "16px" }}>{r.l}</Span>
                <Span style={{ fontSize: "17px", fontWeight: 700 }}>{r.v}</Span>
              </Div>
            ))}
          </Div>
        )}
        <Div style={{ fontSize: "19px", fontWeight: 700, textAlign: "center", marginTop: "4px" }}>{T.isRight}</Div>
        <Btn onClick={() => this.openReport(t)} style={btn("s", 56)}>{T.wrong}</Btn>
      </Div>
    );
  }

  stepTeam(t: Task, d: Draft): ReactNode {
    const T = this.T(), me = this.state.me!;
    const pick = (role: PeopleSheet["role"], multi: boolean) =>
      this.setState({ sheet: { type: "people", role, multi, sel: multi ? (d.team.helpers || []).slice() : [d.team[role as "owner"]].filter(Boolean) as string[], area: t.proc } });
    const G: [PeopleSheet["role"], string, boolean, boolean][] = [["owner", "In charge", false, true], ["op", t.proc === "dispatch" ? "Lead loader" : "Machine operator", false, true], ["helpers", "Helpers", true, false], ["ver", "Checked by (optional)", false, false]];
    return (
      <Div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {G.map(([k, l, multi, req]) => {
          const ids = k === "helpers" ? d.team.helpers : ([d.team[k as "owner"]].filter(Boolean) as string[]);
          return (
            <Btn key={k} onClick={() => pick(k, multi)} style={{ background: "#FFFFFF", border: "1px solid " + (req && !ids.length ? "#F6CFCF" : "#DDE1E8"), borderRadius: "18px", padding: "14px", textAlign: "left", cursor: "pointer", display: "block", width: "100%" }}>
              <Span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Span style={{ fontSize: "14px", fontWeight: 700, color: "#3D4453" }}>{l}</Span>
                <Span style={{ fontSize: "15px", fontWeight: 700, color: "#5223E0" }}>{T.change}</Span>
              </Span>
              <Span style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "10px" }}>
                {ids.map((p) => (
                  <Span key={p} style={{ display: "flex", alignItems: "center", gap: "8px", background: "#F7F8FA", borderRadius: "28px", padding: "4px 14px 4px 4px" }}>
                    <Span style={this.av(p, 36)}>{this.ini(p)}</Span>
                    <Span style={{ fontSize: "16px", fontWeight: 600 }}>{this.name(p)}</Span>
                  </Span>
                ))}
                {!ids.length && <Span style={{ fontSize: "15px", fontWeight: 600, color: req ? "#B3261E" : "#6B7385", padding: "8px 0" }}>{req ? "Required — tap to choose" : k === "helpers" ? "No helpers — tap to add" : "Nobody — tap to add"}</Span>}
              </Span>
            </Btn>
          );
        })}
        <Div style={{ fontSize: "13px", lineHeight: "19px", color: "#6B7385", padding: "0 4px" }}>{"Saved by " + me.n + ". The work counts once for the whole team."}</Div>
      </Div>
    );
  }

  stepReview(f: Flow): ReactNode {
    const rv = this.reviewVM(f);
    return (
      <Div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <Div style={{ ...card, padding: "14px", display: "flex", gap: "14px", alignItems: "center" }}>
          <Span style={artWell(84, 16)}>{rv.art}</Span>
          <Span style={{ flex: 1, minWidth: 0 }}>
            <Span style={{ display: "block", fontSize: "19px", lineHeight: "24px", fontWeight: 700 }}>{rv.name}</Span>
            <Span style={{ display: "block", ...mono, fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>{rv.code}</Span>
          </Span>
        </Div>
        <Div style={{ ...card, padding: "2px 16px" }}>
          {rv.rows.map((r, i) => (
            <Div key={i} style={{ display: "flex", alignItems: "baseline", gap: "10px", padding: "12px 0", borderTop: "1px solid #F3F4F7" }}>
              <Span style={{ flex: 1, fontSize: "15px", color: "#3D4453" }}>{r.l}</Span>
              <Span style={{ fontSize: "18px", fontWeight: 700, textAlign: "right" }}>{r.v}</Span>
            </Div>
          ))}
        </Div>
        <Div style={{ ...card, padding: "2px 16px" }}>
          {rv.team.map((r) => (
            <Div key={r.l} style={{ display: "flex", alignItems: "baseline", gap: "10px", padding: "11px 0", borderTop: "1px solid #F3F4F7" }}>
              <Span style={{ flex: 1, fontSize: "14px", color: "#6B7385" }}>{r.l}</Span>
              <Span style={{ fontSize: "16px", fontWeight: 600, textAlign: "right" }}>{r.v}</Span>
            </Div>
          ))}
        </Div>
        {rv.warns.map((m, i) => <MsgBox key={i} m={m} />)}
        <Div style={{ fontSize: "12px", lineHeight: "17px", color: "#9BA3B2", textAlign: "center" }}>{rv.key}</Div>
      </Div>
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
      sub = "Scan each drum. Then type how much you poured.";
      (d.rm ?? []).forEach((r, i) => {
        const x = r.lot ? db.lots[r.lot] : undefined;
        const need = r.per * (d.batches ?? 1);
        const nm = db.rm[r.item]?.n ?? r.item;
        const err = x && (r.qty ?? 0) > x.avail ? "Only " + nf(x.avail) + " L left in this drum. Scan another drum or type less." : "";
        lots.push({
          art: art("rm", db.rm[r.item]?.col, db.rm[r.item]?.code, 52), name: nm, need: "Sheet: " + nf(need) + " L", lot: r.lot, manual: r.manual,
          scan: () => this.openScan("rm", { item: r.item, idx: i }), qtyL: T.used, qtyV: r.qty ? nf(r.qty) + " L" : "Tap to enter", qtyDone: !!r.qty, done: !!(x && r.qty && !err), err,
          qtyOpen: () => this.openKp({ l: "How much " + nm + " did you pour?", unit: "L", v: r.qty, max: x ? x.avail : null, maxL: x ? "Only " + nf(x.avail) + " L in this lot" : "", quick: [{ l: "As on sheet · " + nf(need) + " L", v: need }], set: (v) => this.setD((z) => { z.rm![i].qty = v; }) }),
        });
      });
    }
    if (key === "output") {
      const sf = db.sfg[t.item!];
      const { exp, dev, over } = mixDeviation(db, t, d);
      const inp = (d.rm ?? []).reduce((a, r) => a + (r.qty || 0), 0);
      fields.push(
        { l: "Number of batches", v: d.batches ?? null, unit: (d.batches ?? 1) > 1 ? "batches" : "batch", open: () => this.openKp({ l: "Number of batches", unit: "", v: d.batches, max: 6, set: (v) => this.setD((z) => { z.batches = v; }) }), step: true, minus: () => this.setD((z) => { z.batches = Math.max(1, (z.batches ?? 1) - 1); }), plus: () => this.setD((z) => { z.batches = Math.min(6, (z.batches ?? 1) + 1); }) },
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
        flip: () => (d.photo ? this.setD((z) => { z.photo = null; z.photoId = null; }) : void this.pickPhoto()),
        box: { width: "32px", height: "32px", borderRadius: "10px", flex: "none", background: d.photo ? "#1D7A45" : "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center" },
        style: { display: "flex", alignItems: "center", gap: "14px", width: "100%", minHeight: "64px", padding: "12px 14px", borderRadius: "16px", border: "1px solid " + (d.photo ? "#BFE3CD" : "#DDD2FF"), background: "#FFFFFF", cursor: "pointer" },
      });
      msgs.push(msg("This only says the truck is loaded right. The office will send the order.", "info"));
    }

    return (
      <Div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {sub && <Div style={{ fontSize: "15px", lineHeight: "22px", color: "#3D4453" }}>{sub}</Div>}
        {info.length > 0 && (
          <Div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            {info.map((f) => (
              <Div key={f.l} style={f.style}>
                <Div style={{ fontSize: "12px", color: "#6B7385" }}>{f.l}</Div>
                <Div style={{ fontSize: "18px", lineHeight: "23px", fontWeight: 700, marginTop: "2px" }}>{f.v}</Div>
              </Div>
            ))}
          </Div>
        )}
        {lines.map((ln, i) => (
          <Div key={i} style={{ ...card, padding: "14px", display: "flex", gap: "12px", alignItems: "center" }}>
            <Span style={artWell(60, 14)}>{ln.art}</Span>
            <Span style={{ flex: 1, minWidth: 0 }}>
              <Span style={{ display: "block", fontSize: "16px", fontWeight: 700, lineHeight: "21px" }}>{ln.title}</Span>
              <Span style={{ display: "block", fontSize: "20px", fontWeight: 700, marginTop: "2px" }}>{ln.qty}</Span>
              <Span style={{ display: "block", ...mono, fontSize: "12px", color: "#6B7385", marginTop: "2px" }}>{ln.lots}</Span>
            </Span>
          </Div>
        ))}
        {tiles.map((tg) => (
          <Div key={tg.title}>
            <Div style={{ fontSize: "15px", fontWeight: 700, color: "#3D4453", marginBottom: "8px" }}>{tg.title}</Div>
            <Div style={{ display: "grid", gridTemplateColumns: "repeat(" + tg.cols + ",minmax(0,1fr))", gap: "8px" }}>
              {tg.items.map((it) => (
                <Btn key={it.l} onClick={it.pick} style={it.style}>
                  {it.art && <Span style={{ display: "flex", justifyContent: "center" }}>{it.art}</Span>}
                  <Span style={{ display: "block", fontSize: "15px", fontWeight: 700, marginTop: it.art ? "4px" : 0 }}>{it.l}</Span>
                  {it.sub && <Span style={{ display: "block", fontSize: "12px", color: "#6B7385" }}>{it.sub}</Span>}
                </Btn>
              ))}
            </Div>
          </Div>
        ))}
        {lots.map((r, i) => this.lotRowEl(r, i))}
        {fields.map((f) => this.fieldEl(f))}
        {bar && (
          <Div style={{ ...card, padding: "14px" }}>
            <Div style={{ display: "flex", justifyContent: "space-between", fontSize: "15px" }}>
              <Span style={{ color: "#3D4453", fontWeight: 600 }}>{bar.l}</Span>
              <Span style={{ fontWeight: 700 }}>{bar.v}</Span>
            </Div>
            <Div style={{ height: "12px", borderRadius: "6px", background: "#EDEFF3", marginTop: "10px", overflow: "hidden" }}><Div style={bar.fill} /></Div>
          </Div>
        )}
        {checks.map((c, i) => (
          <Btn key={i} onClick={c.flip} style={c.style}>
            <Span style={c.box}>{c.mark}</Span>
            <Span style={{ flex: 1, textAlign: "left" }}>
              <Span style={{ display: "block", fontSize: "16px", fontWeight: 600, lineHeight: "21px" }}>{c.l}</Span>
              {c.sub && <Span style={{ display: "block", fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>{c.sub}</Span>}
            </Span>
          </Btn>
        ))}
        {down && this.downEl(d)}
        {msgs.map((m, i) => <MsgBox key={i} m={m} />)}
      </Div>
    );
  }

  lotRowEl(o: LotRow, i: number): ReactNode {
    const T = this.T(), db = this.db();
    const x = o.lot ? db.lots[o.lot] : undefined;
    const scanned = !!o.lot;
    return (
      <Div key={i} style={{ background: "#FFFFFF", border: "1px solid " + (o.err ? "#F6CFCF" : o.done ? "#BFE3CD" : "#DDE1E8"), borderRadius: "18px", padding: "14px" }}>
        <Div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <Span style={artWell(58, 14)}>{o.art}</Span>
          <Span style={{ flex: 1, minWidth: 0 }}>
            <Span style={{ display: "block", fontSize: "17px", lineHeight: "22px", fontWeight: 700 }}>{o.name}</Span>
            <Span style={{ display: "block", fontSize: "14px", color: "#6B7385", marginTop: "1px" }}>{o.need}</Span>
          </Span>
          {o.done && <Span style={{ width: "34px", height: "34px", borderRadius: "50%", background: "#1D7A45", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic("check", 18, "#FFFFFF")}</Span>}
        </Div>
        {!scanned && <Btn onClick={o.scan} style={{ marginTop: "12px", width: "100%", height: "56px", border: "none", borderRadius: "14px", background: "#6835FB", color: "#FFFFFF", fontSize: "17px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", cursor: "pointer" }}>{ic("qr", 22)}{o.scanL || T.scanLabel}</Btn>}
        {scanned && (
          <Div>
            <Div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "12px", background: "#F7F8FA", borderRadius: "12px", padding: "8px 6px 8px 12px" }}>
              <Span style={{ ...mono, fontSize: "14px", fontWeight: 600 }}>{o.lot}</Span>
              {o.manual && <Span style={{ fontSize: "11px", fontWeight: 700, color: "#8A5C05", background: "#FDF6E7", borderRadius: "8px", padding: "2px 6px" }}>By photo</Span>}
              <Span style={{ flex: 1, fontSize: "13px", color: "#6B7385", textAlign: "right" }}>{x ? nf(x.avail) + " " + lotUnit(db, x) + " left" : ""}</Span>
              <Btn onClick={o.scan} style={{ height: "36px", border: "none", background: "transparent", color: "#5223E0", fontSize: "14px", fontWeight: 700, cursor: "pointer", padding: "0 8px" }}>{T.change}</Btn>
            </Div>
            {o.qtyOpen && (
              <Btn onClick={o.qtyOpen} style={{ width: "100%", marginTop: "10px", minHeight: "68px", borderRadius: "14px", border: "2px solid " + (o.err ? "#B3261E" : o.qtyDone ? "#C2C8D2" : "#6835FB"), background: o.qtyDone ? "#FFFFFF" : "#F7F4FF", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", cursor: "pointer" }}>
                <Span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{o.qtyL}</Span>
                <Span style={{ fontSize: "28px", fontWeight: 700, color: "#1A1E28" }}>{o.qtyV}</Span>
              </Btn>
            )}
          </Div>
        )}
        {o.err && <Div style={{ marginTop: "10px", fontSize: "15px", lineHeight: "21px", fontWeight: 700, color: "#B3261E" }}>{o.err}</Div>}
      </Div>
    );
  }

  fieldEl(f: QField): ReactNode {
    const has = f.v != null && f.v !== 0 ? true : f.v === 0 && f.l === "Bad / damaged";
    const sq = (onClick: (() => void) | undefined, icn: string, label: string) => (
      <Btn onClick={onClick} aria-label={label} style={{ width: "60px", borderRadius: "14px", border: "1.5px solid #C2C8D2", background: "#FFFFFF", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic(icn, 24)}</Btn>
    );
    return (
      <Div key={f.l} style={{ ...card, padding: "14px" }}>
        <Div style={{ fontSize: "16px", fontWeight: 700, color: "#3D4453" }}>{f.l}</Div>
        <Div style={{ display: "flex", alignItems: "stretch", gap: "10px", marginTop: "10px" }}>
          {f.step && sq(f.minus, "minus", "Less")}
          <Btn onClick={f.open} style={{ flex: 1, minHeight: "72px", borderRadius: "14px", border: "2px solid " + (f.err ? "#B3261E" : has ? "#C2C8D2" : "#6835FB"), background: has ? "#FFFFFF" : "#F7F4FF", display: "flex", alignItems: "baseline", justifyContent: "center", padding: "14px 8px", cursor: "pointer" }}>
            <Span style={{ fontSize: "34px", fontWeight: 700, color: "#1A1E28" }}>{f.v == null ? "—" : nf(f.v)}</Span>
            <Span style={{ fontSize: "16px", color: "#6B7385", marginLeft: "6px" }}>{f.unit}</Span>
          </Btn>
          {f.step && sq(f.plus, "plus", "More")}
        </Div>
        {f.sub && <Div style={{ fontSize: "14px", color: "#6B7385", marginTop: "8px" }}>{f.sub}</Div>}
        {f.err && <Div style={{ fontSize: "15px", lineHeight: "21px", color: "#B3261E", marginTop: "8px", fontWeight: 700 }}>{f.err}</Div>}
      </Div>
    );
  }

  downEl(d: Draft): ReactNode {
    const T = this.T();
    return (
      <Div style={{ ...card, padding: "14px" }}>
        <Div style={{ fontSize: "16px", fontWeight: 700, color: "#3D4453" }}>{T.stopped}</Div>
        <Div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
          <Btn onClick={() => this.setD((z) => { z.down = false; z.downR = null; z.downMin = null; })} style={{ ...btn(d.down === false ? "p" : "s", 54), flex: 1 }}>{T.noStop}</Btn>
          <Btn onClick={() => this.setD((z) => { z.down = true; })} style={{ ...btn(d.down ? "d" : "s", 54), flex: 1 }}>Yes, it stopped</Btn>
        </Div>
        {d.down && (
          <Div>
            <Div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px", marginTop: "12px" }}>
              {DOWN.map(([l, icn]) => (
                <Btn key={l} onClick={() => this.setD((z) => { z.downR = l; })} style={{ height: "78px", borderRadius: "14px", border: d.downR === l ? "2px solid #B3261E" : "1px solid #DDE1E8", background: d.downR === l ? "#FCECEC" : "#FFFFFF", color: d.downR === l ? "#B3261E" : "#3D4453", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "6px", cursor: "pointer", padding: "4px" }}>
                  {ic(icn, 24)}<Span style={{ fontSize: "13px", fontWeight: 700, lineHeight: "16px" }}>{l}</Span>
                </Btn>
              ))}
            </Div>
            <Btn onClick={() => this.openKp({ l: "How many minutes did it stop?", unit: T.minutes, v: d.downMin, max: 480, maxL: "More than one shift — ask the supervisor", quick: [{ l: "15", v: 15 }, { l: "30", v: 30 }, { l: "60", v: 60 }], set: (v) => this.setD((z) => { z.downMin = v; }) })} style={{ width: "100%", marginTop: "10px", height: "60px", borderRadius: "14px", border: "1.5px solid " + (d.downMin ? "#C2C8D2" : "#B77B08"), background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", cursor: "pointer" }}>
              <Span style={{ fontSize: "15px", color: "#3D4453", fontWeight: 600 }}>How long</Span>
              <Span style={{ fontSize: "24px", fontWeight: 700 }}>{d.downMin ? d.downMin + " " + T.minutes : "Tap to enter"}</Span>
            </Btn>
          </Div>
        )}
      </Div>
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
      acts = (r.label ? [{ l: T.printLabel, run: () => this.printLabel(r.label!), style: btn("s", 56), icon: ic("print", 22) } as Act] : []).concat([home, { l: T.listen, run: () => this.speak(T.completed + ". " + r.msg), style: { ...btn("s", 48), border: "none", color: "#5223E0" }, icon: ic("speaker", 20) }]);
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
      <Div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "#FFFFFF" }}>
        <Div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 20px 12px 20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "10px" }}>
          <Span style={{ width: "112px", height: "112px", borderRadius: "50%", background: c[0], display: "flex", alignItems: "center", justifyContent: "center", flex: "none", animation: r.kind === "sending" ? "fx-spin 1.2s linear infinite" : "none" }}>{ic(c[2], 56, c[1])}</Span>
          <Div style={{ fontSize: "28px", lineHeight: "34px", fontWeight: 700, color: c[1] }}>{title}</Div>
          <Div style={{ fontSize: "17px", lineHeight: "25px", color: "#3D4453", maxWidth: "320px" }}>{text}</Div>
          {rows.length > 0 && (
            <Div style={{ width: "100%", background: "#F7F8FA", borderRadius: "18px", padding: "2px 16px", marginTop: "6px", textAlign: "left" }}>
              {rows.map((q) => (
                <Div key={q.l} style={{ display: "flex", alignItems: "baseline", gap: "10px", padding: "11px 0", borderTop: "1px solid #EDEFF3" }}>
                  <Span style={{ flex: 1, fontSize: "15px", color: "#3D4453" }}>{q.l}</Span>
                  <Span style={{ fontSize: "17px", fontWeight: 700, textAlign: "right" }}>{q.v}</Span>
                </Div>
              ))}
            </Div>
          )}
          {label && (
            <Div style={{ width: "100%", border: "2px dashed #C2C8D2", borderRadius: "18px", padding: "14px", display: "flex", gap: "14px", alignItems: "center", textAlign: "left", marginTop: "4px" }}>
              <Span style={{ padding: "6px", background: "#FFFFFF", border: "1px solid #DDE1E8", borderRadius: "8px", flex: "none" }}>{qr(label.code, 88)}</Span>
              <Span style={{ flex: 1, minWidth: 0 }}>
                <Span style={{ display: "block", fontSize: "11px", fontWeight: 700, letterSpacing: "0.06em", color: "#6B7385" }}>MAHEK ONE · LOT LABEL</Span>
                <Span style={{ display: "block", ...mono, fontSize: "15px", fontWeight: 600, marginTop: "4px" }}>{label.code}</Span>
                <Span style={{ display: "block", fontSize: "14px", marginTop: "2px" }}>{label.name}</Span>
                <Span style={{ display: "block", fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>{label.meta}</Span>
              </Span>
            </Div>
          )}
        </Div>
        <Div style={{ flex: "none", padding: "12px 20px 18px 20px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {acts.map((a) => <Btn key={a.l} onClick={a.run} style={a.style}>{a.icon}{a.l}</Btn>)}
        </Div>
      </Div>
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
      <Div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <Div style={{ display: "flex", gap: "14px", alignItems: "center", padding: "16px", borderRadius: "18px", background: c[0], color: c[1] }}>
          <Span style={{ width: "56px", height: "56px", borderRadius: "50%", background: "rgba(255,255,255,0.7)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic(c[2], 30, c[1])}</Span>
          <Span style={{ flex: 1 }}>
            <Span style={{ display: "block", fontSize: "20px", fontWeight: 700 }}>{c[3]}</Span>
            <Span style={{ display: "block", fontSize: "15px", lineHeight: "21px", marginTop: "2px" }}>{c[4]}</Span>
          </Span>
        </Div>
        {!q.length && <Div style={{ ...card, padding: "24px 18px", textAlign: "center", fontSize: "16px", color: "#3D4453" }}>{T.allSaved}</Div>}
        {q.slice().reverse().map((x) => {
          const t = x.flow.task;
          const badge = x.status === "done" ? ["#E9F5EE", "#1D7A45", T.completed] : x.status === "held" ? ["#FDF6E7", "#8A5C05", "With supervisor"] : x.status === "failed" ? ["#FDF6E7", "#8A5C05", "Check it"] : ["#FDF6E7", "#8A5C05", T.pending];
          /* How long it has waited, said plainly: past two days it goes to the supervisor rather than straight in. */
          const ageH = x.savedIso ? (Date.now() - Date.parse(x.savedIso)) / 3_600_000 : 0;
          const ageL = x.status === "pending" && ageH >= 1 ? " · waiting " + (ageH >= 24 ? Math.floor(ageH / 24) + " d " + Math.floor(ageH % 24) + " h" : Math.floor(ageH) + " h") + (ageH > OFFLINE_HOURS ? " — your supervisor will check it" : "") : "";
          return (
            <Btn key={x.key} onClick={() => x.status === "failed" && x.result && this.setState({ flow: x.flow, result: x.result, queue: st.queue.filter((z) => z.key !== x.key) })} style={{ ...card, padding: "14px", display: "flex", gap: "12px", alignItems: "center", width: "100%", textAlign: "left", cursor: x.status === "failed" ? "pointer" : "default" }}>
              <Span style={artWell(56, 14)}>{this.taskArt(t, 48)}</Span>
              <Span style={{ flex: 1, minWidth: 0 }}>
                <Span style={{ display: "block", fontSize: "16px", fontWeight: 700 }}>{taskName(db, t)}</Span>
                <Span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{t.id + " · saved on phone " + x.at + ageL + (x.doneAt ? " · sent " + x.doneAt : "") + " · " + x.key}</Span>
              </Span>
              <Pill l={badge[2]} bg={badge[0]} fg={badge[1]} />
            </Btn>
          );
        })}
        {pend.length > 0 && <Btn onClick={() => (st.net === "offline" ? this.toast("Still no network. They will send by themselves.") : void this.flushQueue())} style={btn("p", 56)}>{ic("sync", 22, "#FFFFFF")}{T.retry}</Btn>}
        <Div style={{ fontSize: "14px", lineHeight: "20px", color: "#6B7385", padding: "0 4px" }}>Work waiting here is not saved yet. It will send by itself. It is sent only once, even if you tap many times.</Div>
      </Div>
    );
  }

  renderHelp(): ReactNode {
    const st = this.state, T = this.T(), area = st.me!.area;
    const list = HELP.filter((h) => ["scan", "sync"].indexOf(h[0]) > -1 || area === "head" || h[0] === area).concat(HELP.filter((h) => ["scan", "sync"].indexOf(h[0]) < 0 && h[0] !== area && area !== "head"));
    const p = st.play;
    return (
      <Div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <Div style={{ fontSize: "20px", fontWeight: 700 }}>{T.help}</Div>
        {list.map((h) => {
          const on = !!p && p.id === h[0];
          const i = on ? Math.min(h[4].length - 1, Math.floor((p!.t / Math.max(1, p!.dur)) * h[4].length)) : 0;
          const playL = on && p!.on ? "Pause" : on && p!.t >= p!.dur ? "Play again" : "Play video";
          return (
            <Div key={h[0]} style={{ ...card, padding: "14px" }}>
              <Div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                <Span style={{ width: "64px", height: "64px", borderRadius: "16px", background: "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic(h[3], 28, "#5223E0")}</Span>
                <Span style={{ flex: 1, minWidth: 0 }}>
                  <Span style={{ display: "block", fontSize: "17px", lineHeight: "22px", fontWeight: 700 }}>{h[1]}</Span>
                  <Span style={{ display: "block", fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>{"Video · " + h[2] + (h[0] === area ? " · for your work" : "")}</Span>
                </Span>
              </Div>
              {on && (
                <Div style={{ marginTop: "12px" }}>
                  <Div style={{ height: "8px", borderRadius: "4px", background: "#EDEFF3", overflow: "hidden" }}><Div style={{ height: "8px", width: Math.round((p!.t / p!.dur) * 100) + "%", background: "#6835FB" }} /></Div>
                  <Div style={{ fontSize: "16px", lineHeight: "23px", fontWeight: 600, marginTop: "10px", padding: "12px", borderRadius: "12px", background: "#F7F4FF", color: "#3D14A8" }}>{h[4][i]}</Div>
                </Div>
              )}
              <Div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                <Btn onClick={() => { this.setState({ play: on && p!.on ? { ...p!, on: false } : { id: h[0], t: on && p!.t < p!.dur ? p!.t : 0, dur: 9, on: true } }); if (!(on && p!.on)) this.speak(h[4][i]); }} style={{ ...btn("p", 50), flex: 1, fontSize: "16px" }}>{ic(on && p!.on ? "pause" : "play", 20, "#FFFFFF")}{playL}</Btn>
                <Btn onClick={() => this.speak(h[1] + ". " + h[4].join(" "))} style={{ ...btn("s", 50), flex: 1, fontSize: "16px" }}>{ic("speaker", 20)}{T.listen}</Btn>
              </Div>
            </Div>
          );
        })}
      </Div>
    );
  }

  /* ---------------------------------------------------------------- the head's screens */

  renderToday(): ReactNode {
    const st = this.state, T = this.T(), db = this.db(), tasks = this.tasks(), now = this.now();
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
    const ORDER: Record<string, number> = { late: 0, progress: 1, todo: 2, blocked: 3, done: 4 };
    const list = tasks
      .filter((t) => st.hf === "all" || (PROC[st.hf] ? t.proc === PROC[st.hf] : status(t)[3] === st.hf))
      .sort((a, b) => ORDER[status(a)[3]] - ORDER[status(b)[3]] || (a.due > b.due ? 1 : -1));
    return (
      <>
        <Div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 96px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <Div style={{ fontSize: "14px", color: "#6B7385" }}>{db.dateLine + " · " + db.loc + " · " + db.shift.split(" · ")[0] + " · now " + now}</Div>
          <Div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            {kpis.filter((k) => !st.me?.scope || PROC[k.l] === st.me.scope).map((k) => (
              <Btn key={k.l} onClick={() => this.setState({ hf: k.l })} style={{ ...card, padding: "14px", textAlign: "left", cursor: "pointer" }}>
                <Span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 700, color: "#3D4453" }}>{ic(k.icn, 16)}{k.l}</Span>
                <Span style={{ display: "block", fontSize: "24px", lineHeight: "30px", fontWeight: 700, marginTop: "6px" }}>{nf(k.act) + " / " + nf(k.plan)}</Span>
                <Span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{k.unit}</Span>
                <Span style={{ display: "block", height: "6px", borderRadius: "3px", background: "#EDEFF3", marginTop: "8px", overflow: "hidden" }}><Span style={{ display: "block", height: "6px", width: Math.min(100, pct(k.act, Math.max(1, k.plan))) + "%", background: "#6835FB", borderRadius: "3px" }} /></Span>
                <Span style={{ display: "block", fontSize: "12px", color: "#6B7385", marginTop: "6px" }}>{k.sub}</Span>
              </Btn>
            ))}
          </Div>
          <Div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px" }}>
            {flags.map((f) => (
              <Btn key={f[0]} onClick={() => (f[2] === "review" ? this.setState({ route: "review" }) : this.setState({ hf: f[2] }))} style={{ padding: "10px 8px", borderRadius: "14px", border: "none", background: f[1] ? f[3] : "#F7F8FA", color: f[1] ? f[4] : "#6B7385", textAlign: "center", cursor: "pointer" }}>
                <Span style={{ display: "block", fontSize: "22px", fontWeight: 700 }}>{f[1]}</Span>
                <Span style={{ display: "block", fontSize: "12px", fontWeight: 600, lineHeight: "15px" }}>{f[0]}</Span>
              </Btn>
            ))}
          </Div>
          <Div style={{ display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "2px" }}>
            {filters.map(([k, l]) => <Btn key={k} onClick={() => this.setState({ hf: k })} style={{ height: "38px", padding: "0 14px", borderRadius: "19px", border: st.hf === k ? "none" : "1px solid #DDE1E8", background: st.hf === k ? "#1A1E28" : "#FFFFFF", color: st.hf === k ? "#FFFFFF" : "#3D4453", fontSize: "14px", fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer", flex: "none" }}>{l}</Btn>)}
          </Div>
          {!list.length && <Div style={{ ...card, padding: "24px", textAlign: "center", fontSize: "15px", color: "#6B7385" }}>No jobs in this group.</Div>}
          {list.map((t) => {
            const js = status(t);
            const tm = t.team;
            return (
              <Btn key={t.id} onClick={() => this.setState({ sheet: { type: "job", id: t.id } })} style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%", padding: "12px", borderRadius: "18px", border: "1px solid " + (js[3] === "late" ? "#F6CFCF" : "#DDE1E8"), background: "#FFFFFF", cursor: "pointer", boxShadow: js[3] === "late" ? "inset 4px 0 0 #B3261E" : "none" }}>
                <Span style={artWell(54, 14)}>{this.taskArt(t, 46)}</Span>
                <Span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  <Span style={{ display: "block", fontSize: "15px", lineHeight: "20px", fontWeight: 700 }}>{taskName(db, t)}</Span>
                  <Span style={{ display: "block", fontSize: "13px", color: "#6B7385", marginTop: "1px" }}>{(T as Record<string, string>)[t.proc] + " · " + t.id + " · " + (t.status === "done" ? nf(t.out?.good) + " " + t.out?.unit + " at " + t.out?.at : taskTarget(db, t).split(" · ")[0] + " · due " + t.due)}</Span>
                  <Span style={{ display: "block", fontSize: "13px", color: "#3D4453", marginTop: "1px" }}>{[tm.owner, tm.op, ...tm.helpers].filter(Boolean).map((k) => this.name(k).split(" ")[0]).join(" · ") + (tm.helpers.length ? "" : " · no helper")}</Span>
                </Span>
                <Pill l={js[0]} bg={js[1]} fg={js[2]} />
              </Btn>
            );
          })}
        </Div>
        {st.me?.scope !== "dispatch" && <Btn onClick={() => this.setState({ sheet: { type: "assign" }, asg: this.defaultAsg(st.me?.scope ?? "mixing") })} style={{ position: "absolute", right: "16px", bottom: "94px", height: "56px", padding: "0 20px", border: "none", borderRadius: "28px", background: "#6835FB", color: "#FFFFFF", fontSize: "16px", fontWeight: 700, display: "flex", alignItems: "center", gap: "8px", boxShadow: "0 8px 20px rgba(104,53,251,0.35)", cursor: "pointer", zIndex: 5 }}>{ic("plus", 22, "#FFFFFF")}Give a task</Btn>}
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
      <Div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 20px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <Div style={{ fontSize: "15px", lineHeight: "21px", color: "#3D4453" }}>Jobs the app could not accept on its own. Every decision needs a reason and is kept in the history.</Div>
        {!db.review.length && <Div style={{ ...card, padding: "28px 18px", textAlign: "center", fontSize: "16px", color: "#3D4453" }}>Nothing to check. Every job is within the rules.</Div>}
        {db.review.map((it) => {
          const k = K[it.kind] ?? K.issue;
          return (
            <Div key={it.id} style={{ ...card, padding: "14px" }}>
              <Pill l={k[0]} bg={k[1]} fg={k[2]} />
              <Div style={{ fontSize: "17px", lineHeight: "22px", fontWeight: 700, marginTop: "8px" }}>{it.title}</Div>
              <Div style={{ fontSize: "15px", lineHeight: "22px", color: "#1A1E28", marginTop: "4px" }}>{it.text}</Div>
              <Div style={{ fontSize: "13px", color: "#6B7385", marginTop: "6px" }}>{it.meta + " · " + it.task}</Div>
              <Div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                {it.acts.map((a, i) => <Btn key={a} onClick={() => this.decide(it, a, i)} style={{ ...btn(i ? "s" : "p", 50), flex: 1, fontSize: "15px" }}>{a}</Btn>)}
              </Div>
            </Div>
          );
        })}
      </Div>
    );
  }

  renderTeams(): ReactNode {
    const db = this.db(), T = this.T(), tasks = this.tasks();
    const sum = <X,>(a: X[], f: (x: X) => number) => a.reduce((x, y) => x + f(y), 0);
    return (
      <Div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 20px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <Div style={{ display: "flex", gap: "10px", padding: "12px 14px", borderRadius: "14px", background: "#F1ECFF", color: "#3D14A8", fontSize: "14px", lineHeight: "20px", fontWeight: 600 }}>Each job is counted once for the team. A 1,000 L batch is 1,000 L for the mixing team — never 1,000 L for each of the three people.</Div>
        {(this.state.me?.scope ? [this.state.me.scope] : (["mixing", "filling", "packing", "dispatch"] as Proc[])).map((p) => {
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
            <Div key={p} style={{ ...card, padding: "14px" }}>
              <Div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <Span style={{ width: "40px", height: "40px", borderRadius: "12px", background: "#F1ECFF", color: "#5223E0", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic(PC[p], 22)}</Span>
                <Span style={{ flex: 1 }}>
                  <Span style={{ display: "block", fontSize: "17px", fontWeight: 700 }}>{(T as Record<string, string>)[p]}</Span>
                  <Span style={{ display: "block", fontSize: "13px", color: "#6B7385" }}>{done.length + " of " + all.length + " jobs done today"}</Span>
                </Span>
                <Span style={{ textAlign: "right" }}>
                  <Span style={{ display: "block", fontSize: "22px", fontWeight: 700 }}>{nf(out)}</Span>
                  <Span style={{ display: "block", fontSize: "12px", color: "#6B7385" }}>{unit}</Span>
                </Span>
              </Div>
              {p === "filling" && <Div style={{ fontSize: "13px", color: "#3D4453", marginTop: "8px" }}>{rej + " rejected · " + (out ? ((out / (out + rej)) * 100).toFixed(1) : "0") + "% accepted"}</Div>}
              <Div style={{ marginTop: "10px", borderTop: "1px solid #F3F4F7" }}>
                {Object.keys(ppl).map((k) => (
                  <Div key={k} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 0", borderBottom: "1px solid #F3F4F7" }}>
                    <Span style={this.av(k, 36)}>{this.ini(k)}</Span>
                    <Span style={{ flex: 1, minWidth: 0 }}>
                      <Span style={{ display: "block", fontSize: "15px", fontWeight: 700 }}>{this.name(k) + (db.emp[k]?.confirm ? " · to confirm" : "")}</Span>
                      <Span style={{ display: "block", fontSize: "12px", color: "#6B7385" }}>{ppl[k].role}</Span>
                    </Span>
                    <Span style={{ textAlign: "right", fontSize: "13px", color: "#3D4453" }}>{"In " + ppl[k].done + " of " + ppl[k].jobs + " jobs · " + (db.hours[k] != null ? db.hours[k] + " h" : "no check-in")}</Span>
                  </Div>
                ))}
              </Div>
            </Div>
          );
        })}
      </Div>
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
      <Div key={l} style={{ display: "flex", justifyContent: "space-between", gap: "10px", padding: "10px 0", borderTop: "1px solid #F3F4F7", fontSize: "15px" }}>
        <Span style={{ color: "#3D4453" }}>{l}</Span>
        <Span style={{ fontWeight: 700, color: warn ? "#8A5C05" : "#1A1E28" }}>{v}</Span>
      </Div>
    );
    const tol = db.review.filter((x) => x.kind === "tolerance").length;
    return (
      <Div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px 20px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <Div style={{ ...card, padding: "14px" }}>
          <Div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <Span style={{ fontSize: "17px", fontWeight: 700 }}>Machine stops · this week</Span>
            <Span style={{ fontSize: "15px", fontWeight: 700 }}>{Math.floor(tot / 60) + " h " + (tot % 60) + " min"}</Span>
          </Div>
          <Div style={{ fontSize: "13px", color: "#6B7385", marginTop: "2px" }}>Biggest cause first. Planned cleaning is counted separately in ERP.</Div>
          <Div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "12px" }}>
            {!keys.length && <Div style={{ fontSize: "14px", color: "#6B7385" }}>No machine stops recorded this week.</Div>}
            {keys.sort((a, b) => D[b] - D[a]).map((l) => (
              <Div key={l}>
                <Div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px" }}>
                  <Span style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 600 }}>{ic(icon(l), 16)}{l}</Span>
                  <Span style={{ fontWeight: 700 }}>{D[l] + " min"}</Span>
                </Div>
                <Div style={{ height: "10px", borderRadius: "5px", background: "#EDEFF3", marginTop: "5px", overflow: "hidden" }}><Div style={{ height: "10px", width: Math.round((D[l] / mx) * 100) + "%", background: l === "Breakdown" || l === "Power cut" ? "#B3261E" : "#6835FB", borderRadius: "5px" }} /></Div>
              </Div>
            ))}
          </Div>
        </Div>
        <Div style={{ ...card, padding: "4px 14px" }}>
          <Div style={{ fontSize: "17px", fontWeight: 700, padding: "10px 0 4px 0" }}>Quality · today</Div>
          {row("Filling · accepted", good + rej ? ((good / (good + rej)) * 100).toFixed(1) + "%" : "—", false)}
          {row("Filling · rejected", nf(rej) + " cans", rej > 0)}
          {row("Mixing outside limit", tol + " batch", tol > 0)}
        </Div>
        <Div style={{ ...card, padding: "4px 14px" }}>
          <Div style={{ fontSize: "17px", fontWeight: 700, padding: "10px 0 4px 0" }}>Data checks</Div>
          {row("Waiting to send", String(pend), pend > 0)}
          {row("Double taps blocked", String(db.dup), false)}
          {row("Corrections", String(db.corr), false)}
          {row("Jobs with no helper", String(noHelp), noHelp > 0)}
          {row("Picked by photo", String(db.review.filter((x) => x.kind === "manual").length), false)}
        </Div>
      </Div>
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
      body = (
        <Div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <Div style={{ display: "flex", alignItems: "center", gap: "10px", height: "80px", padding: "0 18px", borderRadius: "18px", border: "2px solid " + (err ? "#B3261E" : "#6835FB"), background: "#F7F4FF", cursor: "text" }}>
            <Input value={v} onChange={(e) => this.setState({ sheet: { ...sh, v: String(e.target.value).replace(/[^\d]/g, "").slice(0, 6) } })} inputMode="numeric" autoFocus placeholder="0" aria-label={sh.l} style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: "40px", fontWeight: 700, color: "#1A1E28", textAlign: "right" }} />
            <Span style={{ fontSize: "18px", color: "#6B7385", flex: "none" }}>{sh.unit}</Span>
          </Div>
          {err && <Div style={{ fontSize: "15px", lineHeight: "21px", fontWeight: 700, color: "#B3261E", textAlign: "center" }}>{err}</Div>}
          {!!sh.quick?.length && (
            <Div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
              {sh.quick.map((q) => <Btn key={q.l} onClick={() => this.setState({ sheet: { ...sh, v: String(q.v) } })} style={{ height: "44px", padding: "0 16px", borderRadius: "22px", border: "1.5px solid #DDD2FF", background: "#F7F4FF", color: "#3D14A8", fontSize: "15px", fontWeight: 700, cursor: "pointer" }}>{q.l}</Btn>)}
            </Div>
          )}
        </Div>
      );
      acts = [
        { l: T.back, run: close, style: { ...btn("s", 58), flex: 1 } },
        { l: T.ok, run: () => { if (err) return; if (n == null || (n <= 0 && !sh.allowZero)) return this.toast("Enter a number more than 0"); this.setState({ sheet: null }); sh.set(n); }, style: { ...btn(err || n == null ? "off" : "p", 58), flex: 2 } },
      ];
    }

    if (sh.type === "people") {
      const db = this.db();
      const RL = { owner: "Who is in charge?", op: "Who ran the machine?", helpers: "Who helped? Choose all", ver: "Who checked the work?" };
      const pool = Object.keys(db.emp)
        .filter((k) => db.emp[k].area !== "head" || sh.role === "ver" || sh.role === "owner")
        .sort((a, b) => Number(db.emp[b].area === sh.area) - Number(db.emp[a].area === sh.area));
      title = RL[sh.role];
      sub = sh.multi ? "Tap everyone who helped. Tap again to remove." : "Tap one person.";
      body = (
        <>
          <Div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "10px" }}>
            {pool.map((k) => {
              const on = sh.sel.indexOf(k) > -1;
              return (
                <Btn key={k} onClick={() => this.setState({ sheet: { ...sh, sel: sh.multi ? (on ? sh.sel.filter((z) => z !== k) : sh.sel.concat([k])) : [k] } })} style={{ position: "relative", background: on ? "#F7F4FF" : "#FFFFFF", border: on ? "3px solid #6835FB" : "1px solid #DDE1E8", borderRadius: "16px", padding: "12px 4px", display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", cursor: "pointer", minHeight: "116px" }}>
                  <Span style={this.av(k, 52)}>{this.ini(k)}</Span>
                  <Span style={{ fontSize: "15px", fontWeight: 700, lineHeight: "18px", textAlign: "center" }}>{db.emp[k].n.split(" ")[0]}</Span>
                  <Span style={{ fontSize: "11px", color: "#6B7385", lineHeight: "14px", textAlign: "center" }}>{db.emp[k].role.split(" · ")[0]}</Span>
                  {on && <Span style={{ position: "absolute", top: "8px", right: "8px", width: "24px", height: "24px", borderRadius: "50%", background: "#6835FB", display: "flex", alignItems: "center", justifyContent: "center" }}>{ic("check", 18, "#FFFFFF")}</Span>}
                </Btn>
              );
            })}
          </Div>
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
            <Div key={gi}>
              {g.title && <Div style={{ fontSize: "14px", fontWeight: 700, color: "#3D4453", marginBottom: "8px" }}>{g.title}</Div>}
              <Div style={{ display: "grid", gridTemplateColumns: "repeat(" + (g.cols || 2) + ",minmax(0,1fr))", gap: "10px" }}>
                {g.items.map((t) => (
                  <Btn key={t.v} onClick={() => sh.pick(t.v)} style={{ padding: "12px 8px", borderRadius: "16px", border: "1px solid #DDE1E8", background: "#FFFFFF", cursor: "pointer", textAlign: "center" }}>
                    {t.art && <Span style={{ display: "flex", justifyContent: "center" }}>{t.art}</Span>}
                    <Span style={{ display: "block", fontSize: "15px", fontWeight: 700, lineHeight: "20px" }}>{t.l}</Span>
                    {t.sub && <Span style={{ display: "block", fontSize: "12px", color: "#6B7385", marginTop: "2px" }}>{t.sub}</Span>}
                  </Btn>
                ))}
              </Div>
            </Div>
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
        <Div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {sh.reasons.map((r) => <Btn key={r} onClick={() => this.setState({ sheet: { ...sh, sel: r } })} style={{ minHeight: "58px", padding: "12px 16px", borderRadius: "14px", border: sh.sel === r ? "3px solid #6835FB" : "1px solid #DDE1E8", background: sh.sel === r ? "#F7F4FF" : "#FFFFFF", textAlign: "left", cursor: "pointer", fontSize: "15px", fontWeight: 700, lineHeight: "20px" }}>{r}</Btn>)}
        </Div>
      );
      acts = [
        { l: T.back, run: close, style: { ...btn("s", 58), flex: 1 } },
        { l: st.busy ? T.sending : sh.okL || "Send", run: () => { if (sh.sel && !st.busy) sh.done(sh.sel); }, style: { ...btn(sh.sel && !st.busy ? (sh.danger ? "d" : "p") : "off", 58), flex: 2 } },
      ];
    }

    if (sh.type === "menu") {
      const me = st.me!;
      const db = this.db();
      const emp = db.emp[me.key];
      const LN: Record<Lang, string> = { en: "English", hi: "हिन्दी · Hindi", mr: "मराठी · Marathi" };
      const row = (l: string, s: string, icn: string, run: () => void) => (
        <Btn key={l} onClick={run} style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%", minHeight: "64px", padding: "8px 12px", borderRadius: "16px", border: "1px solid #DDE1E8", background: "#FFFFFF", cursor: "pointer" }}>
          <Span style={{ width: "44px", height: "44px", borderRadius: "12px", background: "#F1ECFF", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{ic(icn, 22, "#5223E0")}</Span>
          <Span style={{ flex: 1, textAlign: "left" }}>
            <Span style={{ display: "block", fontSize: "17px", fontWeight: 700 }}>{l}</Span>
            {s && <Span style={{ display: "block", fontSize: "13px", color: "#6B7385", marginTop: "1px" }}>{s}</Span>}
          </Span>
          <Span style={{ color: "#9BA3B2", display: "flex" }}>{ic("chev", 24)}</Span>
        </Btn>
      );
      const pendN = st.queue.filter((q) => q.status === "pending").length;
      title = me.n;
      sub = (emp?.role ?? "") + " · " + (emp?.id ?? "");
      body = (
        <>
          {row(T.language, LN[st.lang], "globe", () =>
            this.setState({
              sheet: {
                type: "reason", title: T.language, sub: "Buttons, steps and spoken help change to this language.", reasons: Object.values(LN), okL: T.ok, sel: LN[st.lang],
                done: (r) => {
                  const k = (Object.keys(LN) as Lang[]).find((x) => LN[x] === r) ?? "en";
                  save(null, "lang", k);
                  void call("setLang", k);
                  this.setState({ lang: k, sheet: null });
                  this.toast(k === "en" ? "Language: English" : k === "hi" ? "भाषा: हिन्दी" : "भाषा: मराठी");
                },
              },
            }),
          )}
          {row("Work place", db.loc + " · " + db.shift.split(" · ")[0], "pin", () => this.toast("Your supervisor sets your work place"))}
          {row(T.sync, pendN + " waiting", "sync", () => this.setState({ sheet: null, route: "sync" }))}
          {row(T.help, "Short videos and audio", "help", () => this.setState({ sheet: null, route: "help" }))}
          {row("Change my PIN", "4 numbers you sign in with", "badge", () => this.setState({ sheet: null, signStep: "newpin", newPin: "", newPin1: "", pinErr: "" }))}
          {DEV && row("Network (preview only)", (T as Record<string, string>)[st.net] + " — tap to change", st.net === "offline" ? "wifioff" : "wifi", () => { const nx = ({ online: "weak", weak: "offline", offline: "online" } as const)[st.net]; this.setNet(nx); this.toast((T as Record<string, string>)[nx]); })}
          {row(T.signOut, "Unsent work stays on this phone", "out", () => {
            if (pendN)
              return this.setState({ sheet: { type: "reason", title: "Sign out with " + pendN + " job" + (pendN > 1 ? "s" : "") + " waiting?", sub: "It stays on this phone and sends later. No one else can change it.", reasons: ["Yes, sign out"], okL: T.signOut, danger: true, done: () => void this.signOut() } });
            void this.signOut();
          })}
        </>
      );
    }

    if (sh.type === "job") body = this.jobSheet(sh.id, (t, s, b, a) => { title = t; sub = s; acts = a; return b; });
    if (sh.type === "assign") body = this.assignSheet((t, s, b, a) => { title = t; sub = s; acts = a; return b; });

    return (
      <Div onClick={close} style={{ position: "absolute", inset: 0, background: "rgba(14,16,22,0.5)", zIndex: 40, display: "flex", alignItems: "flex-end" }}>
        <Div onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title} style={{ width: "100%", maxHeight: "92%", background: "#FFFFFF", borderRadius: "26px 26px 0 0", display: "flex", flexDirection: "column", animation: "fx-up 200ms cubic-bezier(0.2,0,0.2,1)" }}>
          <Div style={{ width: "44px", height: "5px", borderRadius: "3px", background: "#DDE1E8", margin: "10px auto 0 auto", flex: "none" }} />
          <Div style={{ padding: "12px 20px 6px 20px", flex: "none" }}>
            <Div style={{ fontSize: "21px", lineHeight: "27px", fontWeight: 700 }}>{title}</Div>
            {sub && <Div style={{ fontSize: "15px", lineHeight: "21px", color: "#6B7385", marginTop: "4px" }}>{sub}</Div>}
          </Div>
          <Div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 20px 14px 20px", display: "flex", flexDirection: "column", gap: "12px" }}>{body}</Div>
          {acts.length > 0 && (
            <Div style={{ flex: "none", padding: "12px 20px 18px 20px", borderTop: "1px solid #EDEFF3", display: "flex", gap: "10px" }}>
              {acts.map((a) => <Btn key={a.l} onClick={a.run} style={a.style}>{a.l}</Btn>)}
            </Div>
          )}
        </Div>
      </Div>
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
        <Div style={{ background: "#F7F8FA", borderRadius: "16px", padding: "2px 14px" }}>
          {rows.map((r) => (
            <Btn key={r.l} onClick={r.run ?? (() => {})} style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", padding: "12px 0", border: "none", borderTop: "1px solid #EDEFF3", background: "transparent", cursor: r.run ? "pointer" : "default" }}>
              <Span style={{ flex: 1, fontSize: "14px", color: "#6B7385", textAlign: "left" }}>{r.l}</Span>
              <Span style={{ fontSize: "16px", fontWeight: 700, textAlign: "right" }}>{r.v}</Span>
              {r.run && <Span style={{ color: "#9BA3B2", display: "flex" }}>{ic("chev", 24)}</Span>}
            </Btn>
          ))}
        </Div>
        <MsgBox m={done ? msg("This job is saved in ERP. To change it, ask for a correction — the original stays in the history.", "info") : msg("You can change the team until the job is saved.", "info")} />
        <Div>
          <Div style={{ fontSize: "14px", fontWeight: 700, color: "#3D4453", marginBottom: "6px" }}>History · cannot be changed</Div>
          {!audit.length && <Div style={{ fontSize: "14px", color: "#6B7385", padding: "8px 0" }}>Nothing yet.</Div>}
          {audit.map((a, i) => (
            <Div key={i} style={{ display: "flex", gap: "10px", padding: "8px 0", borderTop: "1px solid #F3F4F7", fontSize: "14px", lineHeight: "20px" }}>
              <Span style={{ color: "#6B7385", width: "44px", flex: "none" }}>{a.at}</Span>
              <Span style={{ flex: 1 }}><Span style={{ fontWeight: 700 }}>{a.who}</Span> · {a.t}</Span>
            </Div>
          ))}
        </Div>
      </>
    );
    return out(taskName(db, t), (T as Record<string, string>)[t.proc] + " · " + t.id + " · " + js[0], body, done ? [{ l: "Close", run: close, style: { ...btn("s", 56), flex: 1 } }, { l: "Ask for correction", run: askCorrection, style: { ...btn("p", 56), flex: 2, fontSize: "16px" } }] : [{ l: "Close", run: close, style: btn("s", 56) }]);
  }

  assignSheet(out: (title: string, sub: string, body: ReactNode, acts: { l: string; run: () => void; style: CSSProperties }[]) => ReactNode): ReactNode {
    const st = this.state, T = this.T(), db = this.db();
    const a = st.asg ?? this.defaultAsg("mixing");
    const set = (p: Partial<NonNullable<State["asg"]>>) => this.setState({ asg: { ...a, ...p } });
    const PR = ([["mixing", "flask"], ["filling", "fill"], ["packing", "box"]] as [Proc, string][]).filter(([k]) => !st.me?.scope || st.me.scope === k);
    const items =
      a.proc === "mixing" ? Object.keys(db.sfg).filter((k) => db.sfg[k].recipe.length).map((k) => ({ v: k, l: db.sfg[k].short + " base", art: art("tank", db.sfg[k].col, db.sfg[k].short, 48) }))
      : a.proc === "filling" ? Object.keys(db.sku).map((k) => ({ v: k, l: db.sku[k].n.replace("Mahek ", "") + " " + db.sku[k].size, art: art(db.sku[k].kind, db.sku[k].col, db.sku[k].tag, 48) }))
      : Object.keys(db.box).map((k) => ({ v: k, l: db.sku[db.box[k].sku].size + " × " + db.box[k].cpb, art: art("box", db.sku[db.box[k].sku].col, db.box[k].cpb + "×" + db.sku[db.box[k].sku].tag, 48) }));
    const tile = (on: boolean, extra?: CSSProperties): CSSProperties => ({ padding: "10px 6px", borderRadius: "14px", border: on ? "3px solid #6835FB" : "1px solid #DDE1E8", background: on ? "#F7F4FF" : "#FFFFFF", cursor: "pointer", textAlign: "center", ...(extra ?? {}) });
    const unit = a.proc === "mixing" ? "batches" : a.proc === "filling" ? (db.sku[a.item]?.kind === "drum" ? "drums" : "cans") : "boxes";
    const tm = db.teams[a.proc];
    const teamL = [tm.owner, tm.op, ...tm.helpers].filter(Boolean).map((k) => this.name(k).split(" ")[0]).join(", ") || "Nobody set — change it on the job";
    const g = (title: string, cols: number, its: { k: string; l: string; art?: ReactNode; on: boolean; pick: () => void; extra?: CSSProperties }[]) => (
      <Div key={title}>
        <Div style={{ fontSize: "14px", fontWeight: 700, color: "#3D4453", marginBottom: "8px" }}>{title}</Div>
        <Div style={{ display: "grid", gridTemplateColumns: "repeat(" + cols + ",minmax(0,1fr))", gap: "8px" }}>
          {its.map((t) => (
            <Btn key={t.k} onClick={t.pick} style={tile(t.on, t.extra)}>
              {t.art && <Span style={{ display: "flex", justifyContent: "center" }}>{t.art}</Span>}
              <Span style={{ display: "block", fontSize: "15px", fontWeight: 700, lineHeight: "20px" }}>{t.l}</Span>
            </Btn>
          ))}
        </Div>
      </Div>
    );
    const body = (
      <>
        {g("Work", 3, PR.map(([k, icn]) => ({ k, l: (T as Record<string, string>)[k], art: ic(icn, 26), on: a.proc === k, pick: () => this.setState({ asg: this.defaultAsg(k) }), extra: { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" } })))}
        {g("Product", 2, items.map((it) => ({ k: it.v, l: it.l, art: it.art, on: a.item === it.v, pick: () => set({ item: it.v }) })))}
        {!items.length && <MsgBox m={msg("Nothing is set up for this work in the ERP yet.", "warn")} />}
        {g("Due by", 4, ["12:00", "14:00", "16:00", "18:00"].map((d) => ({ k: d, l: d, on: a.due === d, pick: () => set({ due: d }), extra: { height: "48px" } })))}
        <Div style={{ background: "#F7F8FA", borderRadius: "16px", padding: "2px 14px" }}>
          <Btn onClick={() => this.openKp({ l: "How many " + unit + "?", unit, v: a.qty, max: a.proc === "mixing" ? 6 : 5000, set: (v) => this.setState({ sheet: { type: "assign" }, asg: { ...this.state.asg!, qty: v } }) })} style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", padding: "12px 0", border: "none", background: "transparent", cursor: "pointer" }}>
            <Span style={{ flex: 1, fontSize: "14px", color: "#6B7385", textAlign: "left" }}>How many</Span>
            <Span style={{ fontSize: "16px", fontWeight: 700, textAlign: "right" }}>{nf(a.qty) + " " + unit}</Span>
            <Span style={{ color: "#9BA3B2", display: "flex" }}>{ic("chev", 24)}</Span>
          </Btn>
          <Div style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", padding: "12px 0", borderTop: "1px solid #EDEFF3" }}>
            <Span style={{ flex: 1, fontSize: "14px", color: "#6B7385", textAlign: "left" }}>Team</Span>
            <Span style={{ fontSize: "16px", fontWeight: 700, textAlign: "right" }}>{teamL}</Span>
          </Div>
        </Div>
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
