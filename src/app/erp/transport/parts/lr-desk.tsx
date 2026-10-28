"use client";

import { useMemo, useState } from "react";
import { Button, Card, checkboxClass, cx, Field, Input, Select } from "@/components/ui/primitives";
import { Badge } from "../../_ui/badge";
import { DialogBody, DialogFooter, DialogHeader, ErpDialog, DialogTitle } from "../../_ui/dialog";
import { SubTitle } from "../../_ui/look";
import { erpLogisticsAttach, erpLogisticsEditLr, erpLogisticsVoidLr } from "@/lib/actions/erp-logistics";
import { addDays, lrUploadName, rankForLr, shortDay } from "@/lib/erp/engines/logistics";
import type { Consignment, UploadedLr } from "@/lib/erp/logistics";
import { inr, rupeesField } from "@/lib/erp/ui";
import { BillRef, DuePill, Empty, LrThumb, NotifyToggle, plural, ReasonDialog, sumPackages, useAct, lrLabel } from "./common";
import { ErpImpactDialog } from "../../_ui/impact-confirm";

/**
 * STEP 4 — BIFURCATION. On the left, every LR the dispatch team uploaded and
 * nobody has attached; on the right, the bills waiting for an LR. Pick an LR,
 * and the bills it most likely carries rise to the top with the reason beside
 * each (same transporter, destination, box count). Tick them, say when it
 * should arrive, and attaching sends the customer the LR on WhatsApp.
 */
export function LrDesk({
  lrs,
  waiting,
  onTheWay,
  today,
  transporters,
  callEveryDays,
  notifyOn,
  canWrite,
}: {
  lrs: UploadedLr[];
  waiting: Consignment[];
  onTheWay: Consignment[];
  today: string;
  transporters: string[];
  callEveryDays: number;
  notifyOn: boolean;
  canWrite: boolean;
}) {
  const { run, pending } = useAct();
  const [pick, setPick] = useState<string | null>(lrs[0]?.id ?? null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [expected, setExpected] = useState("");
  const [nextCall, setNextCall] = useState(addDays(today, callEveryDays));
  const [notify, setNotify] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<UploadedLr | null>(null);
  const [voiding, setVoiding] = useState<UploadedLr | null>(null);
  /* The reason is asked first, then what voiding touches, with the LR number typed. */
  const [voidImpact, setVoidImpact] = useState<{ lr: UploadedLr; reason: string } | null>(null);

  const lr = lrs.find((l) => l.id === pick) ?? null;
  const pool = useMemo(() => (showAll ? [...waiting, ...onTheWay] : waiting), [showAll, waiting, onTheWay]);
  const ranked = useMemo(() => {
    if (!lr) return pool.map((c) => ({ c, score: 0, reasons: [] as string[] }));
    const r = rankForLr(lr, pool.map((c) => ({ id: c.id, transporter: c.transporter, packages: c.packages, area: c.area ?? c.partyCity, party: c.deliveryParty, atTransport: c.phase === "lrPending" })));
    return r.map((x) => ({ c: pool.find((c) => c.id === x.id)!, score: x.score, reasons: x.reasons }));
  }, [lr, pool]);

  const sel = ranked.filter((x) => ticked.has(x.c.id)).map((x) => x.c);
  const selBoxes = sumPackages(sel);
  const parties = new Set(sel.map((c) => c.deliveryPartyId));

  const choose = (id: string) => {
    setPick(id);
    setTicked(new Set());
    setExpected("");
  };
  const toggle = (c: Consignment) =>
    setTicked((s) => {
      const n = new Set(s);
      if (n.has(c.id)) n.delete(c.id);
      else n.add(c.id);
      return n;
    });

  const attach = () =>
    lr &&
    run(
      () => erpLogisticsAttach(lr.id, sel.map((c) => c.id), { expectedOn: expected || null, nextCallOn: nextCall || null, notify }),
      (r) => {
        if (r.ok) {
          setTicked(new Set());
          setPick(lrs.find((l) => l.id !== lr.id)?.id ?? null);
        }
      },
    );

  return (
    <div className="grid grid-cols-[minmax(300px,380px)_minmax(0,1fr)] items-start gap-5">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-divider px-4 py-3">
          <div>
            <SubTitle className="mb-0">LRs to attach</SubTitle>
            <div className="text-meta text-muted">Uploaded by the dispatch team</div>
          </div>
        </div>
        {lrs.length ? (
          <div className="max-h-[70vh] overflow-y-auto">
            {lrs.map((l) => (
              <button key={l.id} onClick={() => choose(l.id)} className={cx("flex w-full cursor-pointer gap-3 border-b border-divider px-4 py-3 text-left last:border-0", pick === l.id ? "bg-brand-soft" : "hover:bg-canvas")}>
                <LrThumb fileId={l.fileId} size={52} />
                <span className="min-w-0 flex-1">
                  {l.lrNo ? <span className="block font-mono text-sm font-semibold text-ink">{lrLabel(l.lrNo)}</span> : <span className="block text-sm font-semibold text-warn-ink">Number not typed</span>}
                  <span className="block truncate text-meta text-body">{l.transporter ?? "Transporter not given"}</span>
                  <span className="block truncate text-meta text-muted">
                    {[l.destination, l.packages != null ? plural(l.packages, "box", "boxes") : null, l.lrDate ? shortDay(l.lrDate) : null].filter(Boolean).join(" · ") || "—"}
                  </span>
                  <span className="block truncate text-xs text-muted">by {l.uploadedBy ?? "—"}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <Empty>
            No LR is waiting. The dispatch team uploads them as they collect them.
          </Empty>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-start gap-3 border-b border-divider px-4 py-3">
          {lr ? (
            <>
              <LrThumb fileId={lr.fileId} size={72} />
              <div className="min-w-0 flex-1">
                <SubTitle className="mb-0">Which bills does {lr.lrNo ? lrLabel(lr.lrNo) : "this LR"} carry?</SubTitle>
                {!lr.lrNo ? <div className="mt-0.5 text-meta text-warn-ink">Its number was not typed at upload. Read it off the photo and add it with Edit before attaching — the customer is told it.</div> : null}
                <div className="text-meta text-muted">
                  {[lr.transporter, lr.destination, lr.packages != null ? plural(lr.packages, "box", "boxes") : null, lr.freightTerm ? `freight ${lr.freightTerm}${lr.freightPaise != null ? ` ${inr(lr.freightPaise)}` : ""}` : null].filter(Boolean).join(" · ")}
                </div>
                {lr.note ? <div className="mt-1 text-meta text-body">“{lr.note}”</div> : null}
              </div>
              {canWrite ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setEditing(lr)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setVoiding(lr)}>
                    Void
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <div>
              <SubTitle className="mb-0">Bills waiting for their LR</SubTitle>
              <div className="text-meta text-muted">Pick an LR on the left, then the bills it carries.</div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-b border-divider bg-canvas px-4 py-1.5 text-meta text-muted">
          <span>{plural(waiting.length, "bill")} waiting</span>
          {onTheWay.length ? (
            <label className="ml-auto flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className={checkboxClass} />
              Also show {plural(onTheWay.length, "bill")} not yet marked at the transporter
            </label>
          ) : null}
        </div>

        {ranked.length ? (
          <div className="max-h-[56vh] overflow-y-auto">
            {ranked.map(({ c, score, reasons }, i) => (
              <label key={c.id} className={cx("grid cursor-pointer grid-cols-[24px_minmax(110px,1fr)_minmax(150px,1.6fr)_minmax(110px,1fr)_70px_110px] items-center gap-3 border-b border-divider px-4 py-2 text-sm last:border-0", ticked.has(c.id) ? "bg-brand-soft/50" : lr && score >= 5 && i < 6 ? "bg-success-soft/40" : "")}>
                <input type="checkbox" disabled={!lr || !canWrite} checked={ticked.has(c.id)} onChange={() => toggle(c)} className={checkboxClass} />
                <span className="min-w-0">
                  <BillRef c={c} />
                  <span className="block text-meta text-muted">Order {c.orderNo}</span>
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{c.deliveryParty}</span>
                  <span className="block truncate text-meta text-muted">{c.area ?? c.partyCity ?? "—"}</span>
                </span>
                <span className="min-w-0 truncate text-meta text-body">{c.transporter ?? "—"}</span>
                <span className="tabular-nums">{c.packages ?? "—"}</span>
                <span className="flex flex-wrap gap-1">
                  {lr && reasons.length ? reasons.slice(0, 2).map((r) => <Badge key={r} label={r} tone={r === "same transporter" || r === "destination matches" ? "success" : "neutral"} />) : c.phase === "toTransport" ? <DuePill day={c.transportDueOn} today={today} prefix="Due" /> : <Badge label="At transporter" tone="muted" />}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <Empty>No bill is waiting for an LR.</Empty>
        )}

        {lr && canWrite ? (
          <div className="space-y-3 border-t border-divider bg-canvas px-4 py-3">
            {sel.length ? (
              <div className="text-sm text-ink">
                {plural(sel.length, "bill")} for <b>{[...new Set(sel.map((c) => c.deliveryParty))].join(", ")}</b>
                {selBoxes != null ? ` · ${plural(selBoxes, "box", "boxes")}` : ""}
                {lr.packages != null && selBoxes != null && selBoxes !== lr.packages ? <span className="ml-2 text-warn-ink">The LR says {lr.packages} — check the count.</span> : null}
                {parties.size > 1 ? <span className="ml-2 text-danger">One LR goes to one party.</span> : null}
              </div>
            ) : (
              <div className="text-meta text-muted">Tick the bills this LR carries.</div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Expected delivery" className="w-44">
                <Input type="date" value={expected} min={lr.lrDate ?? today} onChange={(e) => setExpected(e.target.value)} />
              </Field>
              <Field label="Next call to the transporter" className="w-60">
                <Input type="date" value={nextCall} min={today} onChange={(e) => setNextCall(e.target.value)} />
              </Field>
              <div className="min-w-[260px] flex-1">
                <NotifyToggle value={notify} onChange={setNotify} disabled={!notifyOn} />
              </div>
              <Button variant="primary" disabled={pending || !sel.length || parties.size > 1 || !lr.lrNo} title={!lr.lrNo ? "Add the LR number first (Edit)" : undefined} onClick={attach}>
                Attach LR{notify && notifyOn ? " & tell customer" : ""}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>


      {editing ? <EditLr key={editing.id} lr={editing} transporters={transporters} today={today} onClose={() => setEditing(null)} /> : null}

      <ReasonDialog
        key={voiding?.id ?? ""}
        open={!!voiding}
        title={voiding ? `Void ${lrUploadName(voiding.lrNo)}?` : ""}
        body="A voided LR leaves the desk and stays on record with your reason. Use it for a wrong or duplicate upload."
        keepLabel="Keep it"
        confirmLabel="Void"
        tone="danger"
        pending={pending}
        onClose={() => setVoiding(null)}
        onConfirm={(reason) => {
          if (!voiding) return;
          setVoidImpact({ lr: voiding, reason });
          setVoiding(null);
        }}
      />
      {voidImpact ? (
        <ErpImpactDialog
          kind="erp-lr-void"
          id={voidImpact.lr.id}
          confirmLabel="Void"
          onClose={() => setVoidImpact(null)}
          act={(confirmation) => erpLogisticsVoidLr(voidImpact.lr.id, voidImpact.reason, confirmation)}
        />
      ) : null}
    </div>
  );
}

function EditLr({ lr, transporters, today, onClose }: { lr: UploadedLr; transporters: string[]; today: string; onClose: () => void }) {
  const { run, pending } = useAct();
  const [v, setV] = useState({ lrNo: lr.lrNo ?? "", lrDate: lr.lrDate ?? today, transporter: lr.transporter ?? "", destination: lr.destination ?? "", packages: lr.packages == null ? "" : String(lr.packages), freightTerm: lr.freightTerm ?? "", freight: lr.freightPaise == null ? "" : rupeesField(lr.freightPaise), note: lr.note ?? "" });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const title = lr.lrNo ? `Edit LR ${lr.lrNo}` : "Edit LR — add its number";
  return (
    <ErpDialog onClose={onClose} label={title} size="sm" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <datalist id="lr-edit-transporters">
          {transporters.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <div className="grid grid-cols-2 gap-3">
          <Field label="LR number">
            <Input value={v.lrNo} onChange={set("lrNo")} />
          </Field>
          <Field label="LR date">
            <Input type="date" value={v.lrDate} max={today} onChange={set("lrDate")} />
          </Field>
          <Field label="Transporter">
            <Input list="lr-edit-transporters" value={v.transporter} onChange={set("transporter")} />
          </Field>
          <Field label="Destination">
            <Input value={v.destination} onChange={set("destination")} />
          </Field>
          <Field label="Boxes">
            <Input inputMode="numeric" value={v.packages} onChange={set("packages")} />
          </Field>
          <Field label="Freight">
            <Select value={v.freightTerm} onChange={set("freightTerm")}>
              <option value="">—</option>
              <option>Paid</option>
              <option>To pay</option>
              <option>TBB</option>
            </Select>
          </Field>
          <Field label="Freight ₹">
            <Input inputMode="decimal" value={v.freight} onChange={set("freight")} />
          </Field>
          <Field label="Note">
            <Input value={v.note} onChange={set("note")} />
          </Field>
        </div>
      </DialogBody>
      <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              run(
                () => erpLogisticsEditLr(lr.id, { lrNo: v.lrNo, lrDate: v.lrDate, transporter: v.transporter, destination: v.destination, packages: v.packages ? Number(v.packages) : null, freightTerm: v.freightTerm || null, freightRupees: v.freight ? Number(v.freight) : null, note: v.note }),
                (r) => r.ok && onClose(),
              )
            }
          >
            Save
          </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
