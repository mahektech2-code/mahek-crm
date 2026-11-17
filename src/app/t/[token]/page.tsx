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
  /* The one sentence at the top: where it is, and what we are waiting for if anything. */
  const lead = v.hold && !done ? v.hold.title : v.status.label;
  const more =
    v.hold && !done
      ? `${v.hold.text}${v.hold.revisedOn ? ` New expected delivery: ${day(v.hold.revisedOn)}.` : v.hold.nextUpdateOn ? ` Next update by ${day(v.hold.nextUpdateOn)}.` : ""}`
      : done
        ? `Delivered${v.deliveredOn ? ` on ${day(v.deliveredOn)}` : ""}${v.receivedBy ? `, received by ${v.receivedBy}` : ""}.`
        : v.expectedOn
          ? `Expected ${v.pickup ? "ready to collect" : "delivery"} ${day(v.expectedOn)}.`
          : "";
  return (
    <main className="min-h-screen bg-canvas">
      <header className="bg-ink px-5 pt-6 pb-5 text-white">
        <div className="mx-auto max-w-[560px]">
          <div className="text-xs text-white/70">Mahek Marketing India</div>
          <h1 className="mt-1 text-2xl leading-tight font-semibold tabular-nums">Order {v.orderNo}</h1>
          <div className="mt-1 text-sm text-white/80">
            {v.billingParty} · placed {day(v.orderDate)}
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[560px] gap-3 px-4 py-4">
        <section role="status" className={`rounded-card px-4 py-3 text-sm ${done ? "bg-success-soft text-success" : v.hold ? "bg-warn-soft text-warn-ink" : "bg-warn-soft text-warn-ink"}`}>
          <span className="font-semibold">{lead}.</span>
          {more ? <span className="text-ink"> {more}</span> : null}
        </section>

        <section className="rounded-card border border-line bg-surface px-4 py-3">
          <ol className="grid">
            {v.entries.map((e, i) => {
              const dot =
                e.type === "hold"
                  ? "bg-danger"
                  : e.type === "resolved"
                    ? "bg-success"
                    : e.state === "done"
                      ? "bg-success"
                      : e.state === "current"
                        ? "bg-warn"
                        : "bg-line";
              const strong = e.type === "hold" || (e.type === "step" && e.state === "current");
              const pending = e.type === "step" && e.state === "pending";
              return (
                <li key={i} className="grid grid-cols-[14px_1fr] gap-3 py-2">
                  <span aria-hidden className={`mt-1 h-3 w-3 rounded-full ${dot}`} />
                  <div className="min-w-0">
                    <div className={`text-sm leading-snug ${pending ? "text-muted" : "text-ink"} ${strong ? "font-semibold" : ""}`}>
                      {e.label}
                      {pending ? <span className="sr-only"> — pending</span> : null}
                    </div>
                    {e.words && !(pending && !e.optional) ? <div className="text-xs text-body">{e.words}</div> : null}
                    {e.at ? <div className="text-xs text-muted">{whenShort(e.at)}</div> : null}
                  </div>
                </li>
              );
            })}
            {v.folded ? (
              <li className="grid grid-cols-[14px_1fr] gap-3 py-2">
                <span aria-hidden className="mt-1 h-3 w-3 rounded-full bg-line" />
                <div className="text-sm text-muted">Dispatched, delivered</div>
              </li>
            ) : null}
          </ol>
          {v.unreported.length ? <p className="mt-1 text-xs text-muted">The transporter did not report {v.unreported.map((s) => `“${s}”`).join(" or ")}.</p> : null}
        </section>

        <section className="rounded-card border border-line bg-surface px-4 py-3">
          <Products v={v} />
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
          <section className="rounded-card border border-line bg-surface px-4 py-3">
            <h2 className="mb-2 text-sm font-semibold text-ink">
              On the way{v.transporter ? ` · ${v.transporter}` : ""}
              {v.lrNo ? ` · LR ${v.lrNo}` : ""}
            </h2>
            <ol className="grid gap-1.5">
              {v.route.map((r, i) => (
                <li key={`${r.at}${r.city}`} className="grid grid-cols-[14px_1fr_auto] items-baseline gap-2 text-sm">
                  <span aria-hidden className={`mt-1 h-2.5 w-2.5 rounded-full ${i === v.route.length - 1 ? "bg-brand" : "bg-success"}`} />
                  <span className={i === v.route.length - 1 ? "font-semibold text-ink" : "text-body"}>{r.from ? `Dispatched from ${r.city}` : `Reached ${r.city}`}</span>
                  <span className="text-xs text-muted">{dayShort(r.at)}</span>
                </li>
              ))}
              {v.destination && v.route.at(-1)!.city.toLowerCase() !== v.destination.toLowerCase() && !done ? (
                <li className="grid grid-cols-[14px_1fr_auto] items-baseline gap-2 text-sm">
                  <span aria-hidden className="mt-1 h-2.5 w-2.5 rounded-full border-2 border-line-strong" />
                  <span className="text-muted">Going to {v.destination}</span>
                  <span />
                </li>
              ) : null}
            </ol>
            <p className="mt-2 text-xs text-muted">Last updated {when(v.status.lastUpdated) || "—"}</p>
          </section>
        ) : null}

        {v.documents.invoice.available || v.documents.lr.available ? (
          <section className="rounded-card border border-line bg-surface px-4 py-3">
            <h2 className="mb-1 text-sm font-semibold text-ink">Documents</h2>
            <Doc token={v.token} kind="invoice" doc={v.documents.invoice} />
            <Doc token={v.token} kind="lr" doc={v.documents.lr} />
          </section>
        ) : null}

        <p className="text-xs text-muted">Updates on this page are entered by our team. It does not show the vehicle&apos;s live location. Questions? Reply to our WhatsApp message.</p>
      </div>
    </main>
  );
}

function Products({ v }: { v: OrderTrackingView }) {
  return (
    <>
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
                <div className="text-ink">{p.name}</div>
              </td>
              <td className="py-2 text-right align-top whitespace-nowrap">
                <div className="text-ink tabular-nums">
                  {p.qty} {p.unit}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted">Delivering to {v.deliverTo}</p>
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
