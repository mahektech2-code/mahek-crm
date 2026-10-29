import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { consignmentLinkRetired, orderLinkForConsignment } from "@/lib/erp/order-tracking";
import { publicTracking } from "@/lib/erp/logistics";
import { shortDay, STAGES, STAGE_SHORT, stageStep } from "@/lib/erp/engines/logistics";

/**
 * THE CUSTOMER'S TRACKING PAGE — the link in every logistics WhatsApp. No sign
 * in: the token is the key, twenty random characters per bill. It shows the
 * bill, the LR and where the goods are, and nothing internal — no prices, no
 * call notes, no staff names — because a WhatsApp link gets forwarded.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Track your consignment · Mahek Marketing India", robots: { index: false, follow: false } };

const STEP_WORD: Record<string, string> = {
  Dispatched: "Left our factory",
  "At transport": "With the transporter",
  "In Transit": "In transit",
  "On the way to Destination area": "Near your area",
  "Reached Destination Area": "In your area",
  "Out for Delivery": "Out for delivery",
  "Ready for Pickup": "Ready for you to collect",
  "Close - Received to Party": "Delivered",
};
const EVENT_WORD: Record<string, string> = {
  opened: "Dispatched from our factory",
  at_transport: "Handed over to the transporter",
  lr: "Booked — LR issued",
  stage: "Status updated",
  dispatched: "Dispatched from the transporter's godown",
  checkpoint: "Reached a city on the way",
  issue: "Delay reported — we are following up",
  delivered: "Delivered",
};

export default async function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  /* A link sent before order tracking now opens the order's page — unless the
     order's link was made anew, which retires every older link with it. */
  const order = await orderLinkForConsignment(token);
  if (order) redirect(`/t/${order}`);
  if (await consignmentLinkRetired(token)) notFound();
  const t = await publicTracking(token);
  if (!t) notFound();
  const at = stageStep(t.stage);
  const done = t.stage === "Close - Received to Party";
  return (
    <main className="min-h-screen bg-canvas px-4 py-8">
      <div className="mx-auto max-w-[560px] space-y-4">
        <div className="text-[13px] font-semibold tracking-[0.06em] text-brand uppercase">Mahek Marketing India</div>
        <div className="rounded-[8px] border border-line bg-surface p-5">
          <div className="text-[13px] text-muted">Consignment for</div>
          <h1 className="text-[22px] leading-7 font-semibold text-ink">{t.party}</h1>
          <div className="mt-1 text-sm text-body">
            {t.bills.length === 1 ? "Bill" : "Bills"} {t.bills.map((b) => b.billNo ?? `order ${b.orderNo}`).join(", ")}
          </div>
          <div className={`mt-4 rounded-[6px] px-4 py-3 ${done ? "bg-success-soft" : t.issue ? "bg-warn-soft" : "bg-brand-soft"}`}>
            <div className="text-[12px] font-medium text-muted uppercase">Now</div>
            <div className={`text-[20px] font-semibold ${done ? "text-success" : "text-ink"}`}>{STEP_WORD[STAGES[at]] ?? STAGE_SHORT[STAGES[at]]}</div>
            {done && t.deliveredOn ? <div className="text-sm text-body">on {shortDay(t.deliveredOn)}{t.receivedBy ? `, received by ${t.receivedBy}` : ""}</div> : null}
            {!done && t.expectedOn ? <div className="text-sm text-body">Expected delivery {shortDay(t.expectedOn)}</div> : null}
            {!done && t.issue ? <div className="text-sm text-warn-ink">There is a delay; we are following it up with the transporter.</div> : null}
          </div>
          <ol className="mt-5 space-y-0">
            {STAGES.map((s, i) => (
              <li key={s} className="flex items-center gap-3 py-1.5">
                <span className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-[12px] font-semibold ${i < at || done ? "bg-success text-white" : i === at ? "bg-brand text-white" : "bg-divider text-muted"}`}>{i < at || done ? "✓" : i + 1}</span>
                <span className={`text-sm ${i <= at ? "font-medium text-ink" : "text-muted"}`}>{STEP_WORD[s]}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="grid grid-cols-2 gap-3 rounded-[8px] border border-line bg-surface p-5 text-sm">
          <div>
            <div className="text-[12px] text-muted">Transporter</div>
            <div className="font-medium text-ink">{t.transporter ?? "—"}</div>
          </div>
          <div>
            <div className="text-[12px] text-muted">LR number</div>
            <div className="font-mono font-medium text-ink">{t.lrNo ?? "Not issued yet"}</div>
          </div>
          <div>
            <div className="text-[12px] text-muted">LR date</div>
            <div className="text-ink">{t.lrDate ? shortDay(t.lrDate) : "—"}</div>
          </div>
          <div>
            <div className="text-[12px] text-muted">Boxes</div>
            <div className="text-ink">{t.packages ?? "—"}</div>
          </div>
          {t.transporterTrackUrl ? (
            <a href={t.transporterTrackUrl} target="_blank" rel="noreferrer" className="col-span-2 text-sm">
              Track it on {t.transporter}&apos;s website ↗
            </a>
          ) : null}
        </div>

        {t.events.length ? (
          <div className="rounded-[8px] border border-line bg-surface p-5">
            <div className="mb-2 text-[15px] font-semibold text-ink">History</div>
            <ol className="space-y-2">
              {t.events.map((e, i) => (
                <li key={i} className="text-sm">
                  <div className="text-ink">{e.kind === "stage" && e.stage ? STEP_WORD[e.stage] ?? e.stage : (EVENT_WORD[e.kind] ?? "Updated")}</div>
                  {e.note ? <div className="text-[13px] text-body">{e.note}</div> : null}
                  <div className="text-[12px] text-muted">{new Date(e.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</div>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        <p className="text-center text-[12px] text-muted">Questions about this delivery? Reply to our WhatsApp message.</p>
      </div>
    </main>
  );
}
