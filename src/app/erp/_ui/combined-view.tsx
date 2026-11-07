"use client";

import { useEffect, useState } from "react";
import { Button, Callout, Td, Th } from "@/components/ui/primitives";
import { erpCombinedView } from "@/lib/actions/erp";
import { bulkOffers, narrowerOffers } from "@/lib/erp/bulk-fit";
import { statsOf, type StatValue } from "@/lib/erp/list-query";
import { cellText, inr, nf, type ColSpec, type ListRow, type ListSpec } from "@/lib/erp/ui";
import { roundedTotal } from "@/lib/bill-round";
import { StatusBadge } from "./badge";
import { DialogFooter, DialogHeader, DialogTitle, ErpDialog } from "./dialog";
import { useErpUi } from "./erp-ui";
import { labelClass } from "./look";
import { resultError } from "./use-act";

/* ---------------------------------------------------------------------------
 * THE TICKED ROWS, READ TOGETHER, WITH WHAT CAN BE DONE TO THEM AS A SET.
 *
 * Every row is the list's own, read fresh by the screen's loader for exactly
 * these ids (`erpCombinedView`), so the facts, the totals and the actions here
 * are the table's. The actions are the list's bulk actions, judged on the
 * ticked rows' own actions AND on the selection's shape (`bulk-fit.ts`): one
 * PR's lines are offered that PR's work, several PRs only what each line can
 * take alone. A row's single-record work — Edit, Add more — stays on the row.
 * After an act the view reads again, so it always shows what is true now.
 * ------------------------------------------------------------------------- */

type Loaded = { spec: ListSpec; rows: ListRow[] };

function statText(s: StatValue): string {
  if (s.fmt === "m") return inr(s.whole ? roundedTotal(s.v) : s.v);
  const n = nf(Math.round(s.v * 100) / 100);
  return s.u?.trim() ? `${n} ${s.u.trim()}` : n;
}

/** Every different value a column holds across the ticked rows, in the order they first appear. */
function distinct(c: ColSpec, rows: ListRow[]): string[] {
  const seen: string[] = [];
  for (const r of rows) {
    const t = cellText(c, r.v[c.k]);
    if (t !== "—" && !seen.includes(t)) seen.push(t);
  }
  return seen;
}

function Body({ data, ids, screen, reload }: { data: Loaded; ids: string[]; screen: string; reload: () => void }) {
  const ui = useErpUi();
  const { spec, rows } = data;
  const c = spec.combined!;
  const colOf = (k: string) => spec.cols.find((x) => x.k === k);
  /* A column a power withholds is absent from the spec, so it drops out here on its own. */
  const cols = c.cols.map(colOf).filter((x): x is ColSpec => !!x);
  const facts = c.facts.map(colOf).filter((x): x is ColSpec => !!x);
  const stats = statsOf({ ...spec, stats: c.totals }, rows, rows, { chip: "", cf: {}, flag: "" }).filter((s) => !(s.tone && !s.v));
  const perUnit = new Map<string, number>();
  if (c.sumBy && colOf(c.sumBy.k))
    for (const r of rows) {
      const n = Number(r.v[c.sumBy.k]);
      if (!Number.isFinite(n) || r.v[c.sumBy.k] == null || r.v[c.sumBy.k] === "") continue;
      const u = String(r.v[c.sumBy.by] ?? "");
      perUnit.set(u, (perUnit.get(u) ?? 0) + n);
    }
  const bulk = (spec.bulk ?? []).filter((b) => !b.client);
  const offers = bulkOffers(bulk, rows, ids);
  const narrower = narrowerOffers(bulk, rows, ids);
  const word = (k: string) => c.words?.[k] ?? colOf(k)?.l ?? k;
  const missing = ids.length - rows.length;

  const run = (o: (typeof offers)[number]) => {
    if (o.row) {
      const key = o.b.fits || o.b.id;
      const a = o.row.actions?.find((x) => x.id === key);
      if (a) ui.act(screen, a, o.row.id, reload);
      return;
    }
    ui.bulk(screen, o.b, ids, reload);
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas/50 p-4">
        <article className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
          {facts.length ? (
            <dl className="grid gap-x-6 gap-y-2 text-meta sm:grid-cols-2 lg:grid-cols-3">
              {facts.map((f) => {
                const vals = distinct(f, rows);
                return (
                  <div key={f.k} className="min-w-0">
                    <dt className={labelClass}>
                      {f.l}
                      {vals.length > 1 ? <span className="ml-1 font-normal normal-case text-muted">· {vals.length}</span> : null}
                    </dt>
                    <dd className="mt-0.5 break-words text-body">{vals.length ? vals.join(", ") : <span className="text-muted">—</span>}</dd>
                  </div>
                );
              })}
            </dl>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-meta">
              <thead>
                <tr>
                  {cols.map((x) => (
                    <Th key={x.k} align={x.t === "n" || x.t === "m" ? "right" : "left"}>
                      {x.l}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {rows.map((r) => (
                  <tr key={r.id}>
                    {cols.map((x) => {
                      if (x.t === "s") {
                        return (
                          <Td key={x.k}>
                            <StatusBadge value={r.v[x.k]} />
                          </Td>
                        );
                      }
                      const t = cellText(x, r.v[x.k]);
                      const num = x.t === "n" || x.t === "m";
                      return (
                        <Td key={x.k} align={num ? "right" : "left"} className={`${x.t === "mono" || num ? "whitespace-nowrap" : "whitespace-normal"} ${t === "—" ? "text-line-strong" : x.t === "b" ? "font-medium text-ink" : x.t === "mono" ? "font-mono" : ""}`}>
                          {t}
                        </Td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="ml-auto grid w-full max-w-md grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 text-meta tabular-nums">
            {stats.map((s) => (
              <div key={s.l} className="contents">
                <dt className="text-muted">{s.l}</dt>
                <dd className="text-right">
                  <span className={s.tone === "danger" && s.v ? "font-semibold text-danger" : s.tone === "warn" && s.v ? "font-semibold text-warn-ink" : "font-semibold text-ink"}>{statText(s)}</span>
                  {s.missing ? <span className="ml-1 text-xs text-warn-ink">· {nf(s.missing)} {s.missingLabel ?? "with no value"}</span> : null}
                </dd>
              </div>
            ))}
            {perUnit.size ? (
              <div className="contents">
                <dt className="text-muted">{c.sumBy!.l}</dt>
                <dd className="text-right font-semibold text-ink">{[...perUnit].map(([u, n]) => `${nf(Math.round(n * 1000) / 1000)} ${u}`.trim()).join(" · ")}</dd>
              </div>
            ) : null}
          </dl>
          {missing > 0 ? (
            <p className="text-xs text-muted">
              {missing === 1 ? "1 ticked row no longer exists" : `${missing} ticked rows no longer exist`}, so {missing === 1 ? "it is" : "they are"} left out.
            </p>
          ) : null}
        </article>
      </div>
      <DialogFooter
        left={
          narrower.length ? (
            <span className="text-xs text-muted">
              {narrower.map((n) => `${n.l}: tick one ${word(n.same[0])}'s rows`).join(" · ")}
            </span>
          ) : offers.length ? null : (
            <span className="text-xs text-muted">Nothing can be done to these rows together — open one to see why.</span>
          )
        }
      >
        {offers.map((o) => (
          <Button key={o.b.id} variant="secondary" size="sm" onClick={() => run(o)}>
            {o.label}
          </Button>
        ))}
      </DialogFooter>
    </>
  );
}

export function CombinedViewModal({ screen, ids, onClose }: { screen: string; ids: string[]; onClose: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    let live = true;
    void erpCombinedView(screen, ids).then((r) => {
      if (!live) return;
      if (!r.ok) return setFailed(resultError(r));
      setFailed(null);
      setData(r.data);
    });
    return () => {
      live = false;
    };
  }, [screen, ids, n]);

  return (
    <ErpDialog onClose={onClose} label="Combined view" width={1120}>
      <DialogHeader onClose={onClose}>
        <div className="flex flex-wrap items-center gap-2.5">
          <DialogTitle>Combined view</DialogTitle>
          <span className="text-meta text-muted">{ids.length === 1 ? "1 row ticked" : `${nf(ids.length)} rows ticked`}</span>
        </div>
      </DialogHeader>
      {failed ? (
        <div className="p-4">
          <Callout tone="danger">{failed}</Callout>
        </div>
      ) : !data ? (
        <div className="py-16 text-center text-meta text-muted">Reading the selection…</div>
      ) : (
        <Body data={data} ids={ids} screen={screen} reload={() => setN((x) => x + 1)} />
      )}
    </ErpDialog>
  );
}
