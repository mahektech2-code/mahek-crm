"use client";

import { useRef, useState } from "react";
import { CardGrid } from "@/components/ui/card-grid";
import { Button, Card, cx } from "@/components/ui/primitives";
import { erpLogisticsReadLr, erpLogisticsUploadLrs } from "@/lib/actions/erp-logistics";
import { lrRowHasAnything } from "@/lib/erp/engines/logistics";
import { useAct } from "./common";

/**
 * STEP 3 — the dispatch team's upload. Photograph every LR collected from the
 * transporters (several at once: each photo becomes a row), type the number off
 * each, and send. Nothing is attached to a bill here — logistics does that on
 * the LR desk, where the photo sits beside the bills waiting for it.
 *
 * Where reading is on, each photo is read as soon as it is uploaded (OpenAI,
 * against the transporter's own consignment-number style — `lr-upload-read.ts`)
 * and fills the row's fields. Only fields nobody has typed in are filled, a
 * number worth a second look is marked, and Upload is still the only save.
 */
type Field = "lrNo" | "lrDate" | "transporter" | "destination" | "packages" | "freightTerm" | "freight";
type Row = {
  key: string;
  fileId: string;
  fileName: string;
  preview: string | null;
  uploading: boolean;
  error: string;
  lrNo: string;
  lrDate: string;
  transporter: string;
  destination: string;
  packages: string;
  freightTerm: string;
  freight: string;
  note: string;
  /** Fields the person typed into — a reading never writes over them. */
  typed: Field[];
  /** Fields the last reading filled, marked so they are checked. */
  read: Field[];
  reading: boolean;
  readingId: string;
  readNotes: string[];
  checkNumber: boolean;
};

let seq = 0;
const blank = (today: string, transporter = ""): Row => ({ key: `r${++seq}`, fileId: "", fileName: "", preview: null, uploading: false, error: "", lrNo: "", lrDate: today, transporter, destination: "", packages: "", freightTerm: "", freight: "", note: "", typed: [], read: [], reading: false, readingId: "", readNotes: [], checkNumber: false });

export function LrUpload({ today, transporters, canRead = false, onDone }: { today: string; transporters: string[]; canRead?: boolean; onDone?: () => void }) {
  const { run, pending } = useAct();
  const [rows, setRows] = useState<Row[]>([blank(today)]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const many = useRef<HTMLInputElement>(null);

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  /* A field the person typed into is theirs: marked so a reading leaves it alone. */
  const edit = (key: string, field: Field, value: string) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value, typed: r.typed.includes(field) ? r.typed : [...r.typed, field], read: r.read.filter((f) => f !== field), ...(field === "lrNo" ? { checkNumber: false } : {}) } : r)));

  const readPhoto = async (key: string, fileId: string) => {
    patch(key, { reading: true, readNotes: [], readingId: "", checkNumber: false });
    let res: Awaited<ReturnType<typeof erpLogisticsReadLr>>;
    try {
      res = await erpLogisticsReadLr(fileId);
    } catch {
      res = { ok: false, error: "The receipt could not be read just now. Type the details from the photo." } as typeof res;
    }
    setRows((rs) =>
      rs.map((r) => {
        /* A photo replaced while it was being read: this answer is about the old one. */
        if (r.key !== key || r.fileId !== fileId) return r;
        if (!res.ok) return { ...r, reading: false, readNotes: [res.error] };
        const s = res.data.suggestion;
        const offered: Record<Field, string | null> = {
          lrNo: s.lrNo,
          lrDate: s.lrDate,
          transporter: s.transporter,
          destination: s.destination,
          packages: s.packages != null ? String(s.packages) : null,
          freightTerm: s.freightTerm,
          freight: s.freightRupees != null ? String(s.freightRupees) : null,
        };
        const next: Row = { ...r, reading: false, readingId: res.data.readingId, readNotes: s.notes, read: [] };
        for (const f of Object.keys(offered) as Field[]) {
          const v = offered[f];
          if (v == null || v === "" || r.typed.includes(f)) continue;
          next[f] = v;
          next.read = [...next.read, f];
        }
        next.checkNumber = s.checkNumber && next.read.includes("lrNo");
        return next;
      }),
    );
  };

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
      if (canRead) void readPhoto(key, j.id);
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
      .filter((r) => lrRowHasAnything({ ...r, packages: r.packages ? Number(r.packages) : null, freightRupees: r.freight ? Number(r.freight) : null }))
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
        readingId: r.readingId || null,
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
  const reading = rows.some((r) => r.reading);
  const filled = rows.filter((r) => lrRowHasAnything({ ...r, packages: r.packages ? Number(r.packages) : null, freightRupees: r.freight ? Number(r.freight) : null })).length;

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
              {r.uploading || r.reading ? <span className="absolute inset-x-0 bottom-0 bg-ink/70 py-0.5 text-white">{r.uploading ? "Uploading…" : "Reading…"}</span> : null}
              <input type="file" accept="image/*,application/pdf" capture="environment" className="absolute inset-0 cursor-pointer opacity-0" onChange={(ev) => ev.target.files?.[0] && void upload(r.key, ev.target.files[0])} />
            </label>
            <CardGrid min={150} gap="gap-2" className="min-w-0 flex-1">
              <Box label="LR number" error={e("lrNo")} read={r.read.includes("lrNo")} check={r.checkNumber}>
                <input value={r.lrNo} onChange={(ev) => edit(r.key, "lrNo", ev.target.value.toUpperCase())} placeholder={r.reading ? "Reading the photo…" : "e.g. 1048821"} className={inp(!!e("lrNo"), "w-full", r.checkNumber)} autoFocus={i === rows.length - 1 && i > 0} />
              </Box>
              <Box label="LR date" error={e("lrDate")} read={r.read.includes("lrDate")}>
                <input type="date" value={r.lrDate} max={today} onChange={(ev) => edit(r.key, "lrDate", ev.target.value)} className={inp(false)} />
              </Box>
              <Box label="Transporter" read={r.read.includes("transporter")}>
                <input list="lr-transporters" value={r.transporter} onChange={(ev) => edit(r.key, "transporter", ev.target.value)} className={inp(false)} />
              </Box>
              <Box label="Destination" read={r.read.includes("destination")}>
                <input value={r.destination} onChange={(ev) => edit(r.key, "destination", ev.target.value)} placeholder="As printed on the LR" className={inp(false)} />
              </Box>
              <Box label="Boxes (articles)" read={r.read.includes("packages")}>
                <input inputMode="numeric" value={r.packages} onChange={(ev) => edit(r.key, "packages", ev.target.value.replace(/\D/g, ""))} className={inp(false)} />
              </Box>
              <Box label="Freight" error={e("freightTerm")} read={r.read.includes("freightTerm") || r.read.includes("freight")}>
                <span className="flex gap-1">
                  <select value={r.freightTerm} onChange={(ev) => edit(r.key, "freightTerm", ev.target.value)} className={cx(inp(false, "w-[84px]"), "flex-none")}>
                    <option value="">—</option>
                    <option>Paid</option>
                    <option>To pay</option>
                    <option>TBB</option>
                  </select>
                  <input inputMode="decimal" value={r.freight} onChange={(ev) => edit(r.key, "freight", ev.target.value.replace(/[^\d.]/g, ""))} placeholder="₹ amount" className={inp(false, "w-0 min-w-0 flex-1")} />
                </span>
              </Box>
            </CardGrid>
            {r.readNotes.length ? (
              <ul className="w-full space-y-0.5 text-[12px] text-warn-ink">
                {r.readNotes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
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
        <span className="text-[12px] text-muted">Each photo becomes its own LR row. Nothing is required — a photo alone is enough.</span>
        <Button variant="primary" className="ml-auto" disabled={pending || busy || reading || !filled} onClick={submit}>
          {busy ? "Waiting for photos…" : reading ? "Reading photos…" : `Upload ${filled || ""} LR${filled === 1 ? "" : "s"}`}
        </Button>
      </div>
    </div>
  );
}

const inp = (bad: boolean, width = "w-full", check = false) => cx("h-8.5 rounded-[4px] border bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand", width, bad ? "border-danger" : check ? "border-warn" : "border-line");

function Box({ label, error, read, check, children }: { label: string; error?: string; read?: boolean; check?: boolean; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
        {read ? <span className={cx("normal-case tracking-normal", check ? "text-warn-ink" : "text-brand")} title="Read from the photo — check it against the receipt">{check ? "· check" : "· read"}</span> : null}
      </span>
      {children}
      {error ? <span className="mt-0.5 block text-[12px] text-danger">{error}</span> : null}
    </label>
  );
}
