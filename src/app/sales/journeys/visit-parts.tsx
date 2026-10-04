"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { money } from "@/lib/format";
import { APP_TIMEZONE } from "@/lib/business-date";
import { useToast } from "@/components/ui/toast";
import { acceptVisit, askAboutVisit, decidePinCorrection } from "@/lib/actions/sales";
import type { VisitRow } from "@/lib/services/sales-service";
import { Pill, ReasonModal, type RowMenuItem } from "@/components/console/parts";
import { VISIT_OUTCOME_LABEL, label } from "@/components/console/words";

/* ---------------------------------------------------------------------------
 * ONE VISIT, DRAWN THE SAME WHEREVER IT IS READ.
 *
 * A visit is read in two places on Journeys & visits: the day's log on the
 * Visits tab, and inside a salesman's day, under the stop it answered or in
 * the off-plan list beside the route. Both draw the verdict, both open the
 * notes, photographs and voice note, and both let a manager stand behind it,
 * ask about it or answer a pin he questioned. One copy, so the two cannot
 * come to say different things about one visit.
 * ------------------------------------------------------------------------- */

/** The verdict on a visit: verified or not, off plan, a questioned pin, his words. */
export function VisitState({ v }: { v: VisitRow }) {
  return (
    <>
      {v.verified ? (
        <Pill tone="success">{v.acceptedAt ? "Accepted" : "Verified"}</Pill>
      ) : (
        <Pill tone="warn">{v.locationMismatch ? "Wrong place" : "Unverified"}</Pill>
      )}
      {!v.wasPlanned ? (
        <span className="ml-1.5">
          <Pill>Off plan</Pill>
        </span>
      ) : null}
      {/*
        A REQUEST IS A THING TO DO, so it is drawn as one rather than
        folded into the sentence underneath. "He says the shop is
        somewhere else" is the row a manager should be able to find
        by eye on a day of forty visits — the reason he gave is on
        the line below, and the two are different facts.
      */}
      {v.pinCorrection ? (
        <span
          className="ml-1.5"
          /* Truthiness only, never formatted — `visitsList` runs
             raw SQL through `db.execute`, which hands back a STRING
             where the type says Date, and `acceptedAt` beside it is
             read the same way for the same reason. */
          title={
            v.pinCorrectionDecidedAt
              ? "Somebody has answered this."
              : "Waiting for somebody to answer this."
          }
        >
          <Pill tone={v.pinCorrection === "requested" ? "warn" : "neutral"}>
            {v.pinCorrection === "requested"
              ? "Pin questioned"
              : v.pinCorrection === "accepted"
                ? "Pin moved"
                : "Pin kept"}
          </Pill>
        </span>
      ) : null}
      {v.unverifiedReason || v.deviationReason ? (
        <span className="block truncate text-[12px] text-muted">
          {v.unverifiedReason ?? v.deviationReason}
        </span>
      ) : null}
      {/*
        HIS OWN WORDS, IN FULL AND NOT TRUNCATED.

        The server folds this into `unverifiedReason` above, which is
        right — that is the column every other screen and any export
        reads. But that sentence leads with the distance and truncates
        at the column width, so the half that gets cut is the half a
        manager is actually deciding on: a salesman refused at a shop
        door typed this standing in front of the shopkeeper, and it is
        the only account anybody has of why the book and the man
        disagree. It gets its own line and wraps.
      */}
      {v.checkInOverrideReason ? (
        <span className="mt-0.5 block text-[12px] text-body italic">
          &ldquo;{v.checkInOverrideReason}&rdquo;
        </span>
      ) : null}
      {v.checkInLat != null || v.checkOutLat != null ? (
        <span className="mt-0.5 flex gap-2.5 text-[12px]">
          {v.checkInLat != null && v.checkInLng != null ? (
            <a
              href={`https://www.google.com/maps?q=${v.checkInLat},${v.checkInLng}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-brand no-underline"
              title={
                v.checkInAccuracyM != null
                  ? `Accurate to about ${v.checkInAccuracyM} m`
                  : "Accuracy was not reported"
              }
            >
              Check-in ↗
            </a>
          ) : null}
          {v.checkOutLat != null && v.checkOutLng != null ? (
            <a
              href={`https://www.google.com/maps?q=${v.checkOutLat},${v.checkOutLng}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-brand no-underline"
              title={
                v.checkOutAccuracyM != null
                  ? `Accurate to about ${v.checkOutAccuracyM} m`
                  : "Accuracy was not reported"
              }
            >
              Check-out ↗
            </a>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

/**
 * Standing behind a visit, asking about it, answering a questioned pin.
 *
 * A hook rather than a component because the menu items go into whichever
 * `RowMenu` the screen already draws, and the question needs a modal that
 * outlives the menu closing.
 */
export function useVisitActions() {
  const router = useRouter();
  const toast = useToast();
  const [asking, setAsking] = React.useState<VisitRow | null>(null);
  const [question, setQuestion] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function accept(v: VisitRow) {
    const result = await acceptVisit({ visitId: v.id });
    if (!result.ok) return toast.push(result.error);
    toast.push(result.message ?? "Accepted.");
    router.refresh();
  }

  /**
   * He said the shop is not where the book has it. No coordinates are sent:
   * what is accepted is the check-in fix already on the row. It does not
   * touch `verified` — standing behind the visit is the item above.
   */
  async function decidePin(v: VisitRow, yes: boolean) {
    const result = await decidePinCorrection({ visitId: v.id, accept: yes });
    if (!result.ok) return toast.push(result.error);
    toast.push(result.message ?? "Done.");
    router.refresh();
  }

  async function submitAsk() {
    if (!asking) return;
    setBusy(true);
    setError(null);
    try {
      const result = await askAboutVisit({ visitId: asking.id, question });
      if (!result.ok) return setError(result.error);
      setAsking(null);
      toast.push(result.message ?? "Asked.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const items = (v: VisitRow): RowMenuItem[] => [
    {
      label: "Accept it anyway",
      run: () => void accept(v),
      disabled: v.verified,
      title: v.verified ? "Already verified." : undefined,
    },
    {
      label: "Ask them to explain",
      run: () => {
        setAsking(v);
        setQuestion("");
        setError(null);
      },
    },
    /* Only where somebody asked. Offered on every row it would be a way to
       move a shop's pin from a table of visits, which nobody at the shop had
       asked for. */
    ...(v.pinCorrection === "requested"
      ? [
          {
            label: "Move the shop's pin here",
            run: () => void decidePin(v, true),
            disabled: v.checkInLat == null,
            title:
              v.checkInLat == null ? "That check-in carried no location to move it to." : undefined,
          },
          { label: "Leave the pin as it is", run: () => void decidePin(v, false) },
        ]
      : []),
  ];

  const modal = (
    <ReasonModal
      open={Boolean(asking)}
      onClose={() => setAsking(null)}
      title="Ask about this visit"
      subject={asking?.customerName}
      subjectDetail={
        asking ? `${asking.salesmanName} · ${label(VISIT_OUTCOME_LABEL, asking.outcome)}` : undefined
      }
      fieldLabel="What do you want to ask · required"
      reason={question}
      onReasonChange={setQuestion}
      confirmLabel="Send it"
      danger={false}
      busy={busy}
      error={error}
      onConfirm={() => void submitAsk()}
    />
  );

  return { items, modal };
}

/**
 * EVERYTHING THE HANDSET BROUGHT BACK FROM ONE SHOP.
 *
 * The row above is the verdict — where, how long, verified or not. This is the
 * visit itself: what the salesman wrote or said, the two photographs, the voice
 * note, what he learned about the competition and what else the visit
 * produced. None of it was on this screen before; the photographs were a
 * number in a column and the competitor notes were on no screen at all.
 */
export function VisitDetail({ v }: { v: VisitRow }) {
  const words = v.notes?.trim() || null;
  const heard = v.transcript?.trim() || null;
  const produced = [
    Number(v.orderValuePaise) ? `an order of ${money(v.orderValuePaise)}` : null,
    v.tookPayment ? "a payment" : null,
    v.raisedComplaint ? "a complaint" : null,
    v.gaveSample ? "a sample" : null,
  ].filter(Boolean);

  return (
    <div className="grid gap-4 text-[13px] text-body md:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-3">
        <section>
          <h4 className="text-[12px] font-medium uppercase tracking-wide text-muted">Notes</h4>
          {words ? (
            <p className="mt-1 whitespace-pre-wrap">{words}</p>
          ) : (
            <p className="mt-1 text-muted">He wrote nothing on this visit.</p>
          )}
          {heard && heard !== words ? (
            <p className="mt-2 whitespace-pre-wrap text-muted">
              <span className="font-medium text-body">
                {v.transcriptIsAi ? "Voice note, as transcribed: " : "Voice note: "}
              </span>
              {heard}
            </p>
          ) : null}
        </section>

        {v.voiceNoteId ? (
          <section>
            <h4 className="text-[12px] font-medium uppercase tracking-wide text-muted">Voice note</h4>
            <audio controls preload="none" src={`/api/attachments/${v.voiceNoteId}`} className="mt-1 h-8 w-full max-w-[360px]">
              <a href={`/api/attachments/${v.voiceNoteId}`}>Download the voice note</a>
            </audio>
          </section>
        ) : null}

        {v.competitors.length ? (
          <section>
            <h4 className="text-[12px] font-medium uppercase tracking-wide text-muted">
              Competition he found here
            </h4>
            <ul className="mt-1 space-y-1.5">
              {v.competitors.map((c, i) => (
                <li key={i}>
                  <span className="font-medium text-ink">{c.competitorName}</span>
                  {c.productName ? ` · ${c.productName}` : ""}
                  {c.pricePaise != null ? ` · ${money(c.pricePaise)}` : ""}
                  {c.rateNote ? ` (${c.rateNote})` : ""}
                  {c.creditDays != null ? ` · ${c.creditDays} days credit` : c.creditTerms ? ` · ${c.creditTerms}` : ""}
                  {c.deliveryNote ? <span className="block text-muted">Delivery: {c.deliveryNote}</span> : null}
                  {c.strengths ? <span className="block text-muted">Strong on: {c.strengths}</span> : null}
                  {c.weaknesses ? <span className="block text-muted">Weak on: {c.weaknesses}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-wrap gap-x-6 gap-y-1 text-muted">
          <span>
            {v.checkInAt ? `In ${clock(v.checkInAt)}` : "No check-in time"}
            {v.checkOutAt ? ` · out ${clock(v.checkOutAt)}` : " · never checked out"}
          </span>
          <span>{produced.length ? `Came away with ${produced.join(", ")}` : "Nothing taken on this visit"}</span>
          {v.nextFollowUpDate ? <span>Follow up on {v.nextFollowUpDate}</span> : null}
        </section>
      </div>

      <div className="flex gap-2">
        {v.shopPhotoId ? <Thumb id={v.shopPhotoId} alt={`${v.customerName}, the shop`} size={140} caption="Shop" /> : null}
        {v.custPhotoId ? <Thumb id={v.custPhotoId} alt={`${v.customerName}, the customer`} size={140} caption="Customer" /> : null}
        {!v.shopPhotoId && !v.custPhotoId ? <span className="text-muted">No photographs on this visit.</span> : null}
      </div>
    </div>
  );
}

/** A photograph off the handset, opening full size in a new tab. Access is
 * checked by `/api/attachments/[id]` on every read. */
export function Thumb({ id, alt, size, caption }: { id: string; alt: string; size: number; caption?: string }) {
  return (
    <a
      href={`/api/attachments/${id}`}
      target="_blank"
      rel="noreferrer"
      title="Open the full photograph"
      className="block text-center text-[12px] text-muted no-underline"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/attachments/${id}`}
        alt={alt}
        loading="lazy"
        style={{ width: size, height: size }}
        className="rounded-[4px] border border-line object-cover hover:border-brand"
      />
      {caption ? <span className="mt-0.5 block">{caption}</span> : null}
    </a>
  );
}


/** Named, because this renders on a server that is not in Asia/Kolkata. */
export function clock(at: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}
