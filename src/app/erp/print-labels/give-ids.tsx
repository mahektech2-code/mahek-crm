"use client";

import { useState } from "react";
import { erpGiveIds } from "@/lib/actions/erp-trace";
import { Button, Input } from "@/components/ui/primitives";
import { insetClass } from "../_ui/look";
import { useAct } from "../_ui/use-act";

/*
 * STOCK WITH NO ID TO PRINT. The label sheet prints ids, and a batch packed
 * before box ids — or an FG lot nobody has labelled loose — has none, so the
 * sheet was an empty page. It says why now, and offers the step that makes
 * some: the stock row's own action, run through `erpGiveIds`.
 */

type Props =
  | { kind: "batch"; code: string; godownId: string; godown: string; room: number; can: boolean }
  | { kind: "lot"; code: string; godownId: string; godown: string; room: number; can: boolean; finishedGoodId: string; sku: string | null };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function GiveIds(p: Props) {
  const { run, pending } = useAct();
  const [count, setCount] = useState(String(p.room));

  if (p.kind === "batch")
    return (
      <div className={`${insetClass} no-print mb-4 flex flex-wrap items-center justify-between gap-3`}>
        <p className="max-w-[680px] text-meta">
          {plural(p.room, "box", "boxes")} of batch {p.code} at {p.godown} {p.room === 1 ? "carries" : "carry"} no box id: the batch was packed before
          box ids. Give them ids, print the labels and stick one on each box. From then on the dispatch desk scans these boxes one by one and no
          longer takes the batch&apos;s lot QR.
        </p>
        {p.can ? (
          <Button variant="primary" disabled={pending} onClick={() => void run(() => erpGiveIds({ batch: p.code, godownId: p.godownId }))}>
            Give {plural(p.room, "box", "boxes")} ids
          </Button>
        ) : (
          <span className="text-meta text-muted">Whoever works packing or the stock gives them ids.</span>
        )}
      </div>
    );

  const n = Number(count);
  const valid = Number.isInteger(n) && n >= 1 && n <= p.room;
  return (
    <div className={`${insetClass} no-print mb-4 flex flex-wrap items-center justify-between gap-3`}>
      <p className="max-w-[680px] text-meta">
        {plural(p.room, "can", "cans")} of lot {p.code} at {p.godown} {p.room === 1 ? "has" : "have"} no unit id to print.{" "}
        {p.sku
          ? `Give ids only to cans that leave loose, as ${p.sku}: cans that will be boxed get their box's id when the packing batch completes.`
          : "This lot has no loose SKU to sell as; box it instead."}
      </p>
      {!p.sku ? null : p.can ? (
        <form
          className="flex items-center gap-2 text-meta"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void run(() => erpGiveIds({ lot: p.code, finishedGoodId: p.finishedGoodId, godownId: p.godownId, count: n }));
          }}
        >
          <label htmlFor={`count-${p.godownId}`} className="text-muted">
            How many
          </label>
          <Input
            id={`count-${p.godownId}`}
            type="number"
            min={1}
            max={p.room}
            value={count}
            invalid={!valid}
            onChange={(e) => setCount(e.target.value)}
            className="h-9 w-[80px]"
          />
          <Button type="submit" variant="primary" disabled={pending || !valid}>
            Create unit ids
          </Button>
        </form>
      ) : (
        <span className="text-meta text-muted">Whoever works filling or the stock gives them ids.</span>
      )}
    </div>
  );
}
