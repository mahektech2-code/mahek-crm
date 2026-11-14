"use client";

import { useMemo, useState } from "react";
import { Button, Card, checkboxClass, cx, Field, Input, Select } from "@/components/ui/primitives";
import { Badge } from "../../_ui/badge";
import { IconButton, LinkButton, SubTitle, toggleClass } from "../../_ui/look";
import { Icon } from "../../_ui/icons";
import { ErpImpactDialog } from "../../_ui/impact-confirm";
import {
  erpLogisticsAtTransport,
  erpLogisticsAttach,
  erpLogisticsAttachReady,
  erpLogisticsClearDuplicate,
  erpLogisticsDelivered,
  erpLogisticsDiscardDuplicate,
  erpLogisticsEditLr,
  erpLogisticsSetKind,
  erpLogisticsVoidLr,
} from "@/lib/actions/erp-logistics";
import { addDays, AT_TRANSPORT_STUCK_DAYS, directWho, pendingOf, PROOF_WORD, rankForLr, shortDay, type PendingKind, type ProofKind } from "@/lib/erp/engines/logistics";
import { confidentPick, duplicateFlags, missingFor, partyWords, rankForSignedCopy, READY_SCORE, sameParty, wrongKind, type DeskCopy, type DupFlag } from "@/lib/erp/engines/delivery-proof";
import type { Consignment, UploadedLr } from "@/lib/erp/logistics";
import { rupeesField } from "@/lib/erp/ui";
import { clock, stamp } from "@/lib/format";
import { BillRef, CallLink, driverPhone, Empty, NotifyToggle, plural, ReasonDialog, sumPackages, useAct, lrLabel } from "./common";
import { PhotoEditor } from "./photo-editor";
import { DeliveredByDialog } from "./on-road";

/* ---------------------------------------------------------------------------
 * THE DOCUMENTS DESK. The phone only uploads — up to ten photos of LRs or
 * customer-signed copies, nothing typed — and everything is checked here, on
 * the laptop: what the AI read, whether a copy is the second one of a paper,
 * what is still missing, and which bills it belongs to. The rules are pure, in
 * `engines/delivery-proof.ts`; every write is the ordinary logistics write.
 *
 * Two tabs. LRs are attached to the bills waiting for them, which puts those
 * bills on the road and tells the customer. Signed copies close a Mahek
 * Vehicle delivery: attaching one marks the bill delivered, with who signed.
 *
 * A third tab, Pending, turns the desk round: the bills still waiting for
 * their paper (`pendingOf`), oldest first, in the same fixed-height list. A
 * bill opens beside the LRs on the desk that may be it, and "Check and
 * attach" opens that LR on its own tab with the bill already ticked, so the
 * attach is the ordinary one.
 * ------------------------------------------------------------------------- */

type Bill = { key: string; c: Consignment; rows: Consignment[]; packages: number | null };

/** One bill raised on several orders is several transport records and still one bill to attach. */
/* Who is billed, and the shop it goes to where that is somebody else — two parts of one bill read apart. */
function partyLine(c: Consignment): string {
  return c.deliveryPartyId !== c.partyId && c.deliveryParty ? `${c.party} → ${c.deliveryParty}` : c.party;
}

/*
 * A bill here is one Tally bill TO ONE SHOP. A distributor's bill can carry
 * orders delivered to different shops, and an LR (or a signed copy) is one
 * consignee — so grouped by the bill number alone, such a bill was offered as
 * one tick and then refused on Attach for "different parties", with nothing
 * on the screen saying why. Keyed on the delivery party too, each shop's part
 * is its own row, named for that shop, and goes on its own LR.
 */
function byBill(cs: Consignment[]): Bill[] {
  const out = new Map<string, Consignment[]>();
  for (const c of cs) {
    const k = c.billNo?.trim() ? `${c.partyId}|${c.deliveryPartyId}|${c.billNo.trim().toUpperCase()}` : c.id;
    out.set(k, [...(out.get(k) ?? []), c]);
  }
  return [...out].map(([key, rows]) => ({ key, c: rows[0], rows, packages: sumPackages(rows) }));
}

/**
 * Does a bill answer what was typed in the Attach-to search? Every word has to
 * appear somewhere — the shop, who is billed, the bill or order number, the
 * transporter or where it is going — so "dinesh harda" finds the one bill and
 * not every bill to Harda.
 */
function billMatches(b: Bill, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const c = b.c;
  const hay = [c.deliveryParty, c.party, c.billNo, String(c.orderNo), c.transporter, c.area, c.partyCity, c.destination].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * Does a copy on the desk answer what was typed in its search? The same
 * every-word rule as the bills: transporter, consignee, LR or bill number
 * (typed or only read), destination, and who uploaded it.
 */
function copyMatches(l: UploadedLr, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [l.transporter, l.partyHint, l.billHint, l.lrNo, l.readLrNo, l.destination, l.uploadedBy].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** How many bills the Attach-to list draws before "Show more". */
const ATTACH_PAGE = 10;

const toDesk = (l: UploadedLr): DeskCopy => ({
  id: l.id,
  kind: l.kind,
  status: l.status,
  lrNo: l.lrNo,
  readLrNo: l.readLrNo,
  readKind: l.readKind,
  transporter: l.transporter,
  lrDate: l.lrDate,
  packages: l.packages,
  contentHash: l.contentHash,
  billHint: l.billHint,
  partyHint: l.partyHint,
  uploadedAt: l.uploadedAt,
  dupClearedAt: l.dupClearedAt,
});

type Ranked = { b: Bill; score: number; reasons: string[] }[];
type Tab = ProofKind | "pending";
type PendingBill = { b: Bill; kind: PendingKind; days: number };

/** How each kind of pending bill is named, with the configured day counts in it. */
function pendingLabel(kind: PendingKind, stuckLrDays: number): string {
  if (kind === "noLr") return `No LR ${stuckLrDays + 1}+ days`;
  if (kind === "atTransport") return `At transporter ${AT_TRANSPORT_STUCK_DAYS}+ days`;
  if (kind === "awaitingLr") return "Waiting for LR";
  return "Signed copy missing";
}
type State = "dup" | "reading" | "todo" | "ready" | "pick";
type Row = { l: UploadedLr; flag: DupFlag | null; wrong: ProofKind | null; missing: string[]; ranked: Ranked; pick: string | null; state: State };

const READING_MINUTES = 15;

export function DocumentsDesk({
  copies,
  waiting,
  onTheWay,
  ownOnRoad,
  transporterOnRoad,
  today,
  nowMs,
  transporters,
  callEveryDays,
  notifyOn,
  canWrite,
  canRead,
  stuckLrDays,
  initialKind = "lr",
}: {
  /** Every live copy: those on the desk, and the recently attached ones the duplicate check compares against. */
  copies: UploadedLr[];
  waiting: Consignment[];
  onTheWay: Consignment[];
  /** Mahek Vehicle bills still on the road — what a signed copy closes. */
  ownOnRoad: Consignment[];
  /** Bills on the road under a transporter's LR — a signed copy can close them too. */
  transporterOnRoad: Consignment[];
  today: string;
  nowMs: number;
  transporters: string[];
  callEveryDays: number;
  notifyOn: boolean;
  canWrite: boolean;
  canRead: boolean;
  /** `erp.ai.alerts.stuckLrDays` — how long a bill may go without its paper before it is pending. */
  stuckLrDays: number;
  initialKind?: Tab;
}) {
  const { run, pending } = useAct();
  const [tab, setTab] = useState<Tab>(initialKind);
  const kind: ProofKind = tab === "pending" ? "lr" : tab;
  const [pick, setPick] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [copyQuery, setCopyQuery] = useState("");
  /* The bill a pending row sent us here for — ticked on the LR it opened. */
  const [preTick, setPreTick] = useState<string | null>(null);

  const flags = useMemo(() => duplicateFlags(copies.map(toDesk)), [copies]);
  const waitingBills = useMemo(() => byBill(waiting), [waiting]);
  const allLrBills = useMemo(() => byBill([...waiting, ...onTheWay]), [waiting, onTheWay]);
  const onTheWayBills = useMemo(() => byBill(onTheWay), [onTheWay]);
  const ownBills = useMemo(() => byBill(ownOnRoad), [ownOnRoad]);
  /*
   * WHAT A SIGNED COPY MAY CLOSE: every open bill, Mahek Vehicle ones first. It
   * was Mahek Vehicle bills only, and that is a transporter NAME — a bill whose
   * transporter was typed as the lorry number, "Tempo" or "Portal" is our own
   * vehicle in every way but the spelling, and its signed copy had nothing to
   * close. A customer-signed copy is proof of delivery whoever carried it.
   */
  const ownKeys = useMemo(() => new Set(ownBills.map((b) => b.key)), [ownBills]);
  const signedBills = useMemo(() => byBill([...ownOnRoad, ...waiting, ...onTheWay, ...transporterOnRoad]), [ownOnRoad, waiting, onTheWay, transporterOnRoad]);

  /* One bill, one reason: the reason with the most days on any of its records. */
  const pendingBills: PendingBill[] = useMemo(() => {
    const all = [...waiting, ...onTheWay, ...ownOnRoad];
    const why = new Map(all.map((c) => [c.id, pendingOf(c, today, stuckLrDays)]));
    return byBill(all.filter((c) => why.get(c.id)))
      .map((b) => {
        const worst = b.rows.map((c) => why.get(c.id)!).sort((x, y) => y.days - x.days)[0];
        return { b, kind: worst.kind, days: worst.days };
      })
      .sort((x, y) => y.days - x.days || (x.b.c.billNo ?? "").localeCompare(y.b.c.billNo ?? ""));
  }, [waiting, onTheWay, ownOnRoad, today, stuckLrDays]);

  const switchTab = (t: Tab) => {
    setTab(t);
    setPick(null);
    setPreTick(null);
    setCopyQuery("");
  };
  /* From a pending bill to the copy that may be it: that copy's tab, the bill ticked, and the bill listed. */
  const openCopy = (copyId: string, copyKind: ProofKind, bill: Bill) => {
    setTab(copyKind);
    setPick(copyId);
    setCopyQuery("");
    setPreTick(bill.key);
    if (copyKind === "lr" && !waitingBills.some((b) => b.key === bill.key)) setShowAll(true);
  };

  const rows: Row[] = useMemo(
    () =>
      copies
        .filter((l) => l.status === "unassigned")
        .map((l) => {
          const flag = flags.get(l.id) ?? null;
          const wrong = wrongKind(l);
          const missing = missingFor(l);
          const ranked: Ranked =
            l.kind === "lr"
              ? rankForLr(l, (showAll ? allLrBills : waitingBills).map((b) => ({ id: b.key, transporter: b.c.transporter, packages: b.packages, area: b.c.area ?? b.c.partyCity, party: b.c.deliveryParty, billingParty: b.c.party, billNo: b.c.billNo, atTransport: b.rows.every((c) => c.phase === "lrPending") }))).map((x) => ({
                  b: (showAll ? allLrBills : waitingBills).find((p) => p.key === x.id)!,
                  score: x.score,
                  reasons: x.reasons,
                }))
              : rankForSignedCopy(l, signedBills.map((b) => ({ id: b.key, billNo: b.c.billNo, party: b.c.deliveryParty, vehicleNo: b.c.vehicleNo }))).map((x) => ({ b: signedBills.find((p) => p.key === x.id)!, score: x.score, reasons: x.reasons }));
          /* "Close N ready" stays what it was: a signed copy is closed unasked only against a Mahek Vehicle bill; any other is a person's tick. */
          const sure = confidentPick((l.kind === "lr" ? ranked : ranked.filter((r) => ownKeys.has(r.b.key))).map((r) => ({ id: r.b.key, score: r.score })), READY_SCORE[l.kind]);
          const reading = canRead && !l.readAt && nowMs - Date.parse(l.uploadedAt) < READING_MINUTES * 60_000;
          const state: State = flag ? "dup" : reading ? "reading" : wrong || missing.length ? "todo" : sure ? "ready" : "pick";
          return { l, flag, wrong, missing, ranked, pick: sure, state };
        }),
    [copies, flags, waitingBills, allLrBills, signedBills, ownKeys, showAll, canRead, nowMs],
  );

  const list = rows.filter((r) => r.l.kind === kind);
  /* What the search leaves on the left; the tallies, "Attach N ready" and the tab count still speak for the whole desk. */
  const visible = copyQuery.trim() ? list.filter((r) => copyMatches(r.l, copyQuery)) : list;
  const count = (k: ProofKind) => rows.filter((r) => r.l.kind === k).length;
  const sel = visible.find((r) => r.l.id === pick) ?? visible[0] ?? null;
  const at = sel ? visible.indexOf(sel) : -1;
  const ready = list.filter((r) => r.state === "ready");
  const tally = (s: State) => list.filter((r) => r.state === s).length;

  const attachReady = () =>
    run(() =>
      erpLogisticsAttachReady(
        ready.map((r) => ({
          lrId: r.l.id,
          transportIds: r.ranked.find((x) => x.b.key === r.pick)!.b.rows.map((c) => c.id),
          kind: r.l.kind,
          date: r.l.deliveredOn ?? today,
          receivedBy: r.l.receivedBy,
        })),
        { notify: notifyOn },
      ),
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-control bg-canvas p-1">
          {(["lr", "signed_copy"] as ProofKind[]).map((k) => (
            <button key={k} type="button" onClick={() => switchTab(k)} className={toggleClass(tab === k, "flex items-center gap-1.5")}>
              {k === "lr" ? "LRs" : "Signed copies"}
              <Badge label={String(count(k))} tone={tab === k ? "brand" : "muted"} />
            </button>
          ))}
          <button type="button" onClick={() => switchTab("pending")} title="Bills still waiting for their LR or signed copy" className={toggleClass(tab === "pending", "flex items-center gap-1.5")}>
            Pending
            <Badge label={String(pendingBills.length)} tone={tab === "pending" ? "brand" : pendingBills.some((p) => p.kind !== "awaitingLr") ? "danger" : "muted"} />
          </button>
        </div>
        <span className="flex-1" />
        {canWrite && tab !== "pending" && ready.length ? (
          <Button variant="primary" disabled={pending} onClick={attachReady} title={kind === "lr" ? "Attach every LR whose bill the desk is sure of" : "Close every delivery whose signed copy the desk is sure of"}>
            {kind === "lr" ? `Attach ${ready.length} ready` : `Close ${ready.length} ready`}
          </Button>
        ) : null}
      </div>

      {tab === "pending" ? (
        <PendingDesk
          transporters={transporters}
          items={pendingBills}
          rows={rows}
          stuckLrDays={stuckLrDays}
          canWrite={canWrite}
          onOpen={openCopy}
        />
      ) : (
      <div className="grid grid-cols-[minmax(280px,360px)_minmax(0,1fr)] items-start gap-4">
        <Card className="overflow-hidden">
          <div className="flex items-center gap-3 border-b border-divider px-3 py-2 text-meta">
            <Tally icon="check" tone="text-success" n={tally("ready")} label="Ready to attach" />
            <Tally icon="warn" tone="text-warn-ink" n={tally("todo")} label="Something to add or fix" />
            <Tally icon="copy" tone="text-danger" n={tally("dup")} label="Possible duplicate" />
            <Tally icon="clock" tone="text-muted" n={tally("reading")} label="Being read" />
            <span className="ml-auto text-muted">
              {copyQuery.trim() ? `${visible.length} of ` : ""}
              {plural(list.length, kind === "lr" ? "LR" : "copy", kind === "lr" ? "LRs" : "copies")}
            </span>
          </div>
          {list.length ? (
            <div className="border-b border-divider p-2">
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
                  <Icon n="search" s={14} />
                </span>
                <Input
                  value={copyQuery}
                  onChange={(e) => setCopyQuery(e.target.value)}
                  placeholder={kind === "lr" ? "Search transporter, LR no., party, city" : "Search party, bill no., uploaded by"}
                  aria-label={kind === "lr" ? "Search the LRs" : "Search the signed copies"}
                  className="pl-8"
                />
              </div>
            </div>
          ) : null}
          {visible.length ? (
            <div className="max-h-[72vh] overflow-y-auto">
              {visible.map((r) => (
                <button
                  key={r.l.id}
                  type="button"
                  onClick={() => setPick(r.l.id)}
                  className={cx("flex w-full cursor-pointer items-center gap-3 border-b border-divider px-3 py-2 text-left last:border-0", sel?.l.id === r.l.id ? "bg-brand-soft" : "hover:bg-canvas")}
                >
                  <Thumb fileId={r.l.fileId} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{titleOf(r)}</span>
                    <span className="flex items-center gap-1 truncate text-meta text-muted">
                      <Icon n={r.l.fromPhone ? "phone" : "file"} s={12} />
                      {[r.l.uploadedBy, clock(new Date(r.l.uploadedAt)), subOf(r)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <StateIcon state={r.state} />
                </button>
              ))}
            </div>
          ) : list.length ? (
            <Empty>Nothing matches “{copyQuery.trim()}”.</Empty>
          ) : (
            <Empty>{kind === "lr" ? "No LR is waiting. The dispatch team uploads them from the phone." : "No signed copy is waiting. Copies for Mahek Vehicle deliveries arrive here from the phone."}</Empty>
          )}
        </Card>

        {sel ? (
          sel.flag ? (
            <DuplicatePanel key={sel.l.id} row={sel} other={copies.find((c) => c.id === sel.flag!.ofId) ?? null} canWrite={canWrite} />
          ) : (
            <Detail
              key={`${sel.l.id}|${sel.l.fileId}|${preTick ?? ""}`}
              row={sel}
              preTick={preTick}
              prev={at > 0 ? () => setPick(visible[at - 1].l.id) : null}
              next={at < visible.length - 1 ? () => setPick(visible[at + 1].l.id) : null}
              today={today}
              transporters={transporters}
              callEveryDays={callEveryDays}
              notifyOn={notifyOn}
              canWrite={canWrite}
              showAll={showAll}
              setShowAll={setShowAll}
              moreToShow={onTheWay.length > 0}
              hidden={showAll ? [] : onTheWayBills}
            />
          )
        ) : (
          <Card>
            <Empty>{list.length && !visible.length ? "Nothing on the desk matches the search." : "Pick a copy on the left."}</Empty>
          </Card>
        )}
      </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------ the Pending tab */

const PENDING_ORDER: PendingKind[] = ["noLr", "atTransport", "awaitingLr", "signedCopy"];

/**
 * The bills still waiting for their paper, in the same fixed-height list the
 * copies use, so a hundred of them scroll inside the box and never push the
 * page. Picking one shows the copies on the desk that may be it.
 */
function PendingDesk({
  items,
  rows,
  stuckLrDays,
  canWrite,
  onOpen,
  transporters,
}: {
  items: PendingBill[];
  rows: Row[];
  stuckLrDays: number;
  canWrite: boolean;
  onOpen: (copyId: string, kind: ProofKind, bill: Bill) => void;
  /** The active transporter list — a bill naming something else is flagged for a person to settle. */
  transporters: string[];
}) {
  const listed = useMemo(() => new Set(transporters.map((t) => t.trim().toLowerCase())), [transporters]);
  const offList = (p: PendingBill) => !p.b.c.ownVehicle && !p.b.c.lrId && !listed.has((p.b.c.transporter ?? "").trim().toLowerCase());
  const [filter, setFilter] = useState<PendingKind | "all" | "offList">("all");
  const [pick, setPick] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /* The chips count the whole kind; the search narrows inside whichever chip is on. */
  const ofKind = filter === "all" ? items : filter === "offList" ? items.filter(offList) : items.filter((p) => p.kind === filter);
  const shown = query.trim() ? ofKind.filter((p) => billMatches(p.b, query)) : ofKind;
  const sel = shown.find((p) => p.b.key === pick) ?? shown[0] ?? null;
  const chip = (k: PendingKind | "all" | "offList", label: string, n: number) => (
    <button key={k} type="button" onClick={() => (setFilter(k), setPick(null))} className={toggleClass(filter === k, "flex items-center gap-1 text-meta")}>
      {label} <span className="tabular-nums">{n}</span>
    </button>
  );

  return (
    <div className="grid grid-cols-[minmax(280px,360px)_minmax(0,1fr)] items-start gap-4">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap gap-1 border-b border-divider p-2">
          {chip("all", "All", items.length)}
          {PENDING_ORDER.map((k) => chip(k, pendingLabel(k, stuckLrDays), items.filter((p) => p.kind === k).length))}
          {items.some(offList) ? chip("offList", "Not a listed transporter", items.filter(offList).length) : null}
        </div>
        {items.length ? (
          <div className="border-b border-divider p-2">
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
                <Icon n="search" s={14} />
              </span>
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search party, bill no., order no., transporter, city" aria-label="Search the pending bills" className="pl-8" />
            </div>
          </div>
        ) : null}
        <div className="border-b border-divider px-3 py-1.5 text-meta text-muted">
          {query.trim() ? `${shown.length} of ${plural(ofKind.length, "bill")}` : plural(shown.length, "bill")}, longest waiting first
        </div>
        {shown.length ? (
          <div className="max-h-[72vh] overflow-y-auto">
            {shown.map((p) => (
              <button
                key={p.b.key}
                type="button"
                onClick={() => setPick(p.b.key)}
                className={cx("flex w-full cursor-pointer items-center gap-3 border-b border-divider px-3 py-2 text-left last:border-0", sel?.b.key === p.b.key ? "bg-brand-soft" : "hover:bg-canvas")}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{p.b.c.party}</span>
                  <span className="block truncate text-meta text-muted">
                    {[p.b.c.billNo ?? `Order ${p.b.c.orderNo}`, p.b.c.ownVehicle ? (p.b.c.vehicleNo ?? directWho(p.b.c.transporter)) : p.b.c.transporter].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className={cx("shrink-0 text-meta font-semibold tabular-nums", p.kind === "noLr" ? "text-danger" : p.kind === "awaitingLr" ? "text-muted" : "text-warn-ink")}>{plural(p.days, "day")}</span>
              </button>
            ))}
          </div>
        ) : (
          <Empty>{query.trim() && ofKind.length ? `No pending bill matches “${query.trim()}”.` : items.length ? "Nothing pending of this kind." : "Nothing is pending. Every bill has its LR or signed copy."}</Empty>
        )}
      </Card>

      {sel ? (
        <PendingDetail key={sel.b.key} item={sel} rows={rows} stuckLrDays={stuckLrDays} canWrite={canWrite} onOpen={onOpen} transporters={transporters} offList={offList(sel)} />
      ) : (
        <Card>
          <Empty>Pick a bill on the left.</Empty>
        </Card>
      )}
    </div>
  );
}

function PendingDetail({
  item,
  rows,
  stuckLrDays,
  canWrite,
  onOpen,
  transporters,
  offList,
}: {
  item: PendingBill;
  rows: Row[];
  stuckLrDays: number;
  canWrite: boolean;
  onOpen: (copyId: string, kind: ProofKind, bill: Bill) => void;
  transporters: string[];
  /** Its transporter is not on the list — usually a vehicle number typed where the company belongs. */
  offList: boolean;
}) {
  const { run, pending } = useAct();
  const [changing, setChanging] = useState(false);
  const { b } = item;
  const c = b.c;
  const copyKind: ProofKind = c.ownVehicle ? "signed_copy" : "lr";
  const word = copyKind === "lr" ? "LR" : "signed copy";
  /*
   * The copies on the desk ranked against this one bill, by the same rules the
   * copy's own tab uses. A transporter's bill can be closed by a signed copy
   * too, so for one of those both kinds are looked at.
   */
  const matches = rows
    .filter((r) => r.l.kind === copyKind || copyKind === "lr")
    .map((r) => {
      const x =
        r.l.kind === "lr"
          ? rankForLr(r.l, [{ id: b.key, transporter: c.transporter, packages: b.packages, area: c.area ?? c.partyCity, party: c.deliveryParty, billingParty: c.party, billNo: c.billNo, atTransport: b.rows.every((y) => y.phase === "lrPending") }])[0]
          : rankForSignedCopy(r.l, [{ id: b.key, billNo: c.billNo, party: c.deliveryParty, vehicleNo: c.vehicleNo }])[0];
      return { r, score: x.score, reasons: x.reasons };
    })
    .filter((m) => m.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, 6);
  const toTransport = b.rows.filter((y) => y.phase === "toTransport");

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-3 border-b border-divider px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold text-ink">{partyLine(c)}</div>
          <div className="flex flex-wrap items-center gap-2 text-meta text-muted">
            <BillRef c={c} />
            {[c.billDate ? shortDay(c.billDate) : null, b.packages != null ? plural(b.packages, "box", "boxes") : null, c.ownVehicle ? [directWho(c.transporter), c.vehicleNo].filter(Boolean).join(" ") : c.transporter].filter(Boolean).join(" · ")}
          </div>
        </div>
        <Badge label={`${pendingLabel(item.kind, stuckLrDays)} · ${plural(item.days, "day")}`} tone={item.kind === "noLr" ? "danger" : item.kind === "awaitingLr" ? "muted" : "warn"} />
      </div>

      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-4">
          {c.ownVehicle ? (
            driverPhone(c.driver) ? <CallLink phone={driverPhone(c.driver)} name={c.driver ?? "Driver"} /> : <span className="text-xs text-muted">No driver number on this bill</span>
          ) : (
            <CallLink phone={c.transporterPhone} name={c.transporter} />
          )}
          {canWrite && toTransport.length ? (
            <Button size="sm" disabled={pending} onClick={() => run(() => erpLogisticsAtTransport(toTransport.map((y) => y.id)))} title="The goods are at the transporter's godown">
              Reached transporter
            </Button>
          ) : null}
          {canWrite && !c.lrId ? (
            <Button size="sm" variant="ghost" className="ml-auto" disabled={pending} onClick={() => setChanging(true)} title="Who takes it to the party — a transporter or a Mahek Vehicle">
              Delivered by…
            </Button>
          ) : null}
        </div>

        {offList ? (
          <div className="flex flex-wrap items-center gap-2 rounded-card bg-warn-soft px-3 py-2 text-sm text-warn-ink">
            <Icon n="warn" s={14} />
            <span className="min-w-0 flex-1">
              “{c.transporter || "No transporter"}” is not on the transporter list. If it went in our own vehicle, set it to Mahek Vehicle — the signed copy then closes it. Otherwise pick the transporter.
            </span>
            {canWrite ? (
              <Button size="sm" disabled={pending} onClick={() => setChanging(true)}>
                Fix
              </Button>
            ) : null}
          </div>
        ) : null}

        <div>
          <SubTitle className="mb-1">{copyKind === "lr" ? "LRs and signed copies on the desk that may be this bill" : "Signed copies on the desk that may be this bill"}</SubTitle>
          {matches.length ? (
            <div className="rounded-card border border-line">
              {matches.map(({ r, reasons }) => (
                <div key={r.l.id} className="flex flex-wrap items-center gap-3 border-b border-divider px-3 py-2 text-sm last:border-0">
                  <Thumb fileId={r.l.fileId} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">{titleOf(r)}</span>
                    <span className="block truncate text-meta text-muted">{[subOf(r), `uploaded ${clock(new Date(r.l.uploadedAt))}`].filter(Boolean).join(" · ")}</span>
                  </span>
                  {copyKind === "lr" && r.l.kind === "signed_copy" ? <Badge label="Signed copy" tone="brand" /> : null}
                  {reasons.slice(0, 2).map((x) => (
                    <Badge key={x} label={x} tone={x.startsWith("same") || x === "destination matches" ? "success" : "neutral"} />
                  ))}
                  <Button size="sm" variant="primary" onClick={() => onOpen(r.l.id, r.l.kind, b)}>
                    Check and attach
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <Empty>No {word} on the desk looks like this bill. It has not been uploaded yet — ring and ask for it.</Empty>
          )}
        </div>
      </div>
      {changing ? <DeliveredByDialog key={b.key} group={b.rows} transporters={transporters} onClose={() => setChanging(false)} /> : null}
    </Card>
  );
}

/*
 * A COPY IS NAMED BY ITS BILLING PARTY, DETECTED. The AI reads the consignee
 * off the photo — the delivery party, and sometimes our own name misread from
 * the consignor box — so the desk names a copy by who is BILLED on the bill it
 * belongs to: the bill whose number the copy names, else the one the desk is
 * sure of, else the best bill whose party matches the consignee. Only where no
 * bill can be found does it fall back to what was read, then the transporter.
 */
function billOf(r: Row): Bill | null {
  const hit =
    r.ranked.find((x) => x.reasons.includes("same bill no.")) ??
    (r.pick ? r.ranked.find((x) => x.b.key === r.pick) : undefined) ??
    r.ranked.find((x) => x.reasons.includes("same party") && x.score > 0);
  return hit?.b ?? null;
}

function titleOf(r: Row): string {
  const l = r.l;
  const billed = billOf(r)?.c.party;
  if (billed) return billed;
  if (l.kind === "signed_copy") return l.partyHint ?? (l.billHint ? `Bill ${l.billHint}` : "Not read");
  return l.partyHint ?? l.transporter ?? (l.lrNo ? lrLabel(l.lrNo) : "Not read");
}

function subOf(r: Row): string | null {
  const l = r.l;
  const named = billOf(r) != null || !!l.partyHint;
  if (l.kind === "signed_copy") return named && l.billHint ? l.billHint : null;
  const no = l.lrNo ?? (l.readLrNo ? `${l.readLrNo}?` : null);
  /* A party is the title once one is known, so the transporter moves down beside the number. */
  return named && l.transporter ? [l.transporter, no].filter(Boolean).join(" ") : no;
}

function Tally({ icon, tone, n, label }: { icon: string; tone: string; n: number; label: string }) {
  if (!n) return null;
  return (
    <span className={cx("flex items-center gap-1 font-semibold", tone)} title={label}>
      <Icon n={icon} s={14} />
      {n}
    </span>
  );
}

function StateIcon({ state }: { state: State }) {
  const m: Record<State, { n: string; tone: string; label: string } | null> = {
    ready: { n: "check", tone: "text-success", label: "Ready to attach" },
    todo: { n: "warn", tone: "text-warn-ink", label: "Something to add or fix" },
    dup: { n: "copy", tone: "text-danger", label: "Possible duplicate" },
    reading: { n: "clock", tone: "text-muted", label: "Being read" },
    pick: null,
  };
  const v = m[state];
  if (!v) return <span className="h-4 w-4" />;
  return (
    <span className={cx("flex", v.tone)} title={v.label} aria-label={v.label}>
      <Icon n={v.n} />
    </span>
  );
}

function Thumb({ fileId, size = 40 }: { fileId: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <span style={{ width: size * 0.78, height: size }} className="flex flex-none items-center justify-center overflow-hidden rounded-control border border-line bg-canvas text-2xs text-muted">
      {!fileId ? (
        "—"
      ) : broken ? (
        "PDF"
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/attachments/${fileId}`} alt="" className="h-full w-full object-cover" onError={() => setBroken(true)} />
      )}
    </span>
  );
}

/** The photo, large, with the few tools it needs. A PDF opens in its own tab. */
function Viewer({ l, prev, next, canWrite }: { l: UploadedLr; prev: (() => void) | null; next: (() => void) | null; canWrite: boolean }) {
  const [broken, setBroken] = useState(false);
  const [editing, setEditing] = useState(false);
  const href = l.fileId ? `/api/attachments/${l.fileId}` : null;
  return (
    <div className="flex w-[300px] flex-none flex-col items-center gap-2">
      <div className="flex h-[380px] w-full items-center justify-center overflow-hidden rounded-card bg-canvas">
        {!href ? (
          <span className="text-meta text-muted">No photo</span>
        ) : broken ? (
          <a href={href} target="_blank" rel="noreferrer" className="flex flex-col items-center gap-1 text-meta text-muted">
            <Icon n="file" s={32} />
            Open the PDF
          </a>
        ) : (
          <a href={href} target="_blank" rel="noreferrer" className="h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={href} alt={l.kind === "lr" ? "LR" : "Signed copy"} className="h-full w-full object-contain" onError={() => setBroken(true)} />
          </a>
        )}
      </div>
      <div className="flex gap-1">
        <IconButton label="Previous" disabled={!prev} onClick={() => prev?.()}>
          <Icon n="back" />
        </IconButton>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" aria-label="Open full size" title="Open full size" className="flex h-8 w-8 items-center justify-center rounded-control text-muted hover:bg-canvas hover:text-body">
            <Icon n="zoom" />
          </a>
        ) : null}
        {canWrite && href && !broken ? (
          <IconButton label="Crop or rotate" onClick={() => setEditing(true)}>
            <Icon n="crop" />
          </IconButton>
        ) : null}
        <IconButton label="Next" disabled={!next} onClick={() => next?.()}>
          <Icon n="chev" />
        </IconButton>
      </div>
      {editing && l.fileId ? <PhotoEditor lrId={l.id} fileId={l.fileId} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

function Detail({
  row,
  preTick,
  prev,
  next,
  today,
  transporters,
  callEveryDays,
  notifyOn,
  canWrite,
  showAll,
  setShowAll,
  moreToShow,
  hidden,
}: {
  row: Row;
  /** A bill a pending row asked for: ticked from the start in place of the desk's own pick. */
  preTick: string | null;
  prev: (() => void) | null;
  next: (() => void) | null;
  today: string;
  transporters: string[];
  callEveryDays: number;
  notifyOn: boolean;
  canWrite: boolean;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  moreToShow: boolean;
  /** Bills not yet at the transporter while they are left out — searched only to say a match is there. */
  hidden: Bill[];
}) {
  const { run, pending } = useAct();
  const l = row.l;
  const lr = l.kind === "lr";
  const initial = {
    lrNo: l.lrNo ?? "",
    lrDate: l.lrDate ?? today,
    transporter: l.transporter ?? "",
    destination: l.destination ?? "",
    packages: l.packages == null ? "" : String(l.packages),
    freightTerm: l.freightTerm ?? "",
    freight: l.freightPaise == null ? "" : rupeesField(l.freightPaise),
    note: l.note ?? "",
    billHint: l.billHint ?? "",
    partyHint: l.partyHint ?? "",
    receivedBy: l.receivedBy ?? "",
    deliveredOn: l.deliveredOn ?? today,
  };
  const [v, setV] = useState(initial);
  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).some((k) => v[k] !== initial[k]);
  const set = (k: keyof typeof initial) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(preTick ? [preTick] : row.pick ? [row.pick] : []));
  const [expected, setExpected] = useState("");
  const [nextCall, setNextCall] = useState(addDays(today, callEveryDays));
  const [notify, setNotify] = useState(true);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState<string | null>(null);

  /* What the AI read but did not write — unsure, or already on another LR — offered to the person. */
  const offered = lr && !l.lrNo && l.readLrNo ? l.readLrNo : null;
  /*
   * Every bill waiting for an LR, best match first: ten at a time, narrowed by
   * the search. A ticked bill the filter or the page leaves out is still drawn,
   * at the bottom — a ticked bill the list did not draw could not be unticked.
   */
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(ATTACH_PAGE);
  const matching = query.trim() ? row.ranked.filter((x) => billMatches(x.b, query)) : row.ranked;
  const page = matching.slice(0, limit);
  const onPage = new Set(page.map((x) => x.b.key));
  const shown = [...page, ...row.ranked.filter((x) => ticked.has(x.b.key) && !onPage.has(x.b.key))];
  const left = matching.length - page.length;
  const hiddenMatches = lr && query.trim() ? hidden.filter((b) => billMatches(b, query)).length : 0;
  const searchable = row.ranked.length > 0;
  const selBills = row.ranked.filter((x) => ticked.has(x.b.key));
  const selIds = selBills.flatMap((x) => x.b.rows.map((c) => c.id));
  const parties = new Set(selBills.flatMap((x) => x.b.rows.map((c) => c.deliveryPartyId)));
  const boxes = sumPackages(selBills.flatMap((x) => x.b.rows));
  /* A ticked bill going to a shop the LR does not name — said, never refused: a consignee can be written as a person, or as the buyer. */
  const otherParty = lr && partyWords(l.partyHint).length ? selBills.find((x) => !sameParty(l.partyHint, x.b.c.deliveryParty) && !sameParty(l.partyHint, x.b.c.party)) : undefined;

  const save = () =>
    run(() =>
      erpLogisticsEditLr(
        l.id,
        lr
          ? { lrNo: v.lrNo, lrDate: v.lrDate, transporter: v.transporter, destination: v.destination, packages: v.packages ? Number(v.packages) : null, freightTerm: v.freightTerm || null, freightRupees: v.freight ? Number(v.freight) : null, partyHint: v.partyHint, billHint: v.billHint, note: v.note }
          : { billHint: v.billHint, partyHint: v.partyHint, receivedBy: v.receivedBy, deliveredOn: v.deliveredOn, note: v.note },
      ),
    );

  const attach = () =>
    lr
      ? run(() => erpLogisticsAttach(l.id, selIds, { expectedOn: expected || null, nextCallOn: nextCall || null, notify }))
      : run(() => erpLogisticsDelivered(selIds, { date: v.deliveredOn || today, receivedBy: v.receivedBy || null, signedCopyId: l.id, notify }));

  const blocked = !selIds.length
    ? lr
      ? "Tick the bills this LR carries"
      : "Tick the delivery this copy closes"
    : parties.size > 1
      ? "One copy goes to one party"
      : lr && (!l.lrNo || dirty)
        ? "Save the LR number first"
        : !lr && !v.receivedBy.trim()
          ? "Say who signed for it"
          : null;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-2.5 text-meta text-muted">
        <Icon n={l.fromPhone ? "phone" : "file"} s={14} />
        <span>{[l.uploadedBy, stamp(l.uploadedAt)].filter(Boolean).join(" · ")}</span>
        <span className="flex-1" />
        {row.missing.length ? <Badge label={`Needs ${row.missing.join(", ")}`} tone="warn" /> : row.state === "ready" ? <Badge label="Ready" tone="success" /> : null}
      </div>

      {row.wrong ? (
        <div className="flex items-center gap-2 border-b border-divider bg-warn-soft px-4 py-2 text-sm text-warn-ink">
          <Icon n="warn" s={14} />
          <span className="flex-1">Looks like {row.wrong === "lr" ? "an LR" : "a signed copy"}</span>
          {canWrite ? (
            <Button size="sm" disabled={pending} onClick={() => run(() => erpLogisticsSetKind(l.id, row.wrong!))}>
              Move to {row.wrong === "lr" ? "LRs" : "signed copies"}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex gap-5 p-4">
        <Viewer l={l} prev={prev} next={next} canWrite={canWrite} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {lr ? (
            <>
              <datalist id="desk-transporters">
                {transporters.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Transporter">
                  <Input list="desk-transporters" value={v.transporter} onChange={set("transporter")} disabled={!canWrite} />
                </Field>
                <Field label="LR no.">
                  <Input value={v.lrNo} onChange={set("lrNo")} placeholder={offered ? `Read ${offered} — check it` : "Type from the photo"} disabled={!canWrite} className={cx(!v.lrNo && "border-warn")} />
                </Field>
                <Field label="LR date">
                  <Input type="date" value={v.lrDate} max={today} onChange={set("lrDate")} disabled={!canWrite} />
                </Field>
                <Field label="Boxes">
                  <Input inputMode="numeric" value={v.packages} onChange={set("packages")} disabled={!canWrite} />
                </Field>
                <Field label="Consignee">
                  <Input value={v.partyHint} onChange={set("partyHint")} placeholder="The party on the LR" disabled={!canWrite} />
                </Field>
                <Field label="Our invoice no.">
                  <Input value={v.billHint} onChange={set("billHint")} placeholder="If the LR shows it" disabled={!canWrite} />
                </Field>
                <Field label="Destination">
                  <Input value={v.destination} onChange={set("destination")} disabled={!canWrite} />
                </Field>
                <Field label="Freight">
                  <Select value={v.freightTerm} onChange={set("freightTerm")} disabled={!canWrite}>
                    <option value="">—</option>
                    <option>Paid</option>
                    <option>To pay</option>
                    <option>TBB</option>
                  </Select>
                </Field>
              </div>
              {offered && !v.lrNo && canWrite ? (
                <LinkButton onClick={() => setV({ ...v, lrNo: offered })} className="self-start">
                  Use {offered}
                </LinkButton>
              ) : null}
            </>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Bill no.">
                <Input value={v.billHint} onChange={set("billHint")} disabled={!canWrite} />
              </Field>
              <Field label="Party">
                <Input value={v.partyHint} onChange={set("partyHint")} disabled={!canWrite} />
              </Field>
              <Field label="Delivered on">
                <Input type="date" value={v.deliveredOn} max={today} onChange={set("deliveredOn")} disabled={!canWrite} />
              </Field>
              <Field label="Received by">
                <Input value={v.receivedBy} onChange={set("receivedBy")} placeholder="Name on the copy" disabled={!canWrite} className={cx(!v.receivedBy && "border-warn")} />
              </Field>
            </div>
          )}
          {l.note ? <p className="text-meta text-body">“{l.note}”</p> : null}
          {canWrite && dirty ? (
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setV(initial)}>
                Undo
              </Button>
              <Button size="sm" variant="primary" disabled={pending} onClick={save}>
                Save
              </Button>
            </div>
          ) : null}

          <div>
            <SubTitle className="mb-1" aside={lr && moreToShow ? (
              <label className="flex cursor-pointer items-center gap-1.5 text-meta font-normal text-muted">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className={checkboxClass} />
                Also bills not yet at the transporter
              </label>
            ) : undefined}>
              {lr ? "Attach to" : "Closes"}
            </SubTitle>
            {searchable ? (
              <div className="mb-1.5 flex items-center gap-2">
                <div className="relative flex-1">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
                    <Icon n="search" s={14} />
                  </span>
                  <Input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setLimit(ATTACH_PAGE);
                    }}
                    placeholder="Search party, bill no., order no., transporter, city"
                    aria-label="Search the bills"
                    className="pl-8"
                  />
                </div>
                <span className="shrink-0 text-meta text-muted">
                  {query.trim() ? `${matching.length} of ${plural(row.ranked.length, "bill")}` : plural(row.ranked.length, "bill")} {lr ? "waiting for an LR" : "not yet delivered"}
                </span>
              </div>
            ) : null}
            {shown.length ? (
              <div className="max-h-[340px] overflow-y-auto rounded-card border border-line">
                {shown.map(({ b, reasons }) => (
                  <label key={b.key} className={cx("flex cursor-pointer items-center gap-3 border-b border-divider px-3 py-2 text-sm last:border-0", ticked.has(b.key) && "bg-brand-soft/50")}>
                    <input
                      type="checkbox"
                      disabled={!canWrite}
                      checked={ticked.has(b.key)}
                      onChange={() =>
                        setTicked((s) => {
                          const n = new Set(s);
                          if (n.has(b.key)) n.delete(b.key);
                          else n.add(b.key);
                          return n;
                        })
                      }
                      className={checkboxClass}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{partyLine(b.c)}</span>
                      <span className="flex items-center gap-2 text-meta text-muted">
                        <BillRef c={b.c} />
                        {[b.c.billDate ? shortDay(b.c.billDate) : null, b.packages != null ? plural(b.packages, "box", "boxes") : null, lr || !b.c.ownVehicle ? b.c.transporter : (b.c.vehicleNo ?? directWho(b.c.transporter))].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {reasons.slice(0, 2).map((r) => (
                      <Badge key={r} label={r} tone={r.startsWith("same") || r === "destination matches" ? "success" : "neutral"} />
                    ))}
                  </label>
                ))}
                {left > 0 ? (
                  <div className="flex items-center justify-center gap-4 px-3 py-2 text-meta">
                    <LinkButton onClick={() => setLimit((n) => n + ATTACH_PAGE)}>Show {Math.min(ATTACH_PAGE, left)} more</LinkButton>
                    {left > ATTACH_PAGE ? <LinkButton onClick={() => setLimit(matching.length)}>Show all {matching.length}</LinkButton> : null}
                  </div>
                ) : null}
              </div>
            ) : query.trim() ? (
              <Empty>No bill matches “{query.trim()}”.</Empty>
            ) : (
              <Empty>{lr ? "No bill is waiting for an LR." : "No bill is waiting to be delivered."}</Empty>
            )}
            {hiddenMatches ? (
              <p className="mt-1.5 text-meta text-muted">
                {plural(hiddenMatches, "more bill")} not yet at the transporter {hiddenMatches === 1 ? "matches" : "match"}.{" "}
                <LinkButton onClick={() => setShowAll(true)}>Show {hiddenMatches === 1 ? "it" : "them"}</LinkButton>
              </p>
            ) : null}
          </div>

          {canWrite && row.ranked.length ? (
            <div className="flex flex-wrap items-end gap-3">
              {lr ? (
                <>
                  <Field label="Expected delivery" className="w-40">
                    <Input type="date" value={expected} min={v.lrDate || today} onChange={(e) => setExpected(e.target.value)} />
                  </Field>
                  <Field label="Next call" className="w-40">
                    <Input type="date" value={nextCall} min={today} onChange={(e) => setNextCall(e.target.value)} />
                  </Field>
                </>
              ) : null}
              <div className="min-w-[220px] flex-1">
                <NotifyToggle value={notify} onChange={setNotify} disabled={!notifyOn} />
              </div>
            </div>
          ) : null}

          {canWrite ? (
            <div className="flex items-center gap-2 border-t border-divider pt-3">
              <IconButton label={`Discard this ${lr ? "LR" : "copy"}`} tone="danger" onClick={() => setVoiding(true)}>
                <Icon n="bin" />
              </IconButton>
              <span className="flex-1 text-meta text-muted">
                {selIds.length ? `${plural(selBills.length, "bill")}${boxes != null ? ` · ${plural(boxes, "box", "boxes")}` : ""}` : ""}
                {lr && l.packages != null && boxes != null && boxes !== l.packages ? <span className="ml-2 text-warn-ink">The LR says {l.packages}</span> : null}
                {otherParty ? <span className="ml-2 text-warn-ink">The LR is for {l.partyHint}, not {otherParty.b.c.party}</span> : null}
              </span>
              <Button variant="primary" disabled={pending || !!blocked} title={blocked ?? undefined} onClick={attach}>
                {lr ? `Attach${selBills.length ? ` to ${plural(selBills.length, "bill")}` : ""}` : "Attach & mark delivered"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <ReasonDialog
        open={voiding}
        title={`Discard this ${PROOF_WORD[l.kind].toLowerCase()}?`}
        body="It leaves the desk and stays on record with your reason. Use it for a wrong or useless upload."
        keepLabel="Keep it"
        confirmLabel="Discard"
        tone="danger"
        pending={pending}
        onClose={() => setVoiding(false)}
        onConfirm={(reason) => {
          setVoiding(false);
          setVoidReason(reason);
        }}
      />
      {voidReason ? <ErpImpactDialog kind="erp-lr-void" id={l.id} confirmLabel="Discard" onClose={() => setVoidReason(null)} act={(confirmation) => erpLogisticsVoidLr(l.id, voidReason, confirmation)} /> : null}
    </Card>
  );
}

/** Two papers side by side, and one question: are they the same? */
function DuplicatePanel({ row, other, canWrite }: { row: Row; other: UploadedLr | null; canWrite: boolean }) {
  const { run, pending } = useAct();
  const f = row.flag!;
  const side = (l: UploadedLr | null, label: string) => (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
      <span className="text-meta font-semibold text-muted">{label}</span>
      <div className="flex h-[340px] w-full items-center justify-center overflow-hidden rounded-card bg-canvas">
        {l?.fileId ? (
          <a href={`/api/attachments/${l.fileId}`} target="_blank" rel="noreferrer" className="h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/attachments/${l.fileId}`} alt="" className="h-full w-full object-contain" />
          </a>
        ) : (
          <span className="text-meta text-muted">No photo</span>
        )}
      </div>
      {l ? (
        <span className="text-center text-sm">
          <b className="font-mono">{l.kind === "lr" ? (l.lrNo ?? l.readLrNo ?? "—") : (l.billHint ?? "—")}</b>
          <span className="text-muted"> · {[l.kind === "lr" ? l.transporter : l.partyHint, l.lrDate ? shortDay(l.lrDate) : null, l.packages != null ? `${l.packages} boxes` : null].filter(Boolean).join(" · ")}</span>
        </span>
      ) : null}
    </div>
  );
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-divider px-4 py-2.5 text-sm">
        <span className="flex items-center gap-1.5 font-semibold text-danger">
          <Icon n="copy" s={15} />
          {f.kind === "check" ? "Looks like the same paper" : f.kind === "attached" ? "Already attached" : "Duplicate"}
        </span>
        <span className="flex-1 text-meta text-muted">{f.why}</span>
      </div>
      <div className="flex gap-4 p-4">
        {side(row.l, `This upload · ${clock(new Date(row.l.uploadedAt))}`)}
        {side(other, other ? `${other.status === "assigned" ? `Attached to ${plural(other.bills, "bill")}` : "On the desk"} · ${clock(new Date(other.uploadedAt))}` : "Earlier upload")}
      </div>
      {canWrite ? (
        <div className="flex justify-end gap-2 border-t border-divider px-4 py-3">
          <Button disabled={pending} onClick={() => run(() => erpLogisticsClearDuplicate(row.l.id))}>
            Different — keep both
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => run(() => erpLogisticsDiscardDuplicate(row.l.id))}>
            Same — discard this one
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
