import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_TIMEZONE } from "@/lib/business-date";
import { publicOrderTracking, type OrderTrackingView } from "@/lib/erp/order-tracking";
import { longDay } from "@/lib/erp/engines/order-tracking";

/**
 * THE CUSTOMER'S ORDER TRACKING PAGE — the link in the order confirmation and
 * every message after it. No sign-in: the token is the key. It shows the order,
 * where it is, what has happened with the time of each step, and the invoice
 * and LR once they exist — never prices on the page, call notes, staff names
 * or an internal hold note, because a WhatsApp link gets forwarded. Sections in
 * the PRD's order: header → hold notice → current status → products →
 * journey → documents.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Track your order · Mahek Marketing India", robots: { index: false, follow: false } };

const WHEN = new Intl.DateTimeFormat("en-IN", { timeZone: APP_TIMEZONE, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const WHEN_SHORT = new Intl.DateTimeFormat("en-IN", { timeZone: APP_TIMEZONE, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
const when = (iso: string | null) => (iso ? WHEN.format(new Date(iso)).replace(/\b(am|pm)\b/, (m) => m.toUpperCase()) : "");
const whenShort = (iso: string | null) => (iso ? WHEN_SHORT.format(new Date(iso)).replace(/\b(am|pm)\b/, (m) => m.toUpperCase()) : "");
const day = (d: string | null) => (d ? longDay(d) : "");
const DAY_SHORT = new Intl.DateTimeFormat("en-IN", { timeZone: APP_TIMEZONE, weekday: "short", day: "numeric", month: "short" });
const dayShort = (iso: string) => DAY_SHORT.format(new Date(iso));

export default async function OrderTrackingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const v = await publicOrderTracking(token);
  if (!v) notFound();
  return <TrackView v={v} />;
}

function TrackView({ v }: { v: OrderTrackingView }) {
  const done = v.status.delivered;
  return (
    <main className="min-h-screen bg-canvas px-4 py-6 sm:py-10">
      <div className="mx-auto grid max-w-[1040px] gap-4 lg:grid-cols-[1.15fr_1fr] lg:items-start lg:gap-5">
        <header className="grid gap-3 lg:col-span-2 lg:flex lg:items-end lg:justify-between">
          <div>
            <div className="text-xs font-semibold tracking-label text-brand uppercase">Mahek Marketing India</div>
            <h1 className="mt-1 text-2xl leading-tight font-semibold text-ink">Track Your Order</h1>
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-1">
            <div>
              <dt className="text-xs text-muted">Order number</dt>
              <dd className="text-base font-medium text-ink tabular-nums">{v.orderNo}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Order date</dt>
              <dd className="text-base font-medium text-ink">{day(v.orderDate)}</dd>
            </div>
          </dl>
        </header>

        <div className="grid gap-4">
          {v.hold && !done ? (
            <section role="status" className="grid gap-1 rounded-card border border-warn-line bg-warn-soft px-4 py-3">
              <h2 className="text-base font-semibold text-warn-ink">{v.hold.title}</h2>
              <p className="text-sm text-ink">{v.hold.text}</p>
              <p className="text-xs text-warn-ink">
                Recorded {when(v.hold.at)}
                {v.hold.revisedOn ? ` · New expected delivery: ${day(v.hold.revisedOn)}` : v.hold.nextUpdateOn ? ` · Next update by ${day(v.hold.nextUpdateOn)}` : ""}
              </p>
            </section>
          ) : null}

          <section className={`grid gap-1.5 rounded-card border px-4 py-3.5 ${done ? "border-success-soft bg-success-soft" : "border-brand-softer bg-brand-soft"}`}>
            <div className="text-xs font-semibold tracking-label text-muted uppercase">Current status</div>
            <div className={`text-xl leading-tight font-semibold ${done ? "text-success" : "text-ink"}`}>{v.status.label}</div>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
              {done ? (
                <>
                  <dt className="text-muted">Delivered on</dt>
                  <dd className="text-ink">{day(v.deliveredOn) || "Confirmed"}</dd>
                  {v.receivedBy ? (
                    <>
                      <dt className="text-muted">Received by</dt>
                      <dd className="text-ink">{v.receivedBy}</dd>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <dt className="text-muted">Last updated</dt>
                  <dd className="text-ink">{when(v.status.lastUpdated) || "—"}</dd>
                  {v.route.length && !v.route.at(-1)!.from ? (
                    <>
                      <dt className="text-muted">Last reported at</dt>
                      <dd className="text-ink">
                        {v.route.at(-1)!.city} · {dayShort(v.route.at(-1)!.at)}
                      </dd>
                    </>
                  ) : null}
                  {v.destination ? (
                    <>
                      <dt className="text-muted">Going to</dt>
                      <dd className="text-ink">{v.destination}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted">{v.pickup ? "Collect by" : "Expected delivery"}</dt>
                  <dd className="text-ink">{v.expectedOn ? day(v.expectedOn) : v.pickup ? "Ready now" : "Not available yet"}</dd>
                </>
              )}
              {v.transporter ? (
                <>
                  <dt className="text-muted">Transporter</dt>
                  <dd className="text-ink">
                    {v.transporter}
                    {v.lrNo ? ` · LR ${v.lrNo}` : ""}
                  </dd>
                </>
              ) : null}
            </dl>
          </section>

          {v.pickup ? (
            <section role="status" className="grid gap-1 rounded-card border border-success-soft bg-success-soft px-4 py-3">
              <h2 className="text-base font-semibold text-success">Ready for you to collect</h2>
              <p className="text-sm text-ink">
                Collect from <span className="font-semibold">{v.pickup.point}</span>
                {v.transporter ? ` (${v.transporter})` : ""}.
              </p>
              {v.pickup.contact ? <p className="text-sm text-ink">Ask for: {v.pickup.contact}</p> : null}
              <p className="text-xs text-body">Please carry the LR number{v.lrNo ? ` — ${v.lrNo}` : ""} — the office asks for it.</p>
            </section>
          ) : null}

          {v.route.length ? (
            <section className="rounded-card border border-line bg-surface px-4 py-3.5">
              <h2 className="mb-2 text-base font-semibold text-ink">On the way</h2>
              <ol className="grid gap-1.5">
                {v.route.map((r, i) => (
                  <li key={`${r.at}${r.city}`} className="grid grid-cols-[16px_1fr_auto] items-baseline gap-2 text-sm">
                    <span aria-hidden className={`mt-1 h-2.5 w-2.5 rounded-full ${i === v.route.length - 1 ? "bg-brand" : "bg-success"}`} />
                    <span className={i === v.route.length - 1 ? "font-semibold text-ink" : "text-body"}>{r.from ? `Dispatched from ${r.city}` : `Reached ${r.city}`}</span>
                    <span className="text-xs text-muted">{dayShort(r.at)}</span>
                  </li>
                ))}
                {v.destination && v.route.at(-1)!.city.toLowerCase() !== v.destination.toLowerCase() && !done ? (
                  <li className="grid grid-cols-[16px_1fr_auto] items-baseline gap-2 text-sm">
                    <span aria-hidden className="mt-1 h-2.5 w-2.5 rounded-full border-2 border-line-strong" />
                    <span className="text-muted">Going to {v.destination}</span>
                    <span />
                  </li>
                ) : null}
              </ol>
            </section>
          ) : null}

          <section className="rounded-card border border-line bg-surface px-4 py-3.5 lg:hidden">
            <Products v={v} />
          </section>

          <section className="rounded-card border border-line bg-surface px-4 py-3.5">
            <h2 className="mb-3 text-base font-semibold text-ink">Order journey</h2>
            <ol className="grid">
              {v.entries.map((e, i) => {
                const last = i === v.entries.length - 1;
                const tone =
                  e.type === "hold"
                    ? "bg-warn text-white"
                    : e.type === "resolved"
                      ? "border-2 border-success bg-surface text-success"
                      : e.state === "done"
                        ? "bg-success text-white"
                        : e.state === "current"
                          ? "bg-brand text-white ring-4 ring-brand-softer"
                          : "border-2 border-line-strong bg-surface";
                const mark = e.type === "hold" ? "!" : e.type === "resolved" || (e.type === "step" && e.state === "done") ? "✓" : e.type === "step" && e.state === "current" ? "●" : "";
                const title = e.type === "hold" ? "text-warn-ink" : e.type === "step" && e.state === "pending" ? "font-medium text-muted" : e.type === "step" && e.state === "current" ? "text-brand-hover" : "text-ink";
                return (
                  <li key={i} className="relative grid grid-cols-[24px_1fr] gap-3 pb-3.5">
                    {!last ? <span aria-hidden className="absolute top-6 bottom-0 left-[11px] w-0.5 bg-divider" /> : null}
                    <span aria-hidden className={`z-1 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${tone}`}>
                      {mark}
                    </span>
                    <div className="min-w-0">
                      <div className={`text-sm leading-snug font-semibold ${title}`}>
                        {e.label}
                        {e.type === "step" && e.state === "current" ? <span className="ml-2 rounded-sm bg-brand px-1.5 py-px align-[1px] text-2xs font-bold text-white">NOW</span> : null}
                        {e.type === "step" && e.state === "pending" ? <span className="sr-only"> — pending</span> : null}
                      </div>
                      {e.words && !(e.type === "step" && e.state === "pending" && !e.optional) ? <div className="text-sm text-body">{e.words}</div> : null}
                      {e.at ? <div className="text-xs text-muted">{whenShort(e.at)}</div> : null}
                    </div>
                  </li>
                );
              })}
              {v.folded ? (
                <li className="grid grid-cols-[24px_1fr] gap-3">
                  <span aria-hidden className="flex h-6 w-6 rounded-full border-2 border-line-strong bg-surface" />
                  <div>
                    <div className="text-sm font-medium text-muted">With the transporter, in transit, delivered</div>
                    <div className="text-xs text-muted">Shown here as they happen</div>
                  </div>
                </li>
              ) : null}
            </ol>
            {v.unreported.length ? <p className="mt-1 text-xs text-muted">The transporter did not report {v.unreported.map((s) => `“${s}”`).join(" or ")}.</p> : null}
          </section>
        </div>

        <div className="grid gap-4">
          <section className="hidden rounded-card border border-line bg-surface px-4 py-3.5 lg:block">
            <Products v={v} />
          </section>
          <section className="rounded-card border border-line bg-surface px-4 py-3.5">
            <h2 className="mb-1 text-base font-semibold text-ink">Documents</h2>
            <Doc token={v.token} kind="invoice" doc={v.documents.invoice} />
            <Doc token={v.token} kind="lr" doc={v.documents.lr} />
          </section>
          <p className="text-center text-xs text-muted">Updates on this page are entered by our team. It does not show the vehicle&apos;s live location. Questions? Reply to our WhatsApp message.</p>
        </div>
      </div>
    </main>
  );
}

function Products({ v }: { v: OrderTrackingView }) {
  return (
    <>
      <h2 className="mb-2 text-base font-semibold text-ink">Order details</h2>
      <table className="w-full text-sm">
        <thead className="sr-only">
          <tr>
            <th>Product</th>
            <th>Quantity</th>
          </tr>
        </thead>
        <tbody>
          {v.products.map((p, i) => (
            <tr key={i} className="border-t border-divider first:border-t-0">
              <td className="py-2 pr-3 align-top">
                <div className="font-medium text-ink">{p.name}</div>
                {p.pack ? <div className="text-xs text-muted">{p.pack}</div> : null}
              </td>
              <td className="py-2 text-right align-top whitespace-nowrap">
                <div className="font-semibold text-ink tabular-nums">
                  {p.qty} {p.unit}
                </div>
                {p.measure ? <div className="text-xs text-muted">{p.measure}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted">Deliver to {v.deliverTo}</p>
    </>
  );
}

function Doc({ token, kind, doc }: { token: string; kind: "invoice" | "lr"; doc: { available: boolean; label: string; detail: string | null } }) {
  return (
    <div className="grid grid-cols-[34px_1fr_auto] items-center gap-3 border-t border-divider py-2.5 first-of-type:border-t-0">
      <span aria-hidden className={`flex h-10 w-[34px] items-center justify-center rounded-sm border text-2xs font-bold ${doc.available ? "border-brand-softer bg-brand-soft text-brand" : "border-line bg-canvas text-muted"}`}>
        {kind === "lr" ? "LR" : "PDF"}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{doc.label}</div>
        <div className="text-xs text-muted">{doc.detail ?? (doc.available ? "" : "Will appear here when available")}</div>
      </div>
      {doc.available ? (
        <a href={`/t/${token}/doc/${kind}`} target="_blank" rel="noreferrer" className="rounded-control border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-ink hover:bg-canvas">
          View
        </a>
      ) : (
        <span />
      )}
    </div>
  );
}
