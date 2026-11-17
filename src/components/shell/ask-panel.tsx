"use client";

import * as React from "react";
import { BodyPortal } from "@/components/ui/body-portal";
import { SalesIcon } from "@/components/console/icons";

/* ---------------------------------------------------------------------------
 * ASK AI — one drawer for every MahekOne app that answers questions from its
 * own data. The Sales Dashboard's "Ask about the team" was the first; the CRM's
 * "Ask the CRM" is the second, and an app joins by giving it an endpoint that
 * streams the same events (`team-ask-service.ts`'s `AskEvent`).
 *
 * The design's right-hand drawer, to its own numbers: 520px wide, capped at
 * `100vw - 48px`; a 45% scrim over #1A1E28; the drawer slides 24px and the
 * scrim fades, both on 150–200ms of the console's own easing.
 *
 * IT READS THE DATABASE, not a summary. The endpoint streams one JSON line per
 * event: each read the model makes, then the answer's words as they are
 * written. The reads are drawn as they happen so the person watches it work
 * instead of a spinner; they collapse to a count once the answer lands. What
 * it may read is the asker's own access.
 *
 * THE THREAD IS A CONVERSATION while the drawer is open: earlier turns ride
 * along so "and last month?" means something. It is NOT persisted — closing
 * the drawer clears it, because a stored answer is a month-old sentence about
 * a number that has since moved.
 *
 * THE HEADER SEARCH ASKS IT TOO. Typing a question into the search box and
 * choosing "Ask AI" fires `askAi(question)`, which opens this drawer with the
 * question already asked — one box to find a thing or ask about it, the way
 * the ERP's header works.
 *
 * IT CAN BE ASKED BY SPEAKING, in any language (`ask-mic.tsx`): the
 * telecallers' dictation microphone sits beside the box, the question is read
 * as English, and the answer is written back in the language that was spoken.
 *
 * OPENING THE DRAWER WARMS IT: the server resolves and remembers what this
 * person may read before they have typed, so the first question starts
 * immediately.
 * ------------------------------------------------------------------------- */

const ASK_EVENT = "mahek:ask-ai";

/** Open this app's Ask AI drawer with a question already asked. */
export function askAi(question: string) {
  window.dispatchEvent(new CustomEvent<string>(ASK_EVENT, { detail: question }));
}

export type AskSetup = {
  /** The streaming endpoint, e.g. `/api/crm/ask`. */
  endpoint: string;
  /** The drawer's heading, e.g. "Ask the CRM". */
  title: string;
  /** The line under the heading. */
  intro: string;
  /** Starting questions — each one answerable from what the asker may read. */
  chips: string[];
  placeholder: string;
  /** Over each answer: where it came from, e.g. "From your book". */
  source: string;
  /** The header button's words. */
  button?: string;
};

export type Message =
  | { role: "user"; text: string; spoken?: string }
  | {
      role: "ai";
      text: string;
      steps: string[];
      /** Records the answer read, to open — the ERP's answers carry them. */
      links?: Array<{ label: string; href: string }>;
      done: boolean;
      meta?: { queries: number; dbQueries: number; cached: boolean; ms: number };
    };

export type AskEvent =
  | { type: "step"; text: string }
  | { type: "delta"; text: string }
  | { type: "links"; links: Array<{ label: string; href: string }> }
  | { type: "done"; queries: number; dbQueries: number; cached: boolean; ms: number }
  | { type: "error"; message: string };

export function AskPanel({ setup, boxed = false }: { setup: AskSetup; /** The v4 console's white, 34px trigger. */ boxed?: boolean }) {
  /* Each opening is a fresh drawer: `n` changes its key, `initial` is the
     question it opens on (null when opened from the button). */
  const [open, setOpen] = React.useState<{ n: number; initial: string | null } | null>(null);

  React.useEffect(() => {
    const onAsk = (e: Event) => {
      const q = (e as CustomEvent<string>).detail?.trim();
      setOpen((o) => ({ n: (o?.n ?? 0) + 1, initial: q || null }));
    };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, []);

  return (
    <>
      {/*
        The design's header button: 32px tall, brand-soft fill, brand-softer
        border, brand-hover text, and the fill darkens to the border colour on
        hover. Not a plain secondary — it is the one control in the header that
        is tinted, because it is the one that does something nothing else does.
      */}
      <button
        type="button"
        onClick={() => setOpen((o) => ({ n: (o?.n ?? 0) + 1, initial: null }))}
        title={`${setup.title} — or type a question into the search box`}
        className={boxed ? "inline-flex h-[34px] flex-none cursor-pointer items-center gap-1.5 rounded-control border border-brand-softer bg-surface px-3 text-[13px] font-semibold text-[#343e96] transition-colors duration-100 hover:bg-canvas" : "inline-flex h-8 flex-none cursor-pointer items-center gap-[7px] rounded-[4px] border border-brand-softer bg-brand-soft px-3 text-[13px] font-medium text-[#5223E0] transition-colors duration-100 hover:bg-brand-softer"}
      >
        <SalesIcon name="spark" size={14} />
        {setup.button ?? "Ask AI"}
      </button>

      {/* On <body>: the header is `relative z-2`, which trapped this drawer
          under the Live map's controls — see body-portal.tsx. */}
      {open ? (
        <BodyPortal>
          <React.Suspense fallback={null}>
            <Drawer key={open.n} setup={setup} initial={open.initial} onClose={() => setOpen(null)} />
          </React.Suspense>
        </BodyPortal>
      ) : null}
    </>
  );
}

/* THE DRAWER IS FETCHED WHEN IT OPENS. It is the conversation, the answer
   renderer and the microphone with its recording modal; the button is in
   every header and was carrying all of that into every first download. */
const Drawer = React.lazy(() => import("./ask-drawer").then((m) => ({ default: m.Drawer })));
