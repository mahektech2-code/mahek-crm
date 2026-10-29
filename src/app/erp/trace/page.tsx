import { NavLink } from "@/components/shell/nav-link";
import { stamp } from "@/lib/format";
import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpHref, erpScreen } from "@/lib/erp/registry";
import { traceCode, traceDashboard, type TraceResult } from "@/lib/erp/traceability";
import { Callout, Card, cx, Dot } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { Page, QuickFind } from "../_ui/page-head";
import { Badge } from "../_ui/badge";
import { Eyebrow, eyebrowClass, labelClass, linkClass, SectionTitle, SubTitle } from "../_ui/look";
import { erpDispatchHref, erpTraceHref } from "@/lib/erp/trace-links";

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

/* The title and the line under it are the registry's, as on every list. */
const SCREEN = erpScreen("trace")!;

export default async function ErpTrace({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("trace")) redirect("/erp");
  const sp = await searchParams;
  const qv = typeof sp.q === "string" ? sp.q.trim() : "";
  const [result, dash] = await Promise.all([qv ? traceCode(qv) : Promise.resolve(null), qv ? Promise.resolve(null) : traceDashboard()]);

  return (
    <Page title={SCREEN.label}>
      <QuickFind action={erpHref(SCREEN)} name="q" defaultValue={qv} mono button="Trace" className="max-w-[760px]" placeholder="Scan or type: BX-261008-000125, an SFG lot, FG12NA, FP40NA, order 1256, a bill number…">
        {qv ? (
          <NavLink href={erpHref(SCREEN)} className={linkClass("muted", "flex h-9 items-center px-2 text-sm")}>
            Clear
          </NavLink>
        ) : null}
      </QuickFind>

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
    <div className="flex flex-col gap-5">
      <section>
        <SectionTitle>Today</SectionTitle>
        <CardGrid min={170}>
          {d.today.map((t) => (
            <NavLink key={t.l} href={t.href ?? "#"} className="no-underline hover:no-underline">
              <Card className="h-full px-4 py-3 hover:border-brand">
                <Eyebrow>{t.l}</Eyebrow>
                <span className="block text-xl leading-7 font-semibold text-ink tabular-nums">{t.v}</span>
                {t.sub ? <span className="block text-xs text-muted">{t.sub}</span> : null}
              </Card>
            </NavLink>
          ))}
        </CardGrid>
      </section>
      <section>
        <SectionTitle>Exceptions</SectionTitle>
        <CardGrid min={260}>
          {d.exceptions.map((e) => (
            <NavLink key={e.l} href={e.href} className="no-underline hover:no-underline">
              <Card className={cx("flex h-full items-start gap-3 px-4 py-3 hover:border-brand", !e.n && "opacity-60")}>
                <span className={cx("text-xl leading-7 font-semibold tabular-nums", e.n ? (e.tone === "bad" ? "text-danger" : "text-warn-ink") : "text-muted")}>{e.n}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">{e.l}</span>
                  <span className="block text-meta text-muted">{e.sub}</span>
                </span>
              </Card>
            </NavLink>
          ))}
        </CardGrid>
      </section>
      <section id="scans" className="scroll-mt-4">
        <SectionTitle>Latest scans at the dispatch desk</SectionTitle>
        <Card className="overflow-hidden">
          {d.recentScans.length ? (
            d.recentScans.map((s, i) => (
              <div key={i} className="flex items-start gap-3 border-b border-divider px-4 py-2 last:border-0">
                <ScanBadge result={s.result} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">{s.message}</span>
                  <span className="block text-meta text-muted">
                    <NavLink href={erpTraceHref(s.code)} className={linkClass("brand", "font-mono")}>
                      {s.code}
                    </NavLink>
                    {s.orderNo ? (
                      <>
                        {" "}· <NavLink href={erpDispatchHref(s.orderNo)} className={linkClass()}>order {s.orderNo}</NavLink>
                      </>
                    ) : null}
                    {s.by ? ` · ${s.by}` : ""} · {stamp(s.at)}
                  </span>
                </span>
              </div>
            ))
          ) : (
            <div className="px-4 py-3 text-meta text-muted">No scans yet. Scanning happens on the Dispatch desk.</div>
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
  return <Badge label={l} tone={t} />;
}

/** v4: the whole chain on one line — where it came from, it, where it went. */
function Chain({ r }: { r: TraceResult }) {
  type Link = { stage: string; title: string; sub?: string; href?: string; me?: boolean };
  const links: Link[] = [
    ...[...r.back].reverse().map((b) => ({ stage: b.stage, title: b.title, sub: b.facts[0] ? `${b.facts[0].v}` : b.rows[0]?.text })),
    { stage: r.kind, title: r.title, sub: r.sub, me: true },
    ...r.forward.map((f) => ({ stage: f.stage, title: f.rows[0]?.text ?? "", sub: f.rows[0]?.sub, href: f.rows[0]?.href })),
    ...r.customers.slice(0, 1).map((c) => ({ stage: "Order", title: `${c.orderNo}${c.bill ? ` · ${c.bill}` : ""}`, sub: c.customer, href: c.href })),
  ].filter((l) => l.title);
  if (links.length < 2) return null;
  return (
    <ol className="flex items-stretch gap-0 overflow-x-auto pb-1">
      {links.map((l, i) => (
        <li key={`${l.stage}:${i}`} className="flex flex-none items-stretch">
          {i > 0 ? (
            <span aria-hidden className="flex w-6 items-center justify-center text-line-strong">
              ›
            </span>
          ) : null}
          <div
            className={cx(
              "flex w-[184px] flex-col gap-1 rounded-[10px] border bg-surface px-3.5 py-3",
              l.me ? "border-brand ring-3 ring-brand-soft" : "border-line",
            )}
          >
            <span className={cx(eyebrowClass, l.me ? "text-brand" : "text-faint")}>{l.stage}</span>
            {l.href ? (
              <NavLink href={l.href} className={linkClass("brand", "truncate font-mono text-sm font-semibold")}>
                {l.title}
              </NavLink>
            ) : (
              <span className="truncate font-mono text-sm font-semibold text-ink">{l.title}</span>
            )}
            {l.sub ? <span className="line-clamp-2 text-xs text-muted">{l.sub}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function TraceView({ r }: { r: TraceResult }) {
  return (
    <div className="flex flex-col gap-5">
      <Chain r={r} />
      <Card className="px-5 py-4">
        <SectionTitle className="mb-0 font-mono">{r.title}</SectionTitle>
        <div className="mt-0.5 text-meta text-muted">{r.sub}</div>
        {r.facts.length ? (
          <dl className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-6 gap-y-2">
            {r.facts.map((f) => (
              <div key={f.l}>
                <dt className={labelClass}>{f.l}</dt>
                <dd className="text-sm text-ink">{f.href ? <NavLink href={f.href} className={linkClass()}>{f.v}</NavLink> : f.v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {r.links.length ? (
          <div className="mt-3 flex flex-wrap gap-3 text-meta">
            {r.links.map((l) => (
              <NavLink key={l.l} href={l.href!} className={linkClass()}>
                {l.l} →
              </NavLink>
            ))}
          </div>
        ) : null}
      </Card>

      {r.missing.length ? (
        <Callout className="mb-0 block text-meta text-warn-ink">
          {r.missing.map((m) => (
            <div key={m}>{m}</div>
          ))}
        </Callout>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <section>
          <SubTitle>Backward · what it was made from</SubTitle>
          {r.back.length ? (
            <ol className="flex flex-col gap-3">
              {r.back.map((b, i) => (
                <li key={i}>
                  <Card className="overflow-hidden">
                    <div className="flex items-center gap-2 border-b border-divider bg-canvas px-4 py-2">
                      <Badge label={b.stage} tone="brand" />
                      <span className="truncate font-mono text-meta text-ink">{b.title}</span>
                    </div>
                    {b.facts.length ? (
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 py-2">
                        {b.facts.map((f) => (
                          <div key={f.l}>
                            <dt className={eyebrowClass}>{f.l}</dt>
                            <dd className="text-meta text-ink">{f.v}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {b.rows.map((x, j) => (
                      <div key={j} className="flex items-center gap-2 border-t border-divider px-4 py-1.5 text-meta">
                        <Dot tone={x.tone === "warn" ? "warn" : x.tone === "bad" ? "danger" : "neutral"} />
                        {x.href ? <NavLink href={x.href} className={linkClass()}>{x.text}</NavLink> : <span className="text-body">{x.text}</span>}
                      </div>
                    ))}
                  </Card>
                </li>
              ))}
            </ol>
          ) : (
            <div className="rounded-card border border-dashed border-line px-3 py-4 text-center text-meta text-muted">Nothing upstream is recorded.</div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <SubTitle className="mb-0">Forward · where it went</SubTitle>
          {r.forward.map((f) => (
            <Card key={f.stage} className="overflow-hidden">
              <div className="border-b border-divider bg-canvas px-4 py-2">
                <Badge label={f.stage} tone="neutral" />
              </div>
              {f.rows.map((x, j) => (
                <div key={j} className="border-t border-divider px-4 py-1.5 first:border-0">
                  <span className="block text-meta text-ink">{x.href ? <NavLink href={x.href} className={linkClass()}>{x.text}</NavLink> : x.text}</span>
                  {x.sub ? <span className="block text-meta text-muted">{x.sub}</span> : null}
                </div>
              ))}
            </Card>
          ))}
          <Card className="overflow-hidden">
            <SubTitle className="mb-0 border-b border-divider bg-canvas px-4 py-2">Customers</SubTitle>
            {r.customers.length ? (
              r.customers.map((c, i) => (
                <div key={i} className="flex items-start gap-3 border-t border-divider px-4 py-2 first:border-0">
                  <span className="min-w-0 flex-1">
                    <NavLink href={c.href} className={linkClass("brand", "block text-sm")}>
                      {c.customer}
                    </NavLink>
                    <span className="block text-meta text-muted">
                      Order {c.orderNo}
                      {c.bill ? ` · bill ${c.bill}` : ""} · {c.sku} · lot{c.lots.length > 1 ? "s" : ""} {c.lots.join(", ")}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-sm tabular-nums text-ink">
                      {c.qty} {c.unit}
                    </span>
                    {c.dispatched ? <Badge label={`Dispatched${c.dispatched === "yes" ? "" : ` ${c.dispatched}`}`} tone="success" /> : <Badge label="Not dispatched" tone="warn" />}
                  </span>
                </div>
              ))
            ) : (
              <div className="px-4 py-3 text-meta text-muted">{r.kind === "order" || r.kind === "bill" ? "This is the customer end of the chain." : "Nothing from it has been allocated to an order yet."}</div>
            )}
          </Card>
          {r.stock.length ? (
            <Card className="overflow-hidden">
              <SubTitle className="mb-0 border-b border-divider bg-canvas px-4 py-2">Still in stock</SubTitle>
              {r.stock.map((s, i) => (
                <div key={i} className="flex justify-between border-t border-divider px-4 py-1.5 text-meta first:border-0">
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
          <Card className="overflow-hidden rounded-[10px]">
            <SubTitle className="mb-0 border-b border-divider px-4.5 py-3.5">Movements</SubTitle>
            {r.history.map((h, i) => (
              <div key={i} className="flex items-center gap-3.5 border-t border-divider px-4.5 py-2.5 text-meta first:border-0">
                <span className="w-32 flex-none text-faint">{stamp(h.at)}</span>
                <span aria-hidden className="h-[7px] w-[7px] flex-none rounded-full bg-brand" />
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
