"use client";

import * as React from "react";
import { askTeam } from "@/lib/actions/ask-team";
import { SalesIcon } from "./icons";

/* ---------------------------------------------------------------------------
 * "Ask about the team" — the design's right-hand drawer, to its own numbers.
 *
 * 520px wide, capped at `100vw - 48px`; a 45% scrim over #1A1E28; the drawer
 * slides 24px and the scrim fades, both on 150–200ms of the console's own
 * easing. Those are the design's values and not approximations of them.
 *
 * THE LABEL OVER EVERY ANSWER IS A PROMISE. "Written from your team's figures"
 * is only true because `teamBrief()` hands the model the same numbers the
 * Performance and Today screens read and the system prompt forbids it anything
 * else. If that ever stops being true the label has to come off — it is the
 * one piece of text here that a manager will trust a number on.
 *
 * WHY THE THREAD IS NOT PERSISTED. Nothing here is a record: the answers are a
 * reading of figures that are themselves on screen, and the figures move. A
 * stored thread would be a month-old sentence about a number that has since
 * changed, which is the kind of thing somebody quotes back. Closing the drawer
 * clears it, and that is deliberate.
 * ------------------------------------------------------------------------- */

type Message =
  | { role: "user"; text: string }
  | { role: "ai"; text: string; period: { from: string; to: string } };

/**
 * The starting questions.
 *
 * Five, as the design draws them, and every one answerable from the brief —
 * a suggested question the figures cannot answer teaches somebody on their
 * first use that the panel does not work.
 */
const CHIPS = [
  "Who is behind on target and by how much?",
  "Who has not checked in today?",
  "How much cash is the team holding?",
  "How are we doing against the visit plan?",
  "What should I look at first this morning?",
];

export function AskPanel() {
  const [open, setOpen] = React.useState(false);

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
        onClick={() => setOpen(true)}
        className="inline-flex h-8 flex-none cursor-pointer items-center gap-[7px] rounded-[4px] border border-brand-softer bg-brand-soft px-3 text-[13px] font-medium text-[#5223E0] transition-colors duration-100 hover:bg-brand-softer"
      >
        <SalesIcon name="spark" size={14} />
        Ask about the team
      </button>

      {open ? <Drawer onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Mounted only while open, so it starts empty every time rather than resetting
 * itself in an effect — the React Compiler rule every drawer in this codebase
 * follows.
 */
function Drawer({ onClose }: { onClose: () => void }) {
  const [thread, setThread] = React.useState<Message[]>([]);
  const [q, setQ] = React.useState("");
  const [thinking, setThinking] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const bottom = React.useRef<HTMLDivElement>(null);

  const ask = React.useCallback(async (question: string) => {
    const text = question.trim();
    if (!text) return;
    setQ("");
    setProblem(null);
    setThread((t) => [...t, { role: "user", text }]);
    setThinking(true);
    try {
      const result = await askTeam({ question: text });
      if (result.ok) {
        setThread((t) => [
          ...t,
          { role: "ai", text: result.data.text, period: result.data.period },
        ]);
      } else {
        /*
         * A refusal is shown as itself and NOT as a message in the thread. The
         * thread is answers written from the figures; "no AI account is
         * connected" is a fact about the deployment, and dressing it as an
         * answer would put it under the "written from your team's figures"
         * label, which would make that label a lie.
         */
        setProblem(result.error);
      }
    } finally {
      setThinking(false);
      requestAnimationFrame(() =>
        bottom.current?.scrollIntoView({ block: "end" }),
      );
    }
  }, []);

  const empty = thread.length === 0;

  return (
    <div
      onClick={onClose}
      className="animate-fade-in fixed inset-0 z-60 flex justify-end bg-[rgba(26,30,40,0.45)]"
      role="dialog"
      aria-modal="true"
      aria-label="Ask about the team"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="animate-drawer-in flex w-[520px] max-w-[calc(100vw-48px)] flex-col bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
      >
        {/* ---------------------------------------------------------- head */}
        <div className="flex flex-none items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <div className="text-lg font-semibold text-ink">Ask about the team</div>
            <div className="mt-0.5 text-[13px] text-muted">
              Reads today&apos;s attendance and today&apos;s and this month&apos;s visits,
              orders, targets, approvals, cash, leads, bills, leave and expenses.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
          >
            <SalesIcon name="close" size={16} />
          </button>
        </div>

        {/* --------------------------------------------------------- thread */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {empty ? (
            <div>
              <div className="mb-2.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
                Try one of these
              </div>
              {CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => ask(c)}
                  className="mb-2 block min-h-11 w-full cursor-pointer rounded-[6px] border border-line bg-surface px-3 py-2.5 text-left text-sm text-ink hover:border-brand hover:bg-canvas"
                >
                  {c}
                </button>
              ))}
            </div>
          ) : null}

          {thread.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="mb-3 text-right">
                <span className="inline-block max-w-[86%] rounded-[10px_10px_2px_10px] border border-brand-softer bg-brand-soft px-3 py-2.5 text-left text-sm leading-5 text-ink">
                  {m.text}
                </span>
              </div>
            ) : (
              <div key={i} className="mb-4">
                <span className="mb-1.5 flex items-center gap-1.5">
                  <span className="flex text-[#5223E0]">
                    <SalesIcon name="spark" size={14} />
                  </span>
                  <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    Written from your team&apos;s figures
                  </span>
                </span>
                <span className="block text-sm leading-[21px] whitespace-pre-wrap text-ink">
                  {m.text}
                </span>
                {/* Which window it read. The design's answers carry a link; the
                    honest version of that here is naming the period, because a
                    figure with no dates is the thing somebody misquotes. */}
                <span className="mt-1.5 block text-[11px] text-muted">
                  {m.period.from} to {m.period.to}
                </span>
              </div>
            ),
          )}

          {thinking ? (
            <div className="mt-3 flex items-center gap-2">
              <span className="block h-4 w-4 animate-spin rounded-full border-2 border-brand-softer border-t-brand" />
              <span className="text-sm text-muted">Reading the figures…</span>
            </div>
          ) : null}

          {problem ? (
            <div className="mt-3 rounded-[6px] border border-warn-line bg-warn-soft px-3 py-2.5 text-[13px] text-warn-ink">
              {problem}
            </div>
          ) : null}

          <div ref={bottom} />
        </div>

        {/* ----------------------------------------------------------- ask */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!thinking) ask(q);
          }}
          className="flex flex-none gap-2.5 border-t border-line px-5 py-3"
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={thinking}
            placeholder="Ask anything about the team"
            className="h-10 min-w-0 flex-1 rounded-[6px] border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-brand"
          />
          <button
            type="submit"
            disabled={thinking || !q.trim()}
            className="h-10 flex-none cursor-pointer rounded-[6px] border border-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Ask
          </button>
        </form>
      </div>
    </div>
  );
}
