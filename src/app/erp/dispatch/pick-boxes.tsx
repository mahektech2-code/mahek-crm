"use client";

import { useState } from "react";
import type { DispatchBoard, PickableBox } from "@/lib/erp/dispatch";
import { erpDispatchScan } from "@/lib/actions/erp-trace";
import { fd, nf } from "@/lib/erp/ui";
import { Button, checkboxClass, cx, Input } from "@/components/ui/primitives";
import { MultiSelect } from "@/components/ui/multi-select";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog } from "../_ui/dialog";
import { Icon } from "../_ui/icons";
import { fieldLabelClass, LinkButton } from "../_ui/look";

/* ---------------------------------------------------------------------------
 * PICK BOXES OFF A LIST, for when a QR will not read and a sixteen-character
 * id is the alternative. The list is only boxes that could go on THIS order —
 * in stock, the SKU a waiting line asks for, at its godown — narrowed by
 * product, lot and the few digits somebody can read off the label, and ticked
 * as many at a time as are going on.
 *
 * Adding is scanning: each ticked box goes through the desk's own scan, one
 * after another, judged and logged exactly as a read QR would be. A list is a
 * way to name a box, never a way past the check.
 * ------------------------------------------------------------------------- */

type Outcome = { id: string; ok: boolean; message: string };

export function PickBoxesButton({ board, boxes, onDone }: { board: DispatchBoard; boxes: PickableBox[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" className="h-12" onClick={() => setOpen(true)} disabled={!boxes.length} title={boxes.length ? "Choose boxes or loose cans from a list instead of scanning" : "No box or loose can in stock matches this order's waiting lines"}>
        <Icon n="filter" s={15} />
        Pick from list
      </Button>
      {open ? (
        <PickBoxesDialog
          board={board}
          boxes={boxes}
          onClose={(added) => {
            setOpen(false);
            if (added) onDone();
          }}
        />
      ) : null}
    </>
  );
}

function PickBoxesDialog({ board, boxes, onClose }: { board: DispatchBoard; boxes: PickableBox[]; onClose: (added: boolean) => void }) {
  const lines = board.lines.filter((l) => !l.cancelled && !l.dispatched);
  const [term, setTerm] = useState("");
  const [lineIds, setLineIds] = useState<string[]>([]);
  const [lots, setLots] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<{ done: number; of: number } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);

  const need = (lineId: string) => {
    const l = lines.find((x) => x.id === lineId);
    return l ? Math.max(0, l.target - l.scanned) : 0;
  };
  const count = (rows: PickableBox[], key: (b: PickableBox) => string) => {
    const n = new Map<string, number>();
    for (const b of rows) n.set(key(b), (n.get(key(b)) ?? 0) + 1);
    return n;
  };
  const perLine = count(boxes, (b) => b.lineId);
  const lineOptions = lines.filter((l) => perLine.has(l.id)).map((l) => ({ value: l.id, label: `${l.skuName} · ${nf(perLine.get(l.id)!)} in stock` }));
  const lotRows = lineIds.length ? boxes.filter((b) => lineIds.includes(b.lineId)) : boxes;
  const perLot = count(lotRows, (b) => b.lotCode);
  const lotOptions = [...perLot.keys()].sort().map((k) => ({ value: k, label: `${k} · ${nf(perLot.get(k)!)}` }));

  /* The digits on a label are what can be read off it: "876" finds BX-261029-000876. */
  const words = term.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const shown = boxes.filter(
    (b) => (!lineIds.length || lineIds.includes(b.lineId)) && (!lots.length || lots.includes(b.lotCode)) && words.every((w) => `${b.id} ${b.lotCode} ${b.sku}`.toUpperCase().includes(w)),
  );
  const isPicked = new Set(picked);
  const toggle = (id: string) => setPicked(isPicked.has(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const allShown = shown.length > 0 && shown.every((b) => isPicked.has(b.id));

  /* What each line still needs, from the top of the list — allocated lots first, oldest box first. */
  const fillNeeded = () => {
    const next = new Set(picked);
    for (const l of lines) {
      let left = need(l.id) - picked.filter((id) => boxes.find((b) => b.id === id)?.lineId === l.id).length;
      for (const b of shown) {
        if (left <= 0) break;
        if (b.lineId === l.id && !next.has(b.id)) {
          next.add(b.id);
          left -= 1;
        }
      }
    }
    setPicked([...next]);
  };

  const add = async () => {
    const ids = [...picked];
    const out: Outcome[] = [];
    setBusy({ done: 0, of: ids.length });
    for (const id of ids) {
      const res = await erpDispatchScan(board.orderNo, id);
      out.push(res.ok ? { id, ok: res.data.verdict.ok, message: res.data.verdict.message } : { id, ok: false, message: res.error });
      setBusy({ done: out.length, of: ids.length });
    }
    setBusy(null);
    setPicked([]);
    setOutcomes(out);
  };

  const pickedPerLine = lines.map((l) => ({ l, n: picked.filter((id) => boxes.find((b) => b.id === id)?.lineId === l.id).length })).filter((x) => x.n > 0);

  if (outcomes) {
    const good = outcomes.filter((o) => o.ok).length;
    return (
      <ErpDialog onClose={() => onClose(true)} label="Added" size="md" tall={false}>
        <DialogHeader onClose={() => onClose(true)}>
          <DialogTitle>
            {nf(good)} of {nf(outcomes.length)} added
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-1">
          {outcomes.map((o) => (
            <div key={o.id} className={cx("flex items-start gap-3 rounded-lg px-3 py-2 text-meta", o.ok ? "bg-success-soft" : "bg-danger-soft")}>
              <span className="flex-none font-mono font-semibold">{o.id}</span>
              <span className="min-w-0 flex-1 text-body">{o.ok ? "✓ " : "✗ "}{o.message}</span>
            </div>
          ))}
        </DialogBody>
        <DialogFooter left={good < outcomes.length ? "Anything not added is in the scan log with the reason." : undefined}>
          <Button variant="primary" onClick={() => onClose(true)}>
            Done
          </Button>
        </DialogFooter>
      </ErpDialog>
    );
  }

  return (
    <ErpDialog onClose={() => !busy && onClose(false)} label="Pick from list" size="lg">
      <DialogHeader onClose={() => !busy && onClose(false)}>
        <DialogTitle>Pick boxes or loose cans for order {board.orderNo}</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <label className="flex flex-col gap-1">
            <span className={fieldLabelClass}>Label no., lot or product</span>
            <Input value={term} onChange={(e) => setTerm(e.target.value)} autoFocus placeholder="e.g. 876" aria-label="Search labels" className="h-9 font-mono" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabelClass}>Product</span>
            <MultiSelect label="Product" options={lineOptions} selected={lineIds} onChange={setLineIds} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabelClass}>Lot</span>
            <MultiSelect label="Lot" options={lotOptions} selected={lots} onChange={setLots} />
          </label>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted">
          {lines.map((l) => (
            <span key={l.id}>
              {l.skuName}: <b className="text-ink tabular-nums">{nf(need(l.id))}</b> more to go on
            </span>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 text-meta">
          <span className="text-muted">
            {nf(shown.length)} of {nf(boxes.length)} labels{shown.length < boxes.length ? " match" : ""}
          </span>
          <span className="flex gap-4">
            <LinkButton onClick={fillNeeded}>Tick what each line needs</LinkButton>
            <LinkButton onClick={() => setPicked(allShown ? picked.filter((id) => !shown.some((b) => b.id === id)) : [...new Set([...picked, ...shown.map((b) => b.id)])])}>{allShown ? "Untick these" : "Tick all shown"}</LinkButton>
          </span>
        </div>

        <div className="overflow-hidden rounded-lg border border-line">
          {shown.length ? (
            shown.slice(0, 400).map((b) => (
              <label key={b.id} className={cx("flex cursor-pointer items-center gap-3 border-b border-divider px-3 py-2 text-meta last:border-0", isPicked.has(b.id) ? "bg-brand-soft" : "hover:bg-canvas")}>
                <input type="checkbox" checked={isPicked.has(b.id)} onChange={() => toggle(b.id)} className={checkboxClass} />
                <span className="w-[150px] flex-none font-mono font-semibold text-ink">{b.id}</span>
                <span className="min-w-0 flex-1 truncate text-body">{b.sku}</span>
                <span className="flex-none font-mono text-muted">{b.lotCode}</span>
                {b.allocated ? <span className="flex-none rounded-full bg-success-soft px-2 text-2xs font-semibold text-success">allocated lot</span> : null}
                {b.madeOn ? <span className="w-[72px] flex-none text-right text-faint">{fd(b.madeOn)}</span> : null}
              </label>
            ))
          ) : (
            <div className="px-3 py-6 text-center text-meta text-muted">Nothing in stock matches. Change the number or the filters.</div>
          )}
          {shown.length > 400 ? <div className="px-3 py-2 text-meta text-muted">The first 400 of {nf(shown.length)} are shown — narrow by lot or label number.</div> : null}
        </div>
      </DialogBody>
      <DialogFooter left={busy ? `Adding ${busy.done + 1} of ${busy.of}…` : pickedPerLine.length ? pickedPerLine.map((x) => `${x.l.skuName} ${x.n}`).join(" · ") : "Each one is checked against the order as it is added, exactly as a scan."}>
        <Button variant="secondary" disabled={!!busy} onClick={() => onClose(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!!busy || !picked.length} onClick={() => void add()}>
          {busy ? "Adding…" : `Add ${nf(picked.length)}`}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
