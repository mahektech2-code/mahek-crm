import Link from "next/link";
import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { traceCode, traceDashboard, type TraceResult } from "@/lib/erp/traceability";
import { Badge, Card, cx, Dot } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { Page } from "../_ui/page-head";

/**
 * TRACEABILITY — one search box that takes anything a person has in hand: a
 * box id off a label, an SFG / refill / raw-material lot, a packing batch, an
 * order number or a Tally bill number. It answers both ways at once: what the
 * thing was made from, back to the supplier's drum, and everywhere it went,
 * down to the customer and what is still on a shelf.
 *
 * With nothing searched it is the traceability dashboard: today's production
 * and dispatch, and every exception, each opening the records behind it.
 */
export const dynamic = "force-dynamic";

export default async function ErpTrace({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("trace")) redirect("/erp");
  const sp = await searchParams;
  const qv = typeof sp.q === "string" ? sp.q.trim() : "";
  const [result, dash] = await Promise.all([qv ? traceCode(qv) : Promise.resolve(null), qv ? Promise.resolve(null) : traceDashboard()]);

  return (
    <Page title="Traceability" sub="Any box id, lot, batch, order or bill — where it came from, and where it went.">
      <form action="/erp/trace" method="get" className="mb-5 flex max-w-[760px] gap-2">
        <input
          name="q"
          defaultValue={qv}
          autoFocus
          placeholder="Scan or type: BX-261008-000125, an SFG lot, FG12NA, FP40NA, order 1256, a bill number…"
          className="h-10 flex-1 rounded-[4px] border border-line bg-surface px-3 font-mono text-sm text-ink outline-none focus:border-brand"
        />
        <button type="submit" className="h-10 rounded-[4px] bg-brand px-4 text-sm font-medium text-white hover:opacity-90">
          Trace
        </button>
        {qv ? (
          <Link href="/erp/trace" className="flex h-10 items-center px-2 text-sm">
            Dashboard
          </Link>
        ) : null}
      </form>

      {qv && !result ? (
        <Card className="max-w-[760px] px-5 py-4 text-sm text-body">
          Nothing carries <span className="font-mono">{qv}</span>. A box id looks like <span className="font-mono">BX-261008-000125</span>; lots, packing batches, order numbers and Tally bill numbers are matched exactly, ignoring case.
        </Card>
      ) : null}
      {result ? <TraceView r={result} /> : null}
      {dash ? <Dashboard d={dash} /> : null}
    </Page>
  );
}

function Dashboard({ d }: { d: NonNullable<Awaited<ReturnType<typeof traceDashboard>>> }) {
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-2 text-base font-semibold text-ink">Today</h2>
        <CardGrid min={170}>
          {d.today.map((t) => (
            <Link key={t.l} href={t.href ?? "#"} className="no-underline hover:no-underline">
              <Card className="h-full px-4 py-3 hover:border-brand">
                <span className="block text-[12px] text-muted">{t.l}</span>
                <span className="block text-xl font-semibold text-ink tabular-nums">{t.v}</span>
                {t.sub ? <span className="block text-[12px] text-muted">{t.sub}</span> : null}
              </Card>
            </Link>
          ))}
        </CardGrid>
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-ink">Exceptions</h2>
        <CardGrid min={260}>
          {d.exceptions.map((e) => (
            <Link key={e.l} href={e.href} className="no-underline hover:no-underline">
              <Card className={cx("flex h-full items-start gap-3 px-4 py-3 hover:border-brand", !e.n && "opacity-60")}>
                <span className={cx("text-2xl font-semibold tabular-nums", e.n ? (e.tone === "bad" ? "text-danger" : "text-warn-ink") : "text-muted")}>{e.n}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">{e.l}</span>
                  <span className="block text-[12px] text-muted">{e.sub}</span>
                </span>
              </Card>
            </Link>
          ))}
        </CardGrid>
      </section>
      <section id="scans" className="scroll-mt-4">
        <h2 className="mb-2 text-base font-semibold text-ink">Latest scans at the dispatch desk</h2>
        <Card className="overflow-hidden">
          {d.recentScans.length ? (
            d.recentScans.map((s, i) => (
              <div key={i} className="flex items-start gap-3 border-b border-divider px-4 py-2 last:border-0">
                <ScanBadge result={s.result} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">{s.message}</span>
                  <span className="block text-[12px] text-muted">
                    <Link href={`/erp/trace?q=${encodeURIComponent(s.code)}`} className="font-mono">
                      {s.code}
                    </Link>
                    {s.orderNo ? (
                      <>
                        {" "}· <Link href={`/erp/dispatch?order=${s.orderNo}`}>order {s.orderNo}</Link>
                      </>
                    ) : null}
                    {s.by ? ` · ${s.by}` : ""} · {stamp(s.at)}
                  </span>
                </span>
              </div>
            ))
          ) : (
            <div className="px-4 py-3 text-sm text-muted">No scans yet. Scanning happens on the Dispatch desk.</div>
          )}
        </Card>
      </section>
    </div>
  );
}

function ScanBadge({ result }: { result: string }) {
  const map: Record<string, [string, "success" | "danger" | "warn" | "neutral"]> = {
    ok: ["OK", "success"],
    mismatch: ["Mismatch", "danger"],
    duplicate: ["Duplicate", "danger"],
    blocked: ["Blocked", "warn"],
    unknown: ["Unknown", "warn"],
  };
  const [l, t] = map[result] ?? [result, "neutral"];
  return <Badge tone={t}>{l}</Badge>;
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function TraceView({ r }: { r: TraceResult }) {
  return (
    <div className="flex flex-col gap-5">
      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="font-mono text-lg font-semibold text-ink">{r.title}</h2>
          <span className="text-sm text-muted">{r.sub}</span>
        </div>
        {r.facts.length ? (
          <dl className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-6 gap-y-2">
            {r.facts.map((f) => (
              <div key={f.l}>
                <dt className="text-[12px] text-muted">{f.l}</dt>
                <dd className="text-sm text-ink">{f.href ? <Link href={f.href}>{f.v}</Link> : f.v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {r.links.length ? (
          <div className="mt-3 flex flex-wrap gap-3 text-[13px]">
            {r.links.map((l) => (
              <Link key={l.l} href={l.href!}>
                {l.l} →
              </Link>
            ))}
          </div>
        ) : null}
      </Card>

      {r.missing.length ? (
        <div className="rounded-[4px] border border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-4 py-2.5 text-[13px] text-warn-ink">
          {r.missing.map((m) => (
            <div key={m}>{m}</div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink">Backward · what it was made from</h3>
          {r.back.length ? (
            <ol className="flex flex-col gap-3">
              {r.back.map((b, i) => (
                <li key={i}>
                  <Card className="overflow-hidden">
                    <div className="flex items-center gap-2 border-b border-divider bg-canvas px-4 py-2">
                      <Badge tone="brand">{b.stage}</Badge>
                      <span className="truncate font-mono text-[13px] text-ink">{b.title}</span>
                    </div>
                    {b.facts.length ? (
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 py-2">
                        {b.facts.map((f) => (
                          <div key={f.l}>
                            <dt className="text-[11px] text-muted">{f.l}</dt>
                            <dd className="text-[13px] text-ink">{f.v}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {b.rows.map((x, j) => (
                      <div key={j} className="flex items-center gap-2 border-t border-divider px-4 py-1.5 text-[13px]">
                        <Dot tone={x.tone === "warn" ? "warn" : x.tone === "bad" ? "danger" : "neutral"} />
                        {x.href ? <Link href={x.href}>{x.text}</Link> : <span className="text-body">{x.text}</span>}
                      </div>
                    ))}
                  </Card>
                </li>
              ))}
            </ol>
          ) : (
            <Card className="px-4 py-3 text-sm text-muted">Nothing upstream is recorded.</Card>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-ink">Forward · where it went</h3>
          {r.forward.map((f) => (
            <Card key={f.stage} className="overflow-hidden">
              <div className="border-b border-divider bg-canvas px-4 py-2">
                <Badge tone="neutral">{f.stage}</Badge>
              </div>
              {f.rows.map((x, j) => (
                <div key={j} className="border-t border-divider px-4 py-1.5 first:border-0">
                  <span className="block text-[13px] text-ink">{x.href ? <Link href={x.href}>{x.text}</Link> : x.text}</span>
                  {x.sub ? <span className="block text-[12px] text-muted">{x.sub}</span> : null}
                </div>
              ))}
            </Card>
          ))}
          <Card className="overflow-hidden">
            <div className="border-b border-divider bg-canvas px-4 py-2 text-[13px] font-medium text-ink">Customers</div>
            {r.customers.length ? (
              r.customers.map((c, i) => (
                <div key={i} className="flex items-start gap-3 border-t border-divider px-4 py-2 first:border-0">
                  <span className="min-w-0 flex-1">
                    <Link href={c.href} className="block text-sm font-medium">
                      {c.customer}
                    </Link>
                    <span className="block text-[12px] text-muted">
                      Order {c.orderNo}
                      {c.bill ? ` · bill ${c.bill}` : ""} · {c.sku} · lot{c.lots.length > 1 ? "s" : ""} {c.lots.join(", ")}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-sm tabular-nums text-ink">
                      {c.qty} {c.unit}
                    </span>
                    {c.dispatched ? <Badge tone="success">Dispatched {c.dispatched === "yes" ? "" : c.dispatched}</Badge> : <Badge tone="warn">Not dispatched</Badge>}
                  </span>
                </div>
              ))
            ) : (
              <div className="px-4 py-3 text-sm text-muted">{r.kind === "order" || r.kind === "bill" ? "This is the customer end of the chain." : "Nothing from it has been allocated to an order yet."}</div>
            )}
          </Card>
          {r.stock.length ? (
            <Card className="overflow-hidden">
              <div className="border-b border-divider bg-canvas px-4 py-2 text-[13px] font-medium text-ink">Still in stock</div>
              {r.stock.map((s, i) => (
                <div key={i} className="flex justify-between border-t border-divider px-4 py-1.5 text-[13px] first:border-0">
                  <span>
                    <span className="font-mono">{s.lot}</span> · {s.where}
                  </span>
                  <span className="tabular-nums">{s.qty}</span>
                </div>
              ))}
            </Card>
          ) : null}
        </section>
      </div>

      {r.history.length ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink">History</h3>
          <Card className="overflow-hidden">
            {r.history.map((h, i) => (
              <div key={i} className="flex gap-3 border-t border-divider px-4 py-1.5 text-[13px] first:border-0">
                <span className="w-32 flex-none text-muted">{stamp(h.at)}</span>
                <span className="flex-1 text-ink">{h.text}</span>
                <span className="text-muted">{h.by ?? ""}</span>
              </div>
            ))}
          </Card>
        </section>
      ) : null}
    </div>
  );
}
