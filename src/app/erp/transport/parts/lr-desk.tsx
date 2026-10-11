"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Badge, Button, Card, cx } from "@/components/ui/primitives";
import { erpLogisticsAttach, erpLogisticsEditLr, erpLogisticsVoidLr } from "@/lib/actions/erp-logistics";
import { addDays, lrUploadName, rankForLr, shortDay } from "@/lib/erp/engines/logistics";
import type { Consignment, UploadedLr } from "@/lib/erp/logistics";
import { BillRef, DuePill, Empty, LrThumb, NotifyToggle, plural, sumPackages, useAct, lrLabel } from "./common";
import { LrUpload } from "./lr-upload";

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
  const [upload, setUpload] = useState(false);
  const [editing, setEditing] = useState<UploadedLr | null>(null);
  const [voiding, setVoiding] = useState<UploadedLr | null>(null);
  const [reason, setReason] = useState("");

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
    <div className="grid grid-cols-[minmax(300px,380px)_minmax(0,1fr)] items-start gap-4">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-divider px-4 py-3">
          <div>
            <div className="text-[15px] font-semibold text-ink">LRs to attach</div>
            <div className="text-[12px] text-muted">Uploaded by the dispatch team</div>
          </div>
          {canWrite ? (
            <Button size="sm" variant="primary" onClick={() => setUpload(true)}>
              Upload LRs
            </Button>
          ) : null}
        </div>
        {lrs.length ? (
          <div className="max-h-[70vh] overflow-y-auto">
            {lrs.map((l) => (
              <button key={l.id} onClick={() => choose(l.id)} className={cx("flex w-full cursor-pointer gap-3 border-b border-divider px-4 py-3 text-left last:border-0", pick === l.id ? "bg-brand-soft" : "hover:bg-canvas")}>
                <LrThumb fileId={l.fileId} size={52} />
                <span className="min-w-0 flex-1">
                  {l.lrNo ? <span className="block font-mono text-[14px] font-semibold text-ink">{lrLabel(l.lrNo)}</span> : <span className="block text-[14px] font-semibold text-warn-ink">Number not typed</span>}
                  <span className="block truncate text-[12px] text-body">{l.transporter ?? "Transporter not given"}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {[l.destination, l.packages != null ? plural(l.packages, "box", "boxes") : null, l.lrDate ? shortDay(l.lrDate) : null].filter(Boolean).join(" · ") || "—"}
                  </span>
                  <span className="block truncate text-[11px] text-muted">by {l.uploadedBy ?? "—"}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <Empty>
            No LR is waiting. When the dispatch team collects them from the transporters, they upload them here{canWrite ? " — or upload them yourself" : ""}.
          </Empty>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-start gap-3 border-b border-divider px-4 py-3">
          {lr ? (
            <>
              <LrThumb fileId={lr.fileId} size={72} />
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold text-ink">Which bills does {lr.lrNo ? lrLabel(lr.lrNo) : "this LR"} carry?</div>
                {!lr.lrNo ? <div className="mt-0.5 text-[12px] text-warn-ink">Its number was not typed at upload. Read it off the photo and add it with Edit before attaching — the customer is told it.</div> : null}
                <div className="text-[12px] text-muted">
                  {[lr.transporter, lr.destination, lr.packages != null ? plural(lr.packages, "box", "boxes") : null, lr.freightTerm ? `freight ${lr.freightTerm}${lr.freightPaise != null ? ` ₹${(lr.freightPaise / 100).toLocaleString("en-IN")}` : ""}` : null].filter(Boolean).join(" · ")}
                </div>
                {lr.note ? <div className="mt-1 text-[12px] text-body">“{lr.note}”</div> : null}
              </div>
              {canWrite ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setEditing(lr)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => (setReason(""), setVoiding(lr))}>
                    Void
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <div>
              <div className="text-[15px] font-semibold text-ink">Bills waiting for their LR</div>
              <div className="text-[12px] text-muted">Pick an LR on the left to attach it to the bills it carries.</div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-b border-divider bg-canvas px-4 py-1.5 text-[12px] text-muted">
          <span>{plural(waiting.length, "bill")} at the transporter, waiting for the LR</span>
          {onTheWay.length ? (
            <label className="ml-auto flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-[#6835FB]" />
              Also show {plural(onTheWay.length, "bill")} not yet marked at the transporter
            </label>
          ) : null}
        </div>

        {ranked.length ? (
          <div className="max-h-[56vh] overflow-y-auto">
            {ranked.map(({ c, score, reasons }, i) => (
              <label key={c.id} className={cx("grid cursor-pointer grid-cols-[24px_minmax(110px,1fr)_minmax(150px,1.6fr)_minmax(110px,1fr)_70px_110px] items-center gap-3 border-b border-divider px-4 py-2 text-sm last:border-0", ticked.has(c.id) ? "bg-brand-soft/50" : lr && score >= 5 && i < 6 ? "bg-success-soft/40" : "")}>
                <input type="checkbox" disabled={!lr || !canWrite} checked={ticked.has(c.id)} onChange={() => toggle(c)} className="h-[15px] w-[15px] accent-[#6835FB]" />
                <span className="min-w-0">
                  <BillRef c={c} />
                  <span className="block text-[12px] text-muted">Order {c.orderNo}</span>
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{c.deliveryParty}</span>
                  <span className="block truncate text-[12px] text-muted">{c.area ?? c.partyCity ?? "—"}</span>
                </span>
                <span className="min-w-0 truncate text-[13px] text-body">{c.transporter ?? "—"}</span>
                <span className="tabular-nums">{c.packages ?? "—"}</span>
                <span className="flex flex-wrap gap-1">
                  {lr && reasons.length ? reasons.slice(0, 2).map((r) => <Badge key={r} tone={r === "same transporter" || r === "destination matches" ? "success" : "neutral"}>{r}</Badge>) : c.phase === "toTransport" ? <DuePill day={c.transportDueOn} today={today} prefix="Due" /> : <Badge tone="muted">At transporter</Badge>}
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
              <div className="text-[13px] text-muted">Tick the bills this LR carries.</div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-[12px] text-muted">
                Expected delivery
                <input type="date" value={expected} min={lr.lrDate ?? today} onChange={(e) => setExpected(e.target.value)} className="mt-0.5 block h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink" />
              </label>
              <label className="text-[12px] text-muted">
                Next call to the transporter
                <input type="date" value={nextCall} min={today} onChange={(e) => setNextCall(e.target.value)} className="mt-0.5 block h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink" />
              </label>
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

      <Modal open={upload} onClose={() => setUpload(false)} title="Upload LRs" width={860}>
        <LrUpload today={today} transporters={transporters} onDone={() => setUpload(false)} />
      </Modal>

      {editing ? <EditLr key={editing.id} lr={editing} transporters={transporters} today={today} onClose={() => setEditing(null)} /> : null}

      <Modal
        open={!!voiding}
        onClose={() => setVoiding(null)}
        title={voiding ? `Void ${lrUploadName(voiding.lrNo)}?` : ""}
        footer={
          <>
            <Button onClick={() => setVoiding(null)}>Keep it</Button>
            <Button variant="danger" disabled={pending || reason.trim().length < 3} onClick={() => voiding && run(() => erpLogisticsVoidLr(voiding.id, reason), (r) => r.ok && setVoiding(null))}>
              Void
            </Button>
          </>
        }
      >
        <p className="mb-2 text-sm text-body">A voided LR leaves the desk and stays on record with your reason. Use it for a wrong or duplicate upload.</p>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why?" className="w-full rounded-[4px] border border-line px-2.5 py-2 text-sm outline-none focus:border-brand" />
      </Modal>
    </div>
  );
}

function EditLr({ lr, transporters, today, onClose }: { lr: UploadedLr; transporters: string[]; today: string; onClose: () => void }) {
  const { run, pending } = useAct();
  const [v, setV] = useState({ lrNo: lr.lrNo ?? "", lrDate: lr.lrDate ?? today, transporter: lr.transporter ?? "", destination: lr.destination ?? "", packages: lr.packages == null ? "" : String(lr.packages), freightTerm: lr.freightTerm ?? "", freight: lr.freightPaise == null ? "" : String(lr.freightPaise / 100), note: lr.note ?? "" });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const cls = "mt-0.5 block h-8.5 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand";
  return (
    <Modal
      open
      onClose={onClose}
      title={lr.lrNo ? `Edit LR ${lr.lrNo}` : "Edit LR — add its number"}
      footer={
        <>
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
        </>
      }
    >
      <datalist id="lr-edit-transporters">
        {transporters.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="grid grid-cols-2 gap-3 text-[12px] text-muted">
        <label>LR number<input value={v.lrNo} onChange={set("lrNo")} className={cls} /></label>
        <label>LR date<input type="date" value={v.lrDate} max={today} onChange={set("lrDate")} className={cls} /></label>
        <label>Transporter<input list="lr-edit-transporters" value={v.transporter} onChange={set("transporter")} className={cls} /></label>
        <label>Destination<input value={v.destination} onChange={set("destination")} className={cls} /></label>
        <label>Boxes<input inputMode="numeric" value={v.packages} onChange={set("packages")} className={cls} /></label>
        <label>
          Freight
          <select value={v.freightTerm} onChange={set("freightTerm")} className={cls}>
            <option value="">—</option>
            <option>Paid</option>
            <option>To pay</option>
            <option>TBB</option>
          </select>
        </label>
        <label>Freight ₹<input inputMode="decimal" value={v.freight} onChange={set("freight")} className={cls} /></label>
        <label>Note<input value={v.note} onChange={set("note")} className={cls} /></label>
      </div>
    </Modal>
  );
}
