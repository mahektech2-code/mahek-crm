"use client";

import * as React from "react";
import Link from "next/link";
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

type Message =
  | { role: "user"; text: string }
  | {
      role: "ai";
      text: string;
      steps: string[];
      /** Records the answer read, to open — the ERP's answers carry them. */
      links?: Array<{ label: string; href: string }>;
      done: boolean;
      meta?: { queries: number; dbQueries: number; cached: boolean; ms: number };
    };

type AskEvent =
  | { type: "step"; text: string }
  | { type: "delta"; text: string }
  | { type: "links"; links: Array<{ label: string; href: string }> }
  | { type: "done"; queries: number; dbQueries: number; cached: boolean; ms: number }
  | { type: "error"; message: string };

export function AskPanel({ setup }: { setup: AskSetup }) {
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
        className="inline-flex h-8 flex-none cursor-pointer items-center gap-[7px] rounded-[4px] border border-brand-softer bg-brand-soft px-3 text-[13px] font-medium text-[#5223E0] transition-colors duration-100 hover:bg-brand-softer"
      >
        <SalesIcon name="spark" size={14} />
        {setup.button ?? "Ask AI"}
      </button>

      {/* On <body>: the header is `relative z-2`, which trapped this drawer
          under the Live map's controls — see body-portal.tsx. */}
      {open ? (
        <BodyPortal>
          <Drawer key={open.n} setup={setup} initial={open.initial} onClose={() => setOpen(null)} />
        </BodyPortal>
      ) : null}
    </>
  );
}

/**
 * Mounted only while open, so it starts empty every time rather than resetting
 * itself in an effect — the React Compiler rule every drawer in this codebase
 * follows.
 */
function Drawer({ setup, initial, onClose }: { setup: AskSetup; initial: string | null; onClose: () => void }) {
  /* Opened on a question, the drawer starts mid-answer: the thread and the
     spinner are its initial state, and the mount effect only starts reading. */
  const [thread, setThread] = React.useState<Message[]>(() =>
    initial ? [{ role: "user", text: initial }, { role: "ai", text: "", steps: [], done: false }] : [],
  );
  const [q, setQ] = React.useState("");
  const [thinking, setThinking] = React.useState(Boolean(initial));
  const [problem, setProblem] = React.useState<string | null>(null);
  const bottom = React.useRef<HTMLDivElement>(null);
  const abort = React.useRef<AbortController | null>(null);

  // Warm the server's memory of what this person may read, and stop any
  // answer still streaming when the drawer closes.
  React.useEffect(() => {
    if (initial) void run(initial, []);
    else
      fetch(setup.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warm: true }),
      }).catch(() => undefined);
    return () => abort.current?.abort();
    // Once, on mount: the drawer is keyed per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scroll = () => requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: "end" }));

  /** Apply one change to the answer being written — always the last message. */
  const patchLast = (fn: (m: Extract<Message, { role: "ai" }>) => Extract<Message, { role: "ai" }>) =>
    setThread((t) => {
      const last = t[t.length - 1];
      if (!last || last.role !== "ai") return t;
      return [...t.slice(0, -1), fn(last)];
    });

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || thinking) return;
    // Earlier finished turns, so a follow-up keeps its meaning.
    const history = thread
      .filter((m) => m.role === "user" || m.done)
      .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: m.text }))
      .filter((m) => m.text.trim());
    setQ("");
    setProblem(null);
    setThread((t) => [...t, { role: "user", text }, { role: "ai", text: "", steps: [], done: false }]);
    setThinking(true);
    scroll();
    await run(text, history);
  };

  /** Read the answer into the last message. Every state change waits on the network. */
  async function run(text: string, history: Array<{ role: "user" | "assistant"; text: string }>) {
    const controller = new AbortController();
    abort.current = controller;
    let failed: string | null = null;
    try {
      const res = await fetch(setup.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, history }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        failed = j?.error ?? "Could not answer just now. Try again in a moment.";
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
            if (!line) continue;
            const e = JSON.parse(line) as AskEvent;
            if (e.type === "step") patchLast((m) => ({ ...m, steps: [...m.steps, e.text] }));
            else if (e.type === "delta") patchLast((m) => ({ ...m, text: m.text + e.text }));
            else if (e.type === "links") patchLast((m) => ({ ...m, links: e.links }));
            else if (e.type === "done")
              patchLast((m) => ({ ...m, done: true, meta: { queries: e.queries, dbQueries: e.dbQueries, cached: e.cached, ms: e.ms } }));
            else if (e.type === "error") failed = e.message;
            scroll();
          }
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        failed = "Lost the connection while answering. Try again.";
      }
    } finally {
      abort.current = null;
      setThinking(false);
    }

    if (failed) {
      /*
       * A refusal is shown as itself and NOT as a message in the thread. "No AI
       * account is connected" is a fact about the deployment, and dressing it
       * as an answer would put it under the "from your team's data" label.
       */
      setThread((t) => (t[t.length - 1]?.role === "ai" && !(t[t.length - 1] as { text: string }).text ? t.slice(0, -1) : t));
      setProblem(failed);
    } else {
      patchLast((m) => ({ ...m, done: true }));
    }
    scroll();
  }

  const empty = thread.length === 0;

  return (
    <div
      onClick={onClose}
      className="animate-fade-in fixed inset-0 z-60 flex justify-end bg-[rgba(26,30,40,0.45)]"
      role="dialog"
      aria-modal="true"
      aria-label={setup.title}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="animate-drawer-in flex w-[520px] max-w-[calc(100vw-48px)] flex-col bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
      >
        {/* ---------------------------------------------------------- head */}
        <div className="flex flex-none items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold text-ink">
              <span className="flex text-[#5223E0]">
                <SalesIcon name="spark" size={16} />
              </span>
              {setup.title}
            </div>
            <div className="mt-0.5 text-[13px] text-muted">{setup.intro}</div>
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
              {setup.chips.map((c) => (
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
              <AiAnswer key={i} m={m} source={setup.source} onOpen={onClose} />
            ),
          )}

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
            ask(q);
          }}
          className="flex flex-none gap-2.5 border-t border-line px-5 py-3"
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={thinking}
            placeholder={setup.placeholder}
            autoFocus
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

/** One answer: the reads it is making, then the words as they arrive. */
function AiAnswer({ m, source, onOpen }: { m: Extract<Message, { role: "ai" }>; source: string; onOpen: () => void }) {
  const writing = !m.done;
  return (
    <div className="mb-4">
      <span className="mb-1.5 flex items-center gap-1.5">
        <span className="flex text-[#5223E0]">
          <SalesIcon name="spark" size={14} />
        </span>
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          {source}
        </span>
      </span>

      {/* While it works, every read is listed as it is made; once the answer
          has started, they fold into the line underneath it. */}
      {writing && !m.text ? (
        <div className="mb-1.5 space-y-1">
          {m.steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-[13px] text-muted">
              <span className="block h-1.5 w-1.5 flex-none rounded-full bg-brand-softer" />
              {s}
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="block h-4 w-4 animate-spin rounded-full border-2 border-brand-softer border-t-brand" />
            <span className="text-sm text-muted">{m.steps.length ? "Reading…" : "Thinking…"}</span>
          </div>
        </div>
      ) : null}

      {m.text ? (
        <span className="block text-sm leading-[21px] whitespace-pre-wrap text-ink">
          {m.text}
          {writing ? <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-brand-softer align-middle" /> : null}
        </span>
      ) : null}

      {m.links?.length ? (
        <div className="mt-2 flex flex-col items-start gap-1">
          {m.links.map((l) => (
            <Link key={l.href + l.label} href={l.href} onClick={onOpen} className="text-[13px] text-brand hover:underline">
              {l.label} →
            </Link>
          ))}
        </div>
      ) : null}

      {m.done && m.meta ? (
        <span className="mt-1.5 block text-[11px] text-muted" title={m.steps.join(" · ")}>
          {m.meta.cached
            ? "Answered from a moment ago"
            : m.meta.queries
              ? `Looked at ${m.meta.queries} ${m.meta.queries === 1 ? "thing" : "things"}${
                  m.meta.queries > m.meta.dbQueries ? ` (${m.meta.queries - m.meta.dbQueries} from memory)` : ""
                }`
              : "No data needed"}{" "}
          · {(m.meta.ms / 1000).toFixed(1)}s
        </span>
      ) : null}
    </div>
  );
}
