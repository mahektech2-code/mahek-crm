"use client";

import { useEffect, useState } from "react";
import { Button, cx, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { DialogBody, DialogFooter, DialogHeader, ErpDialog, DialogTitle } from "../../_ui/dialog";
import { ErpImpactDialog } from "../../_ui/impact-confirm";
import { Icon } from "../../_ui/icons";
import { erpLogisticsDetach, erpLogisticsEditLr, erpLogisticsLrForEdit, erpLogisticsSetKind, erpLogisticsVoidLr } from "@/lib/actions/erp-logistics";
import type { Consignment, UploadedLr } from "@/lib/erp/logistics";
import { rupeesField } from "@/lib/erp/ui";
import { shrinkImage } from "@/lib/shrink-image";
import { BillRef, LrThumb, lrLabel, NotifyToggle, plural, ReasonDialog, useAct } from "./common";
import { PhotoEditor } from "./photo-editor";

/**
 * FIXING AN LR THAT IS ALREADY ON THE ROAD. Four mistakes, four ways out,
 * all from the card itself:
 *
 *  - the paper is right but was typed wrong — edit it here; every bill under
 *    it follows, and the party can be told the correction;
 *  - one bill was ticked that this LR does not carry — take that bill off,
 *    and it waits for its own LR on the Documents desk;
 *  - it is not an LR at all but a signed copy uploaded as one — move it to
 *    Signed copies; the bills come off it and wait for their real LR;
 *  - the whole LR is wrong — delete it: it is voided with a reason (never
 *    erased) and every bill on it goes back to waiting for its LR.
 *
 * A delivered bill keeps its LR on every path — reopen it first.
 */
export function EditLrDialog({ group, today, transporters, notifyOn, onClose }: { group: Consignment[]; today: string; transporters: string[]; notifyOn: boolean; onClose: () => void }) {
  const lrId = group[0].lrId;
  const [lr, setLr] = useState<UploadedLr | null>(null);
  const [loadErr, setLoadErr] = useState("");

  useEffect(() => {
    if (!lrId) return;
    let live = true;
    void erpLogisticsLrForEdit(lrId).then((r) => {
      if (!live) return;
      if (r.ok) setLr(r.data);
      else setLoadErr(r.error);
    });
    return () => {
      live = false;
    };
  }, [lrId]);

  const title = `Edit ${lrLabel(group[0].lrNo)}`;
  if (!lr)
    return (
      <ErpDialog onClose={onClose} label={title} size="sm" tall={false}>
        <DialogHeader onClose={onClose}>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className={cx("text-sm", loadErr ? "text-danger" : "text-muted")}>{loadErr || "Opening the LR…"}</p>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </ErpDialog>
    );
  return <EditForm lr={lr} group={group} today={today} transporters={transporters} notifyOn={notifyOn} onClose={onClose} />;
}

function EditForm({ lr, group, today, transporters, notifyOn, onClose }: { lr: UploadedLr; group: Consignment[]; today: string; transporters: string[]; notifyOn: boolean; onClose: () => void }) {
  const { run, pending } = useAct();
  const initial = {
    lrNo: lr.lrNo ?? "",
    lrDate: lr.lrDate ?? today,
    transporter: lr.transporter ?? "",
    destination: lr.destination ?? "",
    packages: lr.packages == null ? "" : String(lr.packages),
    freightTerm: lr.freightTerm ?? "",
    freight: lr.freightPaise == null ? "" : rupeesField(lr.freightPaise),
    note: lr.note ?? "",
  };
  const [v, setV] = useState(initial);
  const set = (k: keyof typeof initial) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const [photo, setPhoto] = useState<{ id: string; preview: string | null } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [upErr, setUpErr] = useState("");
  const [cropping, setCropping] = useState(false);
  const [notify, setNotify] = useState(true);
  const [taking, setTaking] = useState<Consignment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteReason, setDeleteReason] = useState<string | null>(null);
  const [wrongKind, setWrongKind] = useState(false);

  const dirty = photo != null || (Object.keys(initial) as (keyof typeof initial)[]).some((k) => v[k] !== initial[k]);
  /* What the party was told: a change to any of these is a correction worth sending. */
  const toldChanged = v.lrNo.trim().toUpperCase() !== (lr.lrNo ?? "") || v.transporter.trim() !== (lr.transporter ?? "") || v.lrDate !== (lr.lrDate ?? today);
  const open = group.filter((c) => c.phase !== "delivered");
  const delivered = group.length - open.length;

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
      setPhoto({ id: j.id, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
    } catch (e) {
      setUpErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const save = () =>
    run(
      () =>
        erpLogisticsEditLr(
          lr.id,
          {
            lrNo: v.lrNo,
            lrDate: v.lrDate,
            transporter: v.transporter,
            destination: v.destination,
            packages: v.packages ? Number(v.packages) : null,
            freightTerm: v.freightTerm || null,
            freightRupees: v.freight ? Number(v.freight) : null,
            note: v.note,
            fileId: photo?.id ?? null,
          },
          { notify: toldChanged && notify },
        ),
      (r) => r.ok && onClose(),
    );

  return (
    <>
      <ErpDialog onClose={onClose} label={`Edit ${lrLabel(lr.lrNo)}`} size="md" tall={false}>
        <DialogHeader onClose={onClose}>
          <DialogTitle>Edit {lrLabel(lr.lrNo)}</DialogTitle>
        </DialogHeader>
        <DialogBody className="gap-4">
          <div className="flex gap-4">
            <div className="flex flex-none flex-col items-center gap-1.5">
              {photo?.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo.preview} alt="New LR photo" className="h-[96px] w-[96px] rounded-control border border-line object-cover" />
              ) : (
                <LrThumb fileId={photo?.id ?? lr.fileId} size={96} />
              )}
              <label className={cx("cursor-pointer text-meta text-brand hover:underline", uploading && "opacity-60")}>
                {uploading ? "Uploading…" : lr.fileId || photo ? "Replace photo" : "Add photo"}
                <input type="file" accept="image/*,application/pdf" className="hidden" disabled={uploading} onChange={(e) => void upload(e.target.files?.[0])} />
              </label>
              {lr.fileId && !photo ? (
                <button type="button" className="cursor-pointer text-meta text-muted hover:text-body" onClick={() => setCropping(true)}>
                  Crop or rotate
                </button>
              ) : null}
              {upErr ? <span className="max-w-[110px] text-center text-meta text-danger">{upErr}</span> : null}
            </div>
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-3">
              <datalist id="edit-lr-transporters">
                {transporters.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <Field label="LR no.">
                <Input value={v.lrNo} onChange={set("lrNo")} className={cx(!v.lrNo.trim() && "border-warn")} />
              </Field>
              <Field label="Transporter">
                <Input list="edit-lr-transporters" value={v.transporter} onChange={set("transporter")} />
              </Field>
              <Field label="LR date">
                <Input type="date" value={v.lrDate} max={today} onChange={set("lrDate")} />
              </Field>
              <Field label="Boxes">
                <Input inputMode="numeric" value={v.packages} onChange={set("packages")} />
              </Field>
              <Field label="Destination">
                <Input value={v.destination} onChange={set("destination")} />
              </Field>
              <Field label="Freight">
                <div className="flex gap-2">
                  <Select value={v.freightTerm} onChange={set("freightTerm")} aria-label="Freight term" className="w-[96px]">
                    <option value="">—</option>
                    <option>Paid</option>
                    <option>To pay</option>
                    <option>TBB</option>
                  </Select>
                  <Input inputMode="decimal" value={v.freight} onChange={set("freight")} placeholder="₹" aria-label="Freight amount" />
                </div>
              </Field>
              <div className="col-span-2">
                <Field label="Note">
                  <Textarea value={v.note} onChange={set("note")} rows={2} />
                </Field>
              </div>
            </div>
          </div>

          {wrongKind ? (
            <div className="flex flex-wrap items-center gap-2 rounded-control border border-warn/60 bg-warn-soft px-3 py-2 text-sm text-warn-ink">
              <Icon n="warn" s={14} />
              <span className="min-w-0 flex-1">
                It moves to Signed copies on the Documents desk. {plural(open.length, "bill")} come{open.length === 1 ? "s" : ""} off it and wait{open.length === 1 ? "s" : ""} for the real LR. The party is not messaged.
              </span>
              <Button size="sm" onClick={() => setWrongKind(false)}>
                Keep as LR
              </Button>
              <Button size="sm" variant="primary" disabled={pending} onClick={() => run(() => erpLogisticsSetKind(lr.id, "signed_copy"), (r) => r.ok && onClose())}>
                Move to signed copies
              </Button>
            </div>
          ) : null}

          {toldChanged && open.length ? <NotifyToggle value={notify} onChange={setNotify} disabled={!notifyOn} /> : null}

          <div>
            <div className="mb-1 text-meta font-semibold text-muted">Bills on this LR</div>
            <ul className="divide-y divide-divider rounded-control border border-line">
              {group.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <BillRef c={c} />
                  <span className="min-w-0 flex-1 truncate text-body">{c.deliveryParty}</span>
                  {c.phase === "delivered" ? (
                    <span className="text-meta text-muted">Delivered — keeps its LR</span>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setTaking(c)} title="This bill is not on this LR. It goes back to waiting for its LR on the Documents desk.">
                      Not on this LR — take off
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            className="mr-auto text-danger"
            disabled={pending || delivered > 0}
            title={delivered ? "A delivered bill keeps its LR. Reopen it first." : "The whole LR is wrong: it is voided with your reason and every bill goes back to waiting for its LR"}
            onClick={() => setDeleting(true)}
          >
            <Icon n="bin" s={14} />
            Delete LR
          </Button>
          <Button
            variant="ghost"
            disabled={pending || delivered > 0}
            title={delivered ? "A delivered bill keeps its LR. Reopen it first." : "This upload is a customer-signed copy, not an LR"}
            onClick={() => setWrongKind(true)}
          >
            It&apos;s a signed copy
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={pending || uploading || !dirty || !v.lrNo.trim()} title={!v.lrNo.trim() ? "An LR on the road needs its number" : undefined} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </ErpDialog>

      {cropping && lr.fileId ? <PhotoEditor lrId={lr.id} fileId={lr.fileId} onClose={() => setCropping(false)} /> : null}

      <ReasonDialog
        key={taking?.id ?? "none"}
        open={taking != null}
        title={`Take ${taking?.billNo ?? `order ${taking?.orderNo ?? ""}`} off ${lrLabel(lr.lrNo)}`}
        body={`It leaves On the road and waits for its LR on the Documents desk.${group.length === 1 ? " This LR then carries nothing and goes back to the desk too." : ""} The party is not messaged — attaching the right LR tells them.`}
        placeholder="Why — e.g. picked the wrong bill"
        keepLabel="Keep it"
        confirmLabel="Take it off"
        pending={pending}
        onClose={() => setTaking(null)}
        onConfirm={(reason) => {
          const t = taking!;
          setTaking(null);
          void run(() => erpLogisticsDetach(t.id, reason), (r) => r.ok && group.length === 1 && onClose());
        }}
      />
      <ReasonDialog
        open={deleting}
        title={`Delete ${lrLabel(lr.lrNo)}`}
        body={`It is voided with your reason — the photo and the record stay. ${plural(open.length, "bill")} go${open.length === 1 ? "es" : ""} back to waiting for an LR on the Documents desk.`}
        placeholder="Why — e.g. wrong LR uploaded"
        keepLabel="Keep it"
        confirmLabel="Next"
        tone="danger"
        pending={pending}
        onClose={() => setDeleting(false)}
        onConfirm={(reason) => {
          setDeleting(false);
          setDeleteReason(reason);
        }}
      />
      {deleteReason ? (
        <ErpImpactDialog
          kind="erp-lr-void"
          id={lr.id}
          confirmLabel="Delete LR"
          onClose={() => setDeleteReason(null)}
          act={(confirmation) => erpLogisticsVoidLr(lr.id, deleteReason, confirmation)}
          onDone={onClose}
        />
      ) : null}
    </>
  );
}
