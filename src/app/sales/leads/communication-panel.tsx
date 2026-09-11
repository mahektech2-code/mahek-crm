"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import { COMMUNICATION_ACTIONS } from "@/lib/lead-labels";
import type { PublishedDocument, TimelineRow } from "@/lib/services/lead-console-service";
import { recordCommunication } from "@/lib/actions/leads";
import { Button, Pill } from "../parts";

/**
 * §14 — the eleven buttons, driven from the list rather than typed out.
 *
 * `COMMUNICATION_ACTIONS` is the authority on what they are and which library
 * category each `send` reaches for. Writing eleven buttons into this file would
 * be the same mistake as a product list typed into a screen: the handset reads
 * that list too, and the half that drifts is always the half somebody is
 * looking at.
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
  history: TimelineRow[];
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
        {history.length === 0 ? (
          <p className="text-[13px] text-muted">
            Nothing recorded. A lead nobody has contacted and a lead somebody rang four times look
            identical until one of these is written down.
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {history.map((h) => (
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
