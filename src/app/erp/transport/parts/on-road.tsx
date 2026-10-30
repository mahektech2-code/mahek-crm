"use client";

import { NavLink } from "@/components/shell/nav-link";
import { erpLink } from "@/lib/erp/registry";
import { useMemo, useState } from "react";
import { FilterPills } from "@/components/ui/overlays";
import { Button, Card, cx, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Badge } from "../../_ui/badge";
import { DialogBody, DialogFooter, DialogHeader, ErpDialog, DialogTitle } from "../../_ui/dialog";
import { linkClass, SubTitle } from "../../_ui/look";
import { erpLogisticsClearIssue, erpLogisticsDelivered, erpLogisticsDeliveredBy, erpLogisticsIssue, erpLogisticsUpdate, erpLogisticsUploadLrs } from "@/lib/actions/erp-logistics";
import { Icon } from "../../_ui/icons";
import { shrinkImage } from "@/lib/shrink-image";
import { addDays, callDue, daysBetween, ISSUES, MAHEK_VEHICLE, runningLate, shortDay, trackingLink } from "@/lib/erp/engines/logistics";
import { delayReasonForIssue, reasonsFor } from "@/lib/erp/engines/order-tracking";
import type { Consignment, RouteSuggestions, UploadedLr } from "@/lib/erp/logistics";
import { EditLrDialog } from "./edit-lr";
import { UpdateLrDialog } from "./update-lr";
import { BillRef, byLr, CallLink, DeliveryStatusBadge, driverPhone, DuePill, Empty, LrThumb, NotifyToggle, plural, RouteTrail, StageStrip, sumPackages, useAct, lrLabel, vehicleWords } from "./common";

/**
 * STEP 5 AND 6 — following the lorry. One card per LR (one LR is one
 * consignment), with the transporter's number to ring, where it is, when the
 * next call is owed and what was last said. An update that moves the stage is
 * shared with the customer; a problem can be raised, and the card closes when
 * the party has the goods.
 */
type Filter = "all" | "calls" | "late" | "issue";
type Dialog = { kind: "update" | "issue" | "delivered" | "deliveredBy" | "editLr"; group: Consignment[] } | null;

export function OnRoad({
  rows,
  today,
  callEveryDays,
  lateAfterDays,
  notifyOn,
  canWrite,
  suggestions,
  initialFilter,
  signedWaiting = [],
  transporters = [],
}: {
  rows: Consignment[];
  today: string;
  callEveryDays: number;
  lateAfterDays: number;
  notifyOn: boolean;
  canWrite: boolean;
  suggestions?: RouteSuggestions | null;
  initialFilter?: Filter;
  /** Signed copies on the Documents desk, waiting for the delivery they close. */
  signedWaiting?: UploadedLr[];
  transporters?: string[];
}) {
  const { run, pending } = useAct();
  const [filter, setFilter] = useState<Filter>(initialFilter ?? "all");
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);

  const groups = useMemo(() => byLr(rows), [rows]);
  const isLate = (g: Consignment[]) => g.some((c) => runningLate({ expectedDeliveryOn: c.expectedDeliveryOn, billDate: c.billDate, materialStage: c.stage }, today, lateAfterDays));
  const isCall = (g: Consignment[]) => g.some((c) => callDue({ reminderDate: c.nextCallOn, materialStage: c.stage }, today));
  const counts = { all: groups.length, calls: groups.filter((g) => isCall(g.bills)).length, late: groups.filter((g) => isLate(g.bills)).length, issue: groups.filter((g) => g.bills.some((c) => c.issue)).length };
  const needle = q.trim().toLowerCase();
  const shown = groups
    .filter((g) => (filter === "calls" ? isCall(g.bills) : filter === "late" ? isLate(g.bills) : filter === "issue" ? g.bills.some((c) => c.issue) : true))
    .filter((g) => !needle || g.bills.some((c) => [c.lrNo, c.billNo, c.party, c.deliveryParty, c.transporter, String(c.orderNo), c.area, c.currentCity, c.destination, c.dispatchedFrom].some((x) => x?.toLowerCase().includes(needle))))
    .sort((a, b) => (a.bills[0].nextCallOn ?? "9999") .localeCompare(b.bills[0].nextCallOn ?? "9999"));

  const calledNoChange = (g: Consignment[]) => run(() => erpLogisticsUpdate(g.map((c) => c.id), { note: g[0].ownVehicle ? "Called the driver — no change" : "Called the transporter — no change", nextCallOn: addDays(today, callEveryDays), notify: false }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <FilterPills<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "Everything on the road", count: counts.all },
            { key: "calls", label: "Call today", count: counts.calls },
            { key: "late", label: "Running late", count: counts.late },
            { key: "issue", label: "With a problem", count: counts.issue },
          ]}
        />
        <span className="ml-auto w-[260px]">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search LR, bill, party, transporter, city" aria-label="Search LR, bill, party, transporter, city" />
        </span>
      </div>

      {!shown.length ? (
        <Card>
          <Empty>{groups.length ? "Nothing matches." : "Nothing is on the road. A bill comes here when its LR is attached on the Documents desk, or as it leaves in a Mahek Vehicle."}</Empty>
        </Card>
      ) : null}

      {shown.map(({ key, bills }) => {
        const c = bills[0];
        const late = isLate(bills);
        const issue = bills.find((b) => b.issue);
        const boxes = sumPackages(bills);
        const parties = [...new Set(bills.map((b) => b.deliveryParty))];
        const since = c.lrDate ?? c.billDate;
        const online = trackingLink(c.transporterTrackUrl, c.lrNo);
        const waiting = bills.reduce((a, b) => Math.max(a, b.messagesWaiting), 0);
        return (
          <Card key={key} className={cx("overflow-hidden", issue ? "border-danger/50" : late ? "border-warn/60" : "")}>
            <div className="flex flex-wrap items-start gap-4 px-4 py-3">
              {c.ownVehicle ? (
                c.signedCopyFileId ? (
                  <LrThumb fileId={c.signedCopyFileId} size={60} />
                ) : (
                  <span className="flex h-[60px] w-[60px] flex-none items-center justify-center rounded-control bg-warn-soft text-warn-ink" title="Mahek Vehicle">
                    <Icon n="truck" s={26} />
                  </span>
                )
              ) : (
                <LrThumb fileId={c.lrFileId} size={60} />
              )}
              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {c.ownVehicle ? (
                    <>
                      <SubTitle className="mb-0 font-mono">{c.vehicleNo ?? "Vehicle not recorded"}</SubTitle>
                      <Badge label="Mahek Vehicle" tone="warn" />
                    </>
                  ) : (
                    <>
                      <SubTitle className="mb-0 font-mono">{lrLabel(c.lrNo)}</SubTitle>
                      <span className="text-meta text-body">· {c.transporter ?? "—"}</span>
                    </>
                  )}
                  <DeliveryStatusBadge c={issue ?? c} today={today} />
                  {issue ? <Badge label={issue.issue ?? ""} tone="danger" /> : null}
                  {late && !issue ? <Badge label="Running late" tone="warn" /> : null}
                  {waiting ? (
                    <NavLink href={erpLink("lrMessages")}>
                      <Badge label={`${plural(waiting, "message")} to send`} tone="warn" />
                    </NavLink>
                  ) : null}
                </div>
                <div className="mt-0.5 text-sm font-medium text-ink">{parties.join(", ")}</div>
                <div className="text-meta text-muted">
                  {bills.map((b, i) => (
                    <span key={b.id}>
                      {i ? ", " : ""}
                      <BillRef c={b} />
                    </span>
                  ))}
                  {boxes != null ? ` · ${plural(boxes, "box", "boxes")}` : ""}
                  {c.area ? ` · ${c.area}` : ""}
                  {since ? ` · ${daysBetween(since, today)} d on the road` : ""}
                  {c.ownVehicle ? (c.driver ? ` · ${c.driver}` : "") : ` · ${vehicleWords(c)}`}
                </div>
                {c.ownVehicle && !c.signedCopyId ? (
                  <div className="mt-1 flex items-center gap-1 text-meta text-warn-ink">
                    <Icon n="file" s={13} />
                    No signed copy yet
                  </div>
                ) : null}
                {c.route.length || c.destination ? <RouteTrail route={c.route} destination={c.destination} stage={c.stage} className="mt-1.5" /> : null}
                {c.stage === "Ready for Pickup" && c.pickupPoint ? (
                  <div className="mt-1 text-meta text-body">
                    Party collects from <span className="font-medium text-ink">{c.pickupPoint}</span>
                    {c.pickupContact ? ` · ${c.pickupContact}` : ""}
                  </div>
                ) : null}
                {issue?.issueNote ? <div className="mt-1 text-meta text-danger">{issue.issueNote}</div> : null}
                {c.lastEventNote ? <div className="mt-1 truncate text-meta text-body">Last: {c.lastEventNote}</div> : null}
              </div>
              <div className="w-[270px] space-y-1.5">
                <StageStrip stage={c.stage} />
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>Expected</span>
                  {c.expectedDeliveryOn ? <span className={cx("font-medium", late ? "text-danger" : "text-body")}>{shortDay(c.expectedDeliveryOn)}</span> : <span>—</span>}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span>Next call</span>
                  <DuePill day={c.nextCallOn} today={today} />
                </div>
              </div>
              <div className="w-[190px] space-y-1.5 text-right">
                {c.ownVehicle ? <CallLink phone={driverPhone(c.driver)} name={c.driver ?? "Driver"} /> : <CallLink phone={c.transporterPhone} name={c.transporter} />}
                {online && !c.ownVehicle ? (
                  <a href={online} target="_blank" rel="noreferrer" className={linkClass("brand", "block text-meta")}>
                    Track on {c.transporter}&apos;s site ↗
                  </a>
                ) : null}
              </div>
            </div>
            {canWrite ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-divider bg-canvas px-4 py-2">
                <Button size="sm" variant="primary" disabled={pending} onClick={() => setDialog({ kind: "update", group: bills })}>
                  Update status
                </Button>
                <Button size="sm" disabled={pending} onClick={() => calledNoChange(bills)} title={`Logs the call to the ${c.ownVehicle ? "driver" : "transporter"} and books the next one in ${callEveryDays} days. The customer is not messaged.`}>
                  Called — no change
                </Button>
                {issue ? (
                  <Button size="sm" disabled={pending} onClick={() => run(() => erpLogisticsClearIssue(bills.map((b) => b.id), ""))}>
                    Problem solved
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDialog({ kind: "issue", group: bills })}>
                    Report a problem
                  </Button>
                )}
                {c.lrId ? (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDialog({ kind: "editLr", group: bills })} title="Fix the LR number, transporter, date or photo — take a bill off it, or delete the LR">
                    Edit LR
                  </Button>
                ) : null}
                {!c.lrId ? (
                  <Button size="sm" variant="ghost" className="ml-auto" disabled={pending} onClick={() => setDialog({ kind: "deliveredBy", group: bills })} title="Who takes it to the party — a transporter or a Mahek Vehicle">
                    Delivered by…
                  </Button>
                ) : null}
                <Button size="sm" className={c.lrId ? "ml-auto" : ""} disabled={pending} onClick={() => setDialog({ kind: "delivered", group: bills })}>
                  {c.ownVehicle ? "Signed copy & delivered" : "Delivered ✓"}
                </Button>
              </div>
            ) : null}
          </Card>
        );
      })}

      {dialog?.kind === "editLr" ? (
        <EditLrDialog key={`e${dialog.group[0].id}`} group={dialog.group} today={today} transporters={transporters} notifyOn={notifyOn} onClose={() => setDialog(null)} />
      ) : dialog?.kind === "update" ? (
        <UpdateLrDialog key={`u${dialog.group[0].id}`} group={dialog.group} today={today} callEveryDays={callEveryDays} notifyOn={notifyOn} suggestions={suggestions ?? null} onClose={() => setDialog(null)} />
      ) : dialog?.kind === "deliveredBy" ? (
        <DeliveredByDialog key={`by${dialog.group[0].id}`} group={dialog.group} transporters={transporters} onClose={() => setDialog(null)} />
      ) : dialog?.kind === "delivered" && dialog.group[0].ownVehicle ? (
        <SignedDeliveredDialog key={`sd${dialog.group[0].id}`} group={dialog.group} today={today} notifyOn={notifyOn} waiting={signedWaiting} onClose={() => setDialog(null)} />
      ) : dialog ? (
        <ActionDialog key={`${dialog.kind}${dialog.group[0].id}`} dialog={{ kind: dialog.kind, group: dialog.group }} today={today} notifyOn={notifyOn} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

/** A problem, or the delivery — the two acts on the road that are not a status update (that one is `UpdateLrDialog`). */
function ActionDialog({ dialog, today, notifyOn, onClose }: { dialog: { kind: "issue" | "delivered"; group: Consignment[] }; today: string; notifyOn: boolean; onClose: () => void }) {
  const { run, pending } = useAct();
  const c = dialog.group[0];
  const ids = dialog.group.map((b) => b.id);
  const [note, setNote] = useState("");
  const [expected, setExpected] = useState(c.expectedDeliveryOn ?? "");
  const [issue, setIssue] = useState<string>("Delayed");
  /* What the customer's tracking page calls it: a delay reason, or nothing (the problem stays internal). */
  const [customerReason, setCustomerReason] = useState<string>(delayReasonForIssue("Delayed") ?? "");
  const [date, setDate] = useState(today);
  const [receivedBy, setReceivedBy] = useState("");
  const [proof, setProof] = useState("");
  const [notify, setNotify] = useState(true);

  const what = c.ownVehicle ? (c.vehicleNo ?? MAHEK_VEHICLE) : lrLabel(c.lrNo);
  const title = dialog.kind === "issue" ? `A problem with ${what}` : `${what} delivered`;
  const save = () => {
    const done = (r: { ok: boolean }) => r.ok && onClose();
    if (dialog.kind === "issue") return run(() => erpLogisticsIssue(ids, { issue, note, expectedOn: expected || null, notify, customerReason: customerReason || null }), done);
    return run(() => erpLogisticsDelivered(ids, { date, receivedBy, proof, note, notify }), done);
  };

  return (
    <ErpDialog onClose={onClose} label={title} size="sm" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-3">
        <div className="text-sm text-body">
          {[...new Set(dialog.group.map((b) => b.deliveryParty))].join(", ")} · {plural(dialog.group.length, "bill")} · {c.transporter ?? "—"}
        </div>
        {dialog.kind === "issue" ? (
          <>
            <Field label="What went wrong?">
              <Select
                value={issue}
                onChange={(e) => {
                  setIssue(e.target.value);
                  setCustomerReason(delayReasonForIssue(e.target.value) ?? "");
                }}
              >
                {ISSUES.map((i) => (
                  <option key={i}>{i}</option>
                ))}
              </Select>
            </Field>
            <Field label="The customer's tracking page shows">
              <Select value={customerReason} onChange={(e) => setCustomerReason(e.target.value)}>
                <option value="">Nothing — keep it internal</option>
                {reasonsFor("delay")
                  .filter((r) => r.code !== "other")
                  .map((r) => (
                    <option key={r.code} value={r.code}>
                      Delivery Delayed · {r.label}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="New expected delivery (if the transporter gave one)">
              <Input type="date" value={expected} min={today} onChange={(e) => setExpected(e.target.value)} />
            </Field>
          </>
        ) : null}
        {dialog.kind === "delivered" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Received on">
              <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Received by">
              <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Who signed for it" />
            </Field>
            <div className="col-span-2">
              <Field label="Proof / reference">
                <Input value={proof} onChange={(e) => setProof(e.target.value)} placeholder="POD number, signed copy, photo name — optional" />
              </Field>
            </div>
            <p className="col-span-2 text-meta text-muted">Close it only once the party has confirmed. Not confirmed yet? Report a problem — Unconfirmed — and it stays open.</p>
          </div>
        ) : null}
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
        <NotifyToggle value={notify} onChange={setNotify} disabled={!notifyOn} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant={dialog.kind === "issue" ? "danger" : "primary"} disabled={pending || (dialog.kind === "issue" && issue === "Other" && !note.trim())} onClick={save}>
          {dialog.kind === "delivered" ? "Close as delivered" : "Record the problem"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

/** Who takes it to the party, changeable until it is delivered. Our own vehicle carries no LR. */
function DeliveredByDialog({ group, transporters, onClose }: { group: Consignment[]; transporters: string[]; onClose: () => void }) {
  const { run, pending } = useAct();
  const c = group[0];
  const [own, setOwn] = useState(!c.ownVehicle);
  const [transporter, setTransporter] = useState(c.ownVehicle ? "" : (c.transporter ?? ""));
  const list = transporters.filter((t) => t.toLowerCase() !== MAHEK_VEHICLE.toLowerCase());
  return (
    <ErpDialog onClose={onClose} label="Delivered by" size="sm" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>Delivered by</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-3">
        <div className="text-sm text-body">
          {[...new Set(group.map((b) => b.deliveryParty))].join(", ")} · {plural(group.length, "bill")}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[false, true].map((o) => (
            <button key={String(o)} type="button" onClick={() => setOwn(o)} className={cx("cursor-pointer rounded-control border px-2 py-2 text-sm", own === o ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line bg-surface text-body hover:bg-canvas")}>
              {o ? MAHEK_VEHICLE : "Transporter"}
            </button>
          ))}
        </div>
        {own ? (
          <p className="text-meta text-muted">No LR. The customer-signed copy closes it.</p>
        ) : (
          <Field label="Transporter">
            <Select value={transporter} onChange={(e) => setTransporter(e.target.value)}>
              <option value="">Pick…</option>
              {list.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
        )}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={pending || (!own && !transporter)} onClick={() => run(() => erpLogisticsDeliveredBy(group.map((b) => b.id), own ? MAHEK_VEHICLE : transporter), (r) => r.ok && onClose())}>
          Save
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

/**
 * A MAHEK VEHICLE DELIVERY CLOSES WITH THE CUSTOMER-SIGNED COPY: one already on
 * the Documents desk, or one uploaded here. Who signed is asked; the day too.
 */
function SignedDeliveredDialog({ group, today, notifyOn, waiting, onClose }: { group: Consignment[]; today: string; notifyOn: boolean; waiting: UploadedLr[]; onClose: () => void }) {
  const { run, pending } = useAct();
  const c = group[0];
  const [copyId, setCopyId] = useState<string>(c.signedCopyId ?? "");
  const [fresh, setFresh] = useState<{ id: string; preview: string | null } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [upErr, setUpErr] = useState("");
  const [date, setDate] = useState(today);
  const [receivedBy, setReceivedBy] = useState("");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const chosen = waiting.find((w) => w.id === copyId);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setUpErr("");
    try {
      const body = new FormData();
      body.set("file", await shrinkImage(file));
      body.set("kind", "photo");
      const res = await fetch("/api/erp/attachments", { method: "POST", body });
      const j = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !j.id) throw new Error(j.error || "Upload failed");
      const saved = await erpLogisticsUploadLrs([{ fileId: j.id, kind: "signed_copy" }]);
      if (!saved.ok) throw new Error(saved.error);
      const id = saved.data.ids[0] ?? saved.data.already[0];
      if (!id) throw new Error("The copy was not saved");
      setCopyId(id);
      setFresh({ id, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
    } catch (e) {
      setUpErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const signer = receivedBy.trim() || chosen?.receivedBy || "";
  return (
    <ErpDialog onClose={onClose} label="Delivered" size="sm" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>Delivered · {c.deliveryParty}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-3">
        <div className="flex items-center gap-2 text-meta text-body">
          <Badge label={MAHEK_VEHICLE} tone="warn" />
          {c.vehicleNo ?? ""} · {plural(group.length, "bill")}
        </div>
        <Field label="Customer-signed copy">
          {copyId ? (
            <div className="flex items-center gap-3 rounded-control border border-line p-2">
              {fresh?.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fresh.preview} alt="" className="h-14 w-11 rounded-control object-cover" />
              ) : (
                <LrThumb fileId={chosen?.fileId ?? c.signedCopyFileId} size={48} />
              )}
              <span className="flex-1 text-meta text-body">{fresh ? "Uploaded now" : chosen ? [chosen.uploadedBy, chosen.billHint ? `bill ${chosen.billHint}` : null].filter(Boolean).join(" · ") : "Attached"}</span>
              <Button size="sm" variant="ghost" onClick={() => (setCopyId(""), setFresh(null))}>
                Change
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <label className={cx("flex cursor-pointer items-center justify-center gap-2 rounded-control border-2 border-dashed border-warn/60 bg-warn-soft px-3 py-4 text-sm text-warn-ink", uploading && "opacity-60")}>
                <Icon n="camera" />
                {uploading ? "Uploading…" : "Photo or PDF of the signed copy"}
                <input type="file" accept="image/*,application/pdf" className="hidden" disabled={uploading} onChange={(e) => void upload(e.target.files?.[0])} />
              </label>
              {waiting.length ? (
                <Select value="" onChange={(e) => setCopyId(e.target.value)} aria-label="Pick one waiting on the desk">
                  <option value="">Or pick one waiting on the desk ({waiting.length})</option>
                  {waiting.map((w) => (
                    <option key={w.id} value={w.id}>
                      {[w.partyHint, w.billHint ? `bill ${w.billHint}` : null, w.uploadedBy].filter(Boolean).join(" · ") || "Not read yet"}
                    </option>
                  ))}
                </Select>
              ) : null}
              {upErr ? <p className="text-meta text-danger">{upErr}</p> : null}
            </div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Delivered on">
            <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Received by">
            <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder={chosen?.receivedBy ?? "Name on the copy"} />
          </Field>
        </div>
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
        <NotifyToggle value={notify} onChange={setNotify} disabled={!notifyOn} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={pending || uploading || !copyId || !signer}
          title={!copyId ? "Add the signed copy first" : !signer ? "Say who signed for it" : undefined}
          onClick={() => run(() => erpLogisticsDelivered(group.map((b) => b.id), { date, receivedBy: signer, note, notify, signedCopyId: copyId }), (r) => r.ok && onClose())}
        >
          Mark delivered
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
