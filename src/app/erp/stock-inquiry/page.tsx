import Link from "next/link";
import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { calendarDate } from "@/lib/business-date";
import { periodLabel, periodWindow, validPeriod } from "@/lib/erp/period";
import { ADJUST_STAGES, STAGE_LABEL, type AdjustStage } from "@/lib/erp/engines/stock-adjust";
import { inquiryGodowns, inquiryItems, stockInquiry } from "@/lib/erp/stock-inquiry";
import { stockRowActions } from "@/lib/erp/stock-adjust";
import { erpTraceHref } from "@/lib/erp/trace-links";
import { erpLink } from "@/lib/erp/registry";
import { nf } from "@/lib/erp/ui";
import { Card, cx, EmptyState, MetricStrip, Td, Th, Tr } from "@/components/ui/primitives";
import { Page } from "../_ui/page-head";
import { InquiryControls, LotMenu } from "./controls";

/**
 * STOCK INQUIRY — one item of one stage in detail: what is in stock now and
 * where, and every movement in and out over a period with a running balance.
 * Opened from the ⋯ menu on any row of Stock on hand, or here by picking the
 * stage and the item. It is part of the Stock on hand screen: whoever holds
 * that screen holds this.
 */
export const dynamic = "force-dynamic";

const SCREEN_OF: Record<AdjustStage, string> = { rm: "rmStock", sfg: "sfgStock", fg: "fgStock", pack: "packStock" };

export default async function StockInquiryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("stock")) redirect("/erp");
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const stage = (ADJUST_STAGES as readonly string[]).includes(one("stage")) ? (one("stage") as AdjustStage) : "fg";
  const pd = validPeriod(one("pd")) ? one("pd") : "month";
  const godownId = one("godown") || null;
  const itemId = one("item");
  const [items, godowns] = await Promise.all([inquiryItems(stage), inquiryGodowns()]);
  const window = periodWindow(pd, calendarDate(new Date()));
  const inq = itemId ? await stockInquiry({ stage, itemId, godownId, window }) : null;
  /* An item that holds no stock now is still worth looking into; keep it in the picker. */
  const pickItems = inq && !items.some((i) => i.id === inq.itemId) ? [{ id: inq.itemId, name: inq.item }, ...items] : items;
  const u = inq?.unit ?? "";

  return (
    <Page
      title="Stock inquiry"
      sub="One item in detail: where it is now, and every movement in and out."
      actions={
        <Link href={erpLink(SCREEN_OF[stage])} className="text-meta">
          Back to Stock on hand
        </Link>
      }
    >
      <InquiryControls
        stage={stage}
        stages={ADJUST_STAGES.map((s) => ({ k: s, l: STAGE_LABEL[s] }))}
        items={pickItems}
        itemId={itemId}
        godowns={godowns}
        godownId={godownId}
        pd={pd}
        pdLabel={periodLabel(pd)}
      />

      {!itemId ? (
        <Card className="mt-4">
          <EmptyState title="Pick an item" body={`Choose one of the ${nf(items.length)} ${STAGE_LABEL[stage].toLowerCase()} items in stock above, or open one from the ⋯ menu on its row in Stock on hand.`} />
        </Card>
      ) : !inq ? (
        <Card className="mt-4">
          <EmptyState title="That item is not on record" body="It may have been removed. Pick another item above." />
        </Card>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          <div>
            <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">{STAGE_LABEL[stage]}</div>
            <h2 className="mt-0.5 text-xl font-semibold text-ink">{inq.item}</h2>
          </div>
          <MetricStrip
            metrics={[
              { label: "In stock now", value: `${nf(inq.stockNow)} ${u}`, sub: `${nf(inq.lots.length)} ${inq.lots.length === 1 ? "lot" : "lots"}${godownId ? "" : ` · ${nf(new Set(inq.lots.map((l) => l.godown)).size)} godowns`}` },
              { label: `In · ${periodLabel(pd)}`, value: `${nf(inq.totalIn)} ${u}`, tone: "success" },
              { label: `Out · ${periodLabel(pd)}`, value: `${nf(inq.totalOut)} ${u}`, tone: inq.totalOut ? "danger" : "ink" },
              { label: "Adjusted by hand", value: `${inq.adjusted > 0 ? "+" : ""}${nf(inq.adjusted)} ${u}` },
            ]}
          />

          <Card className="overflow-hidden">
            <div className="border-b border-divider px-4 py-3 text-sm font-semibold text-ink">Where it is now</div>
            {inq.lots.length === 0 ? (
              <div className="px-4 py-4 text-meta text-muted">Nothing of this item is in stock{godownId ? " at this godown" : ""}.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Lot</Th>
                      <Th>Godown</Th>
                      <Th>Last entry</Th>
                      <Th align="right">In stock</Th>
                      <Th>
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {inq.lots.map((l) => (
                      <Tr key={`${l.lot}|${l.godownId}`}>
                        <Td>
                          <Link href={erpTraceHref(l.lot)} className="font-mono text-meta">
                            {l.lot}
                          </Link>
                        </Td>
                        <Td>{l.godown}</Td>
                        <Td className="text-muted">{l.since}</Td>
                        <Td align="right" className={cx("tabular-nums", l.stock < 0 && "text-danger")}>
                          {nf(l.stock)} {u}
                        </Td>
                        <Td className="w-[52px] text-right">
                          <LotMenu
                            screen={SCREEN_OF[stage]}
                            rowId={stage === "fg" ? `${inq.itemId}|${l.lot}|${l.godownId}` : `${l.lot}|${l.godownId}`}
                            actions={stockRowActions(ctx, { stage, itemId: inq.itemId, item: inq.item, lot: l.lot, godownId: l.godownId, godown: l.godown, stock: l.stock, unit: u }).filter((a) => a.id === "adjust")}
                          />
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-divider px-4 py-3">
              <span className="text-sm font-semibold text-ink">Movements · {periodLabel(pd)}</span>
              <span className="text-xs text-muted">
                {inq.capped ? `The newest ${nf(inq.movements.length)} are shown; pick a shorter period to see the rest.` : `${nf(inq.movements.length)} movements`}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px]">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>What happened</Th>
                    <Th>Document</Th>
                    <Th>Lot</Th>
                    <Th>Godown</Th>
                    <Th align="right">In</Th>
                    <Th align="right">Out</Th>
                    <Th align="right">Balance</Th>
                  </tr>
                </thead>
                <tbody>
                  {window.from && !inq.capped ? (
                    <Tr>
                      <Td className="text-muted">{window.from}</Td>
                      <Td className="text-muted">Opening balance</Td>
                      <Td />
                      <Td />
                      <Td />
                      <Td />
                      <Td />
                      <Td align="right" className="font-semibold tabular-nums">
                        {nf(inq.opening)}
                      </Td>
                    </Tr>
                  ) : null}
                  {inq.movements.length === 0 ? (
                    <Tr>
                      <Td colSpan={8} className="py-6 text-center text-meta text-muted">
                        Nothing moved in this period.
                      </Td>
                    </Tr>
                  ) : (
                    inq.movements.map((m, i) => (
                      <Tr key={i}>
                        <Td className="whitespace-nowrap">{m.date}</Td>
                        <Td>
                          <span className="block">{m.kind}</span>
                          {m.note || m.by ? <span className="block text-xs text-muted">{[m.note, m.by].filter(Boolean).join(" · ")}</span> : null}
                        </Td>
                        <Td className="font-mono text-meta">{m.doc ?? ""}</Td>
                        <Td className="font-mono text-meta">{m.lot ?? "—"}</Td>
                        <Td>{m.godown}</Td>
                        <Td align="right" className="font-medium text-success tabular-nums">
                          {m.qty > 0 ? `+${nf(m.qty)}` : ""}
                        </Td>
                        <Td align="right" className="font-medium text-danger tabular-nums">
                          {m.qty < 0 ? `−${nf(-m.qty)}` : ""}
                        </Td>
                        <Td align="right" className="tabular-nums">
                          {nf(m.balance)}
                        </Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
}
