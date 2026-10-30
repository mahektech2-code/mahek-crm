"use client";

import { useMemo, useState } from "react";
import { Button, Card, checkboxClass, cx, Field, Input, Select } from "@/components/ui/primitives";
import { Badge } from "../../_ui/badge";
import { IconButton, LinkButton, SubTitle, toggleClass } from "../../_ui/look";
import { Icon } from "../../_ui/icons";
import { ErpImpactDialog } from "../../_ui/impact-confirm";
import {
  erpLogisticsAttach,
  erpLogisticsAttachReady,
  erpLogisticsClearDuplicate,
  erpLogisticsDelivered,
  erpLogisticsDiscardDuplicate,
  erpLogisticsEditLr,
  erpLogisticsSetKind,
  erpLogisticsVoidLr,
} from "@/lib/actions/erp-logistics";
import { addDays, PROOF_WORD, rankForLr, shortDay, type ProofKind } from "@/lib/erp/engines/logistics";
import { confidentPick, duplicateFlags, missingFor, rankForSignedCopy, READY_SCORE, wrongKind, type DeskCopy, type DupFlag } from "@/lib/erp/engines/delivery-proof";
import type { Consignment, UploadedLr } from "@/lib/erp/logistics";
import { rupeesField } from "@/lib/erp/ui";
import { clock, stamp } from "@/lib/format";
import { BillRef, Empty, NotifyToggle, plural, ReasonDialog, sumPackages, useAct, lrLabel } from "./common";
import { PhotoEditor } from "./photo-editor";

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
 * ------------------------------------------------------------------------- */

type Bill = { key: string; c: Consignment; rows: Consignment[]; packages: number | null };

/** One bill raised on several orders is several transport records and still one bill to attach. */
function byBill(cs: Consignment[]): Bill[] {
  const out = new Map<string, Consignment[]>();
  for (const c of cs) {
    const k = c.billNo?.trim() ? `${c.partyId}|${c.billNo.trim().toUpperCase()}` : c.id;
    out.set(k, [...(out.get(k) ?? []), c]);
  }
  return [...out].map(([key, rows]) => ({ key, c: rows[0], rows, packages: sumPackages(rows) }));
}

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
type State = "dup" | "reading" | "todo" | "ready" | "pick";
type Row = { l: UploadedLr; flag: DupFlag | null; wrong: ProofKind | null; missing: string[]; ranked: Ranked; pick: string | null; state: State };

const READING_MINUTES = 15;

export function DocumentsDesk({
  copies,
  waiting,
  onTheWay,
  ownOnRoad,
  today,
  nowMs,
  transporters,
  callEveryDays,
  notifyOn,
  canWrite,
  canRead,
  initialKind = "lr",
}: {
  /** Every live copy: those on the desk, and the recently attached ones the duplicate check compares against. */
  copies: UploadedLr[];
  waiting: Consignment[];
  onTheWay: Consignment[];
  /** Mahek Vehicle bills still on the road — what a signed copy closes. */
  ownOnRoad: Consignment[];
  today: string;
  nowMs: number;
  transporters: string[];
  callEveryDays: number;
  notifyOn: boolean;
  canWrite: boolean;
  canRead: boolean;
  initialKind?: ProofKind;
}) {
  const { run, pending } = useAct();
  const [kind, setKind] = useState<ProofKind>(initialKind);
  const [pick, setPick] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const flags = useMemo(() => duplicateFlags(copies.map(toDesk)), [copies]);
  const waitingBills = useMemo(() => byBill(waiting), [waiting]);
  const allLrBills = useMemo(() => byBill([...waiting, ...onTheWay]), [waiting, onTheWay]);
  const ownBills = useMemo(() => byBill(ownOnRoad), [ownOnRoad]);

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
              ? rankForLr(l, (showAll ? allLrBills : waitingBills).map((b) => ({ id: b.key, transporter: b.c.transporter, packages: b.packages, area: b.c.area ?? b.c.partyCity, party: b.c.deliveryParty, atTransport: b.rows.every((c) => c.phase === "lrPending") }))).map((x) => ({
                  b: (showAll ? allLrBills : waitingBills).find((p) => p.key === x.id)!,
                  score: x.score,
                  reasons: x.reasons,
                }))
              : rankForSignedCopy(l, ownBills.map((b) => ({ id: b.key, billNo: b.c.billNo, party: b.c.deliveryParty, vehicleNo: b.c.vehicleNo }))).map((x) => ({ b: ownBills.find((p) => p.key === x.id)!, score: x.score, reasons: x.reasons }));
          const sure = confidentPick(ranked.map((r) => ({ id: r.b.key, score: r.score })), READY_SCORE[l.kind]);
          const reading = canRead && !l.readAt && nowMs - Date.parse(l.uploadedAt) < READING_MINUTES * 60_000;
          const state: State = flag ? "dup" : reading ? "reading" : wrong || missing.length ? "todo" : sure ? "ready" : "pick";
          return { l, flag, wrong, missing, ranked, pick: sure, state };
        }),
    [copies, flags, waitingBills, allLrBills, ownBills, showAll, canRead, nowMs],
  );

  const list = rows.filter((r) => r.l.kind === kind);
  const count = (k: ProofKind) => rows.filter((r) => r.l.kind === k).length;
  const sel = list.find((r) => r.l.id === pick) ?? list[0] ?? null;
  const at = sel ? list.indexOf(sel) : -1;
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
            <button key={k} type="button" onClick={() => (setKind(k), setPick(null))} className={toggleClass(kind === k, "flex items-center gap-1.5")}>
              {k === "lr" ? "LRs" : "Signed copies"}
              <Badge label={String(count(k))} tone={kind === k ? "brand" : "muted"} />
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {canWrite && ready.length ? (
          <Button variant="primary" disabled={pending} onClick={attachReady} title={kind === "lr" ? "Attach every LR whose bill the desk is sure of" : "Close every delivery whose signed copy the desk is sure of"}>
            {kind === "lr" ? `Attach ${ready.length} ready` : `Close ${ready.length} ready`}
          </Button>
        ) : null}
      </div>

      <div className="grid grid-cols-[minmax(280px,360px)_minmax(0,1fr)] items-start gap-4">
        <Card className="overflow-hidden">
          <div className="flex items-center gap-3 border-b border-divider px-3 py-2 text-meta">
            <Tally icon="check" tone="text-success" n={tally("ready")} label="Ready to attach" />
            <Tally icon="warn" tone="text-warn-ink" n={tally("todo")} label="Something to add or fix" />
            <Tally icon="copy" tone="text-danger" n={tally("dup")} label="Possible duplicate" />
            <Tally icon="clock" tone="text-muted" n={tally("reading")} label="Being read" />
            <span className="ml-auto text-muted">{plural(list.length, kind === "lr" ? "LR" : "copy", kind === "lr" ? "LRs" : "copies")}</span>
          </div>
          {list.length ? (
            <div className="max-h-[72vh] overflow-y-auto">
              {list.map((r) => (
                <button
                  key={r.l.id}
                  type="button"
                  onClick={() => setPick(r.l.id)}
                  className={cx("flex w-full cursor-pointer items-center gap-3 border-b border-divider px-3 py-2 text-left last:border-0", sel?.l.id === r.l.id ? "bg-brand-soft" : "hover:bg-canvas")}
                >
                  <Thumb fileId={r.l.fileId} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{titleOf(r.l)}</span>
                    <span className="flex items-center gap-1 truncate text-meta text-muted">
                      <Icon n={r.l.fromPhone ? "phone" : "file"} s={12} />
                      {[r.l.uploadedBy, clock(new Date(r.l.uploadedAt)), subOf(r.l)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <StateIcon state={r.state} />
                </button>
              ))}
            </div>
          ) : (
            <Empty>{kind === "lr" ? "No LR is waiting. The dispatch team uploads them from the phone." : "No signed copy is waiting. Copies for Mahek Vehicle deliveries arrive here from the phone."}</Empty>
          )}
        </Card>

        {sel ? (
          sel.flag ? (
            <DuplicatePanel key={sel.l.id} row={sel} other={copies.find((c) => c.id === sel.flag!.ofId) ?? null} canWrite={canWrite} />
          ) : (
            <Detail
              key={`${sel.l.id}|${sel.l.fileId}`}
              row={sel}
              prev={at > 0 ? () => setPick(list[at - 1].l.id) : null}
              next={at < list.length - 1 ? () => setPick(list[at + 1].l.id) : null}
              today={today}
              transporters={transporters}
              callEveryDays={callEveryDays}
              notifyOn={notifyOn}
              canWrite={canWrite}
              showAll={showAll}
              setShowAll={setShowAll}
              moreToShow={onTheWay.length > 0}
            />
          )
        ) : (
          <Card>
            <Empty>Pick a copy on the left.</Empty>
          </Card>
        )}
      </div>
    </div>
  );
}

function titleOf(l: UploadedLr): string {
  if (l.kind === "signed_copy") return l.partyHint ?? (l.billHint ? `Bill ${l.billHint}` : "Not read");
  return l.transporter ?? (l.lrNo ? lrLabel(l.lrNo) : "Not read");
}

function subOf(l: UploadedLr): string | null {
  if (l.kind === "signed_copy") return l.billHint && l.partyHint ? l.billHint : null;
  return l.lrNo ?? (l.readLrNo ? `${l.readLrNo}?` : null);
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
}: {
  row: Row;
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
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(row.pick ? [row.pick] : []));
  const [expected, setExpected] = useState("");
  const [nextCall, setNextCall] = useState(addDays(today, callEveryDays));
  const [notify, setNotify] = useState(true);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState<string | null>(null);

  /* What the AI read but did not write — unsure, or already on another LR — offered to the person. */
  const offered = lr && !l.lrNo && l.readLrNo ? l.readLrNo : null;
  const shown = row.ranked.slice(0, 8);
  const selBills = row.ranked.filter((x) => ticked.has(x.b.key));
  const selIds = selBills.flatMap((x) => x.b.rows.map((c) => c.id));
  const parties = new Set(selBills.map((x) => x.b.c.deliveryPartyId));
  const boxes = sumPackages(selBills.flatMap((x) => x.b.rows));

  const save = () =>
    run(() =>
      erpLogisticsEditLr(
        l.id,
        lr
          ? { lrNo: v.lrNo, lrDate: v.lrDate, transporter: v.transporter, destination: v.destination, packages: v.packages ? Number(v.packages) : null, freightTerm: v.freightTerm || null, freightRupees: v.freight ? Number(v.freight) : null, note: v.note }
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
        {canWrite && !row.wrong ? (
          <LinkButton onClick={() => run(() => erpLogisticsSetKind(l.id, lr ? "signed_copy" : "lr"))} disabled={pending}>
            {lr ? "It's a signed copy" : "It's an LR"}
          </LinkButton>
        ) : null}
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
            {shown.length ? (
              <div className="max-h-[230px] overflow-y-auto rounded-card border border-line">
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
                      <span className="block truncate font-medium text-ink">{b.c.deliveryParty}</span>
                      <span className="flex items-center gap-2 text-meta text-muted">
                        <BillRef c={b.c} />
                        {[b.c.billDate ? shortDay(b.c.billDate) : null, b.packages != null ? plural(b.packages, "box", "boxes") : null, lr ? b.c.transporter : b.c.vehicleNo].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {reasons.slice(0, 2).map((r) => (
                      <Badge key={r} label={r} tone={r.startsWith("same") || r === "destination matches" ? "success" : "neutral"} />
                    ))}
                  </label>
                ))}
              </div>
            ) : (
              <Empty>{lr ? "No bill is waiting for an LR." : "No Mahek Vehicle delivery is waiting for its signed copy."}</Empty>
            )}
          </div>

          {canWrite && shown.length ? (
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
