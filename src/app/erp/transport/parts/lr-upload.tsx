"use client";

import { useRef, useState } from "react";
import { CardGrid } from "@/components/ui/card-grid";
import { Button, Card, cx } from "@/components/ui/primitives";
import { erpLogisticsUploadLrs } from "@/lib/actions/erp-logistics";
import { useAct } from "./common";

/**
 * STEP 3 — the dispatch team's upload. Photograph every LR collected from the
 * transporters (several at once: each photo becomes a row), type the number off
 * each, and send. Nothing is attached to a bill here — logistics does that on
 * the LR desk, where the photo sits beside the bills waiting for it.
 */
type Row = { key: string; fileId: string; fileName: string; preview: string | null; uploading: boolean; error: string; lrNo: string; lrDate: string; transporter: string; destination: string; packages: string; freightTerm: string; freight: string; note: string };

let seq = 0;
const blank = (today: string, transporter = ""): Row => ({ key: `r${++seq}`, fileId: "", fileName: "", preview: null, uploading: false, error: "", lrNo: "", lrDate: today, transporter, destination: "", packages: "", freightTerm: "", freight: "", note: "" });

export function LrUpload({ today, transporters, onDone }: { today: string; transporters: string[]; onDone?: () => void }) {
  const { run, pending } = useAct();
  const [rows, setRows] = useState<Row[]>([blank(today)]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const many = useRef<HTMLInputElement>(null);

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const upload = async (key: string, file: File) => {
    patch(key, { uploading: true, error: "", fileName: file.name, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("kind", "photo");
      const res = await fetch("/api/erp/attachments", { method: "POST", body });
      const j = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !j.id) throw new Error(j.error || "Upload failed");
      patch(key, { fileId: j.id, uploading: false });
    } catch (e) {
      patch(key, { uploading: false, error: e instanceof Error ? e.message : "Upload failed", fileId: "" });
    }
  };

  const addPhotos = (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files].slice(0, 50);
    const last = rows[rows.length - 1];
    /* The first photo fills an empty last row rather than leaving it blank above. */
    const reuse = last && !last.fileId && !last.lrNo && !last.uploading ? last.key : null;
    const fresh = list.map((_, i) => (i === 0 && reuse ? null : blank(today, last?.transporter ?? "")));
    setRows((rs) => [...rs, ...(fresh.filter(Boolean) as Row[])]);
    list.forEach((f, i) => void upload(i === 0 && reuse ? reuse : (fresh[i] as Row).key, f));
  };

  const submit = () => {
    setErrors({});
    const items = rows
      .filter((r) => r.lrNo.trim() || r.fileId)
      .map((r) => ({
        lrNo: r.lrNo,
        lrDate: r.lrDate || null,
        transporter: r.transporter || null,
        destination: r.destination || null,
        packages: r.packages ? Number(r.packages) : null,
        freightTerm: r.freightTerm || null,
        freightRupees: r.freight ? Number(r.freight) : null,
        fileId: r.fileId || null,
        note: r.note || null,
      }));
    void run(
      () => erpLogisticsUploadLrs(items),
      (res) => {
        if (res.ok) {
          setRows([blank(today, rows[rows.length - 1]?.transporter ?? "")]);
          onDone?.();
        } else if (res.fieldErrors?.length) setErrors(Object.fromEntries(res.fieldErrors.map((f) => [f.field, f.message])));
      },
    );
  };

  const busy = rows.some((r) => r.uploading);
  const filled = rows.filter((r) => r.lrNo.trim() || r.fileId).length;

  return (
    <div className="space-y-3">
      <datalist id="lr-transporters">
        {transporters.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {rows.map((r, i) => {
        const e = (f: string) => errors[`l${i + 1}.${f}`];
        return (
          <Card key={r.key} className="flex flex-wrap gap-3 p-3">
            <label className={cx("relative flex h-[92px] w-[92px] flex-none cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[4px] border text-center text-[11px]", r.fileId ? "border-success" : r.error ? "border-danger" : "border-dashed border-line-strong bg-canvas text-muted")}>
              {r.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.preview} alt="" className="absolute inset-0 h-full w-full object-cover" />
              ) : r.fileId ? (
                <span className="px-1 font-medium text-success">{r.fileName || "Attached"}</span>
              ) : (
                <span className="px-2">{r.uploading ? "Uploading…" : "Photo of the LR"}</span>
              )}
              {r.uploading ? <span className="absolute inset-x-0 bottom-0 bg-ink/70 py-0.5 text-white">Uploading…</span> : null}
              <input type="file" accept="image/*,application/pdf" capture="environment" className="absolute inset-0 cursor-pointer opacity-0" onChange={(ev) => ev.target.files?.[0] && void upload(r.key, ev.target.files[0])} />
            </label>
            <CardGrid min={150} gap="gap-2" className="min-w-0 flex-1">
              <Box label="LR number *" error={e("lrNo")}>
                <input value={r.lrNo} onChange={(ev) => patch(r.key, { lrNo: ev.target.value.toUpperCase() })} placeholder="e.g. 1048821" className={inp(!!e("lrNo"))} autoFocus={i === rows.length - 1 && i > 0} />
              </Box>
              <Box label="LR date" error={e("lrDate")}>
                <input type="date" value={r.lrDate} max={today} onChange={(ev) => patch(r.key, { lrDate: ev.target.value })} className={inp(false)} />
              </Box>
              <Box label="Transporter">
                <input list="lr-transporters" value={r.transporter} onChange={(ev) => patch(r.key, { transporter: ev.target.value })} className={inp(false)} />
              </Box>
              <Box label="Destination">
                <input value={r.destination} onChange={(ev) => patch(r.key, { destination: ev.target.value })} placeholder="As printed on the LR" className={inp(false)} />
              </Box>
              <Box label="Boxes (articles)">
                <input inputMode="numeric" value={r.packages} onChange={(ev) => patch(r.key, { packages: ev.target.value.replace(/\D/g, "") })} className={inp(false)} />
              </Box>
              <Box label="Freight" error={e("freightTerm")}>
                <span className="flex gap-1">
                  <select value={r.freightTerm} onChange={(ev) => patch(r.key, { freightTerm: ev.target.value })} className={cx(inp(false), "w-[92px] flex-none")}>
                    <option value="">—</option>
                    <option>Paid</option>
                    <option>To pay</option>
                    <option>TBB</option>
                  </select>
                  <input inputMode="decimal" value={r.freight} onChange={(ev) => patch(r.key, { freight: ev.target.value.replace(/[^\d.]/g, "") })} placeholder="₹" className={inp(false)} />
                </span>
              </Box>
            </CardGrid>
            <div className="flex w-full items-center gap-3 text-[12px]">
              {r.error ? <span className="text-danger">{r.error}</span> : null}
              <input value={r.note} onChange={(ev) => patch(r.key, { note: ev.target.value })} placeholder="Note for logistics (optional)" className="h-8 flex-1 rounded-[4px] border border-line bg-surface px-2 text-[13px] outline-none focus:border-brand" />
              {rows.length > 1 ? (
                <button className="cursor-pointer text-muted hover:text-danger" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                  Remove
                </button>
              ) : null}
            </div>
          </Card>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setRows((rs) => [...rs, blank(today, rs[rs.length - 1]?.transporter ?? "")])}>
          + Another LR
        </Button>
        <Button size="sm" onClick={() => many.current?.click()}>
          Add several photos
        </Button>
        <input ref={many} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={(e) => addPhotos(e.target.files)} />
        <span className="text-[12px] text-muted">Each photo becomes its own LR row.</span>
        <Button variant="primary" className="ml-auto" disabled={pending || busy || !filled} onClick={submit}>
          {busy ? "Waiting for photos…" : `Upload ${filled || ""} LR${filled === 1 ? "" : "s"}`}
        </Button>
      </div>
    </div>
  );
}

const inp = (bad: boolean) => cx("h-8.5 w-full rounded-[4px] border bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand", bad ? "border-danger" : "border-line");

function Box({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-0.5 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
      {children}
      {error ? <span className="mt-0.5 block text-[12px] text-danger">{error}</span> : null}
    </label>
  );
}
