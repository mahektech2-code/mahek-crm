"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import { COMMUNICATION_ACTIONS } from "@/lib/lead-labels";
import type { LeadCommunications, PublishedDocument } from "@/lib/services/lead-console-service";
import { recordCommunication } from "@/lib/actions/leads";
import { Button, Pill } from "@/components/console/parts";

/**
 * §14 — the eleven buttons, driven from the list rather than typed out.
 *
 * `COMMUNICATION_ACTIONS` is the authority on what they are and which library
 * category each `send` reaches for. Writing eleven buttons into this file would
 * be the same mistake as a product list typed into a screen: two web screens
 * read that list — this panel and `actions/communication-screen.tsx` — and the
 * half that drifts is always the half somebody is looking at.
 *
 * **THE HANDSET DOES NOT HAVE THIS YET, and the line above used to say it did.**
 * It read "the handset reads that list too", which is the shape of a true
 * sentence and is not one. `mbos-app/src/engines/funnel/lead-labels.ts` is a
 * byte-for-byte mirror of the server's file, so the eleven ARE on the phone as
 * a constant — and nothing on the phone imports them. That is the
 * exported-with-no-caller shape AGENTS.md names: legal TypeScript, clean lint,
 * every test green, and no screen. So a salesman standing in the shop cannot
 * send the current price list or log the call against the lead in front of him;
 * he does both from a desk afterwards, or not at all. The sentence is corrected
 * rather than deleted, because a comment asserting a feature exists where it
 * does not is worse than silence — it is the reason nobody goes looking, and
 * the gap survives another release on the strength of somebody having read it.
 *
 * **A send resolves its own document.** The whole point of the button is that a
 * manager never hunts for the current price list, so the category is looked up
 * and the newest published document of it is what goes. Where nothing of that
 * category is published the button is DISABLED and says so — a control that
 * dies when pressed teaches people to stop pressing, and there would be nothing
 * on the screen naming the fix, which is that somebody has to publish one.
 *
 * **Both kinds write the timeline.** A call logged and a file sent are the same
 * fact — somebody reached out on a day — and the value of the record is being
 * able to see both against a lead that has gone quiet. Recording only the sends
 * would make a lead rung four times read as untouched.
 */
/**
 * §8.5 §10.4 — WHAT HAS ALREADY GONE, marked on the button rather than only in
 * a list underneath it.
 *
 * The history below carries when and by whom, which a badge cannot, so it
 * stays. What it cannot do is answer the question somebody asks with their
 * hand already on a button: has this one gone. Answering it meant matching
 * eleven labels by eye against a list of sentences, and the failure that
 * follows is sending the price list twice — which is precisely the thing a
 * customer notices and reads as nobody here talking to each other.
 *
 * **THE COUNT, NEVER A TICK.** "Sent" alone flattens once and five times onto
 * one mark, and those are different mornings: one is a job done and the other
 * is a manager who should be picking up the phone instead of emailing a sixth
 * copy of the brochure. §16's chase counter exists for the same reason one
 * level up.
 *
 * **AND THE COUNT COMES FROM SQL, which it did not.** It was tallied here,
 * over the rows this component happened to hold — and `leadCommunications` is
 * capped at thirty, so on a lead rung more often than that every badge counted
 * within the newest thirty and read low with nothing anywhere saying so. That
 * is exactly the mistake the CRM's timeline pills made before their counts
 * came from SQL: a capped read that prints a number is a number about the cap
 * and not about the thing. A badge undercounting is worse than no badge,
 * because the whole of its job is to stop the sixth copy going out.
 *
 * So the service groups the WHOLE history and this renders what it is handed —
 * `countByAction` for the badges, `unattributed` for the rows that predate the
 * code, `total` for what the list below is a slice of. Nothing here parses a
 * source id any more: the convention lives in `sourceIdField` in
 * `lib/timeline.ts`, which is FIELD TWO of the colon-separated id, and this
 * file used to read everything-after-the-first-colon instead. The two agreed
 * only while no id had three fields, and `verificationCorrection` already
 * writes one that does.
 *
 * **AN ENTRY WITH NO CODE IS COUNTED APART, and said in words.** Rows written
 * before the suffix existed carry a bare id, so they are communications that
 * genuinely happened and cannot be attributed to one of the eleven. Folding
 * them into the nearest button would be inventing which; dropping them
 * silently would make the badges quietly undercount on exactly the oldest
 * leads, where the history matters most.
 */

/** The green mark on a button that has already been pressed, and how often. */
function SentBadge({ n }: { n: number }) {
  return (
    <span
      className="inline-flex items-center rounded-[9px] bg-success-soft px-1.5 py-[1px] text-[10px] leading-[14px] font-medium tracking-[0.03em] text-success uppercase"
      title={
        n === 1
          ? "This has gone out once. When, and who sent it, is in the list below."
          : `This has gone out ${n} times. When, and who sent each, is in the list below.`
      }
    >
      {n === 1 ? "Sent" : `Sent \u00d7${n}`}
    </span>
  );
}

export function CommunicationPanel({
  customerId,
  documents,
  history,
  disabled,
  disabledReason,
}: {
  customerId: string;
  /** Keyed by `mbos_documents.category`. Absent means nothing is published. */
  documents: Record<string, PublishedDocument>;
  /**
   * The capped list, the counts over the whole history, and what the list is
   * a slice of. One object rather than four props because they are one read
   * and a screen holding three of the four is a screen quoting a count
   * against a list it does not match.
   */
  history: LeadCommunications;
  disabled: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [acting, setActing] = React.useState<(typeof COMMUNICATION_ACTIONS)[number] | null>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin(action: (typeof COMMUNICATION_ACTIONS)[number]) {
    setActing(action);
    setNote("");
    setError(null);
  }

  async function submit() {
    if (!acting) return;
    setBusy(true);
    setError(null);
    const doc = acting.document ? documents[acting.document] : undefined;
    let result;
    try {
      result = await recordCommunication(customerId, {
        actionCode: acting.code,
        documentId: doc?.id,
        note: note.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setActing(null);
    toast.push(result.message ?? "Recorded.");
    router.refresh();
  }

  const missingCategories = COMMUNICATION_ACTIONS.filter(
    (a) => a.document && !documents[a.document],
  );

  return (
    <section className="rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        Reach out
      </div>
      <p className="mb-3 max-w-[560px] text-[12px] text-pretty text-muted">
        Eleven things without leaving this page. A send picks up whatever is published in the
        library today, so nobody is emailing last year&rsquo;s price list.
      </p>

      <div className="flex flex-wrap gap-2">
        {COMMUNICATION_ACTIONS.map((a) => {
          const doc = a.document ? documents[a.document] : undefined;
          const noDoc = Boolean(a.document) && !doc;
          const off = disabled || noDoc;
          /* The badge is drawn on a DISABLED button too. That it went out in
             March is a fact about this lead, and withdrawing the document since
             does not unsend it — hiding the mark there would make the one case
             where somebody most needs the history read as never having
             happened. */
          const n = history.countByAction[a.code] ?? 0;
          return (
            <Button
              key={a.code}
              size="sm"
              tone={a.kind === "call" ? "default" : "strong"}
              disabled={off}
              title={
                disabled
                  ? disabledReason
                  : noDoc
                    ? `Nothing is published under ${a.document}. Publish one in Documents and this button starts working — it is not sending an out-of-date file instead.`
                    : doc
                      ? `Sends “${doc.title}”`
                      : "Logs the call on the timeline"
              }
              onClick={() => begin(a)}
            >
              {a.label}
              {n ? <SentBadge n={n} /> : null}
            </Button>
          );
        })}
      </div>

      {missingCategories.length ? (
        <p className="mt-2.5 text-[12px] text-warn-ink">
          {missingCategories.length === 1 ? "One button is" : `${missingCategories.length} buttons are`}{" "}
          off because nothing is published for them —{" "}
          {missingCategories.map((a) => a.label.toLowerCase()).join(", ")}.
        </p>
      ) : null}

      <div className="mt-4 border-t border-divider pt-3">
        <div className="mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          What has gone out
        </div>
        {history.unattributed ? (
          /* Counted over the whole history and not over the list, so the
             sentence says "on this lead" rather than "below" — several of
             these can sit past the cap, and pointing at rows that are not on
             the screen is how somebody concludes the panel is broken. */
          <p className="mb-1.5 text-[12px] text-muted">
            {history.unattributed === 1
              ? "One communication on this lead was"
              : `${history.unattributed} communications on this lead were`}{" "}
            recorded before the action was stored with them, so{" "}
            {history.unattributed === 1 ? "it is" : "they are"} not counted on any button above.
          </p>
        ) : null}
        {history.rows.length < history.total ? (
          /* A capped list says what it is a slice of. Thirty is plenty of
             when-and-by-whom for a panel somebody skims, and the badges above
             are not a slice of anything — they are the whole history, from
             SQL, which is why the two numbers may honestly differ. */
          <p className="mb-1.5 text-[12px] text-muted">
            Showing the newest {history.rows.length} of {history.total}.
          </p>
        ) : null}
        {history.rows.length === 0 ? (
          <p className="text-[13px] text-muted">
            Nothing recorded. A lead nobody has contacted and a lead somebody rang four times look
            identical until one of these is written down.
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {history.rows.map((h) => (
              <li key={h.id} className="border-b border-divider py-1.5 last:border-b-0">
                <span className="text-[13px] text-body">{h.summary}</span>
                <span className="ml-2 text-[12px] text-muted">
                  {stamp(h.occurredAt)}
                  {h.actorName ? ` · ${h.actorName}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal
        open={Boolean(acting)}
        onClose={() => setActing(null)}
        title={acting?.label ?? ""}
        width={480}
      >
        {acting ? (
          <>
            <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
              {acting.kind === "send" ? (
                <>
                  <div className="font-medium text-ink">
                    {acting.document ? documents[acting.document]?.title : ""}
                  </div>
                  <div className="text-muted">
                    The current published {acting.document?.replace(/_/g, " ")}. It goes as it
                    stands — there is no second copy of it to pick from.
                  </div>
                </>
              ) : (
                <div className="text-body">
                  This records the attempt. Whether they picked up, and what they said, is what the
                  note is for.
                </div>
              )}
            </div>

            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                Note (optional)
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
            </label>

            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setActing(null)}>
                Cancel
              </Button>
              <Button tone="primary" disabled={busy} onClick={() => void submit()}>
                {busy ? "Saving…" : acting.kind === "send" ? "Send it" : "Log the call"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </section>
  );
}

/** A short read-only badge for a category with nothing behind it. */
export function DocumentPill({ doc }: { doc?: PublishedDocument }) {
  if (!doc) return <Pill tone="warn">Nothing published</Pill>;
  return <Pill tone="neutral">{doc.title}</Pill>;
}
