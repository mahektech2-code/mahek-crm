"use client";

import * as React from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { SalesIcon } from "@/components/console/icons";
import { DOC_APPS, docApp } from "@/docs/registry";
import { AnswerBody } from "./answer-blocks";

/* ---------------------------------------------------------------------------
 * "Ask the docs" — the Documentation app's chat, docked on the right.
 *
 * The Sales Dashboard's "Ask about the team" drawer, with one difference that
 * matters: it is DOCKED rather than modal. Every answer links to the sections
 * it came from, and following a link must not close the conversation that
 * produced it — so the page moves aside, the panel stays, and the reader can
 * read the cited section with the answer still beside it.
 *
 * `/api/docs/ask` streams one JSON line per event: each lookup ("Searched for
 * …", "Read Call Log › The quiet window"), each section read, then the words.
 * An answer may be a picture as well as words — a flowchart, a wireframe, a
 * table or an image — drawn by `answer-blocks.tsx`; "Wider" gives one room.
 *
 * The thread is a conversation while the panel is open, so "and on the
 * handset?" means something, and it is NOT kept: closing clears it.
 *
 * "SEARCH IN" picks one app's documentation or all of it. It starts on the app
 * being read — the question is usually about that app — and follows the reader
 * between apps until they choose for themselves; after that their choice
 * stands. Each question in the thread says where it was asked.
 * ------------------------------------------------------------------------- */

type Source = { href: string; title: string; heading: string | null; tab: string };

type Message =
  | { role: "user"; text: string; scope: string | null }
  | { role: "ai"; text: string; steps: string[]; sources: Source[]; done: boolean; meta?: { lookups: number; cached: boolean; ms: number } };

type AskEvent =
  | { type: "step"; text: string }
  | ({ type: "source" } & Source)
  | { type: "delta"; text: string }
  | { type: "done"; lookups: number; cached: boolean; ms: number }
  | { type: "error"; message: string };

export type AskPlace = { app: string; slug: string | null; tab: string | null } | null;

const CHIPS: Record<string, string[]> = {
  "": [
    "Why is a customer not on my Call Log today?",
    "How does a lead become a customer?",
    "How is a salesman's performance score worked out?",
    "How do I release a new version of the handset app?",
  ],
  crm: [
    "Why is a customer not on my Call Log today?",
    "What happens when a customer reports a payment?",
    "How does a lead move from Suspect to Prospect?",
  ],
  sales: ["How is a salesman's performance score worked out?", "What does the Live map show?", "How are expenses approved?"],
  mbos: ["What does a salesman do at punch-in?", "Why was a check-in refused?", "How does the handset work with no signal?"],
  erp: ["How does a box get scanned at dispatch?", "What is needed before a PO can be raised?", "How is stock counted?"],
  platform: ["How do I deploy to DigitalOcean?", "Where are files stored?", "How do the Google Sheets syncs run?"],
};

export function AskPanel({
  place,
  request,
  wide,
  onWide,
  onClose,
}: {
  place: AskPlace;
  /** Wide gives a diagram or a wireframe room; the shell moves the page aside by the same amount. */
  wide: boolean;
  onWide: (wide: boolean) => void;
  /** A question handed over from elsewhere (⌘K) — asked as soon as it arrives. */
  request: { id: number; text: string } | null;
  onClose: () => void;
}) {
  const [thread, setThread] = React.useState<Message[]>([]);
  const [q, setQ] = React.useState("");
  const [thinking, setThinking] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const bottom = React.useRef<HTMLDivElement>(null);
  const abort = React.useRef<AbortController | null>(null);
  const input = React.useRef<HTMLTextAreaElement>(null);
  // undefined: not chosen yet, so it follows the app being read. null: all apps.
  const [picked, setPicked] = React.useState<string | null | undefined>(undefined);
  const scope = picked === undefined ? (place?.app ?? null) : picked;

  React.useEffect(() => () => abort.current?.abort(), []);

  const scroll = () => requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: "end" }));

  const patchLast = (fn: (m: Extract<Message, { role: "ai" }>) => Extract<Message, { role: "ai" }>) =>
    setThread((t) => {
      const last = t[t.length - 1];
      if (!last || last.role !== "ai") return t;
      return [...t.slice(0, -1), fn(last)];
    });

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || thinking) return;
    const history = thread
      .filter((m) => m.role === "user" || m.done)
      .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: m.text }))
      .filter((m) => m.text.trim());
    setQ("");
    setProblem(null);
    setThread((t) => [...t, { role: "user", text, scope }, { role: "ai", text: "", steps: [], sources: [], done: false }]);
    setThinking(true);
    scroll();

    const controller = new AbortController();
    abort.current = controller;
    let failed: string | null = null;
    try {
      const res = await fetch("/api/docs/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, history, place, scope }),
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
            else if (e.type === "source")
              patchLast((m) => ({ ...m, sources: [...m.sources, { href: e.href, title: e.title, heading: e.heading, tab: e.tab }] }));
            else if (e.type === "delta") patchLast((m) => ({ ...m, text: m.text + e.text }));
            else if (e.type === "done") patchLast((m) => ({ ...m, done: true, meta: { lookups: e.lookups, cached: e.cached, ms: e.ms } }));
            else if (e.type === "error") failed = e.message;
            scroll();
          }
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) failed = "Lost the connection while answering. Try again.";
    } finally {
      abort.current = null;
      setThinking(false);
    }

    if (failed) {
      // A refusal is a fact about the deployment, not an answer: shown as itself.
      setThread((t) => (t[t.length - 1]?.role === "ai" && !(t[t.length - 1] as { text: string }).text ? t.slice(0, -1) : t));
      setProblem(failed);
    } else {
      patchLast((m) => ({ ...m, done: true }));
    }
    scroll();
    input.current?.focus();
  };

  // A question handed over from the search box is asked once, as it arrives.
  const asked = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!request || asked.current === request.id) return;
    asked.current = request.id;
    void ask(request.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const chips = CHIPS[scope ?? ""] ?? CHIPS[""];

  return (
    <aside
      aria-label="Ask the docs"
      className={cx(
        "animate-fade-in fixed top-14 right-0 bottom-0 z-40 flex flex-col transition-[width] duration-150",
        "border-l border-line bg-surface shadow-[-8px_0_24px_rgba(22,22,22,0.06)] print:hidden",
        wide ? "w-[min(760px,calc(100vw-48px))]" : "w-[min(440px,calc(100vw-48px))]",
      )}
    >
      <div className="flex flex-none items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[15px] font-semibold text-ink">
            <span className="flex text-[#5223E0]">
              <SalesIcon name="spark" size={15} />
            </span>
            Ask the docs
          </div>
          <div className="mt-0.5 text-[12px] leading-[17px] text-muted">
            Ask how something works. The answer is read from the documentation, with links to where it says so.
          </div>
        </div>
        <div className="flex flex-none items-center gap-1">
          {thread.length ? (
            <button
              type="button"
              onClick={() => {
                abort.current?.abort();
                setThread([]);
                setProblem(null);
              }}
              className="h-7 cursor-pointer rounded-[4px] px-2 text-[12px] text-muted hover:bg-canvas hover:text-ink"
            >
              New chat
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onWide(!wide)}
            className="h-7 cursor-pointer rounded-[4px] px-2 text-[12px] text-muted hover:bg-canvas hover:text-ink"
            title={wide ? "Make the panel narrower" : "Make the panel wider, for diagrams and wireframes"}
          >
            {wide ? "Narrower" : "Wider"}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
          >
            <SalesIcon name="close" size={15} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {thread.length === 0 ? (
          <div>
            <div className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Try one of these</div>
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => ask(c)}
                className="mb-2 block w-full cursor-pointer rounded-[6px] border border-line bg-surface px-3 py-2 text-left text-[13px] text-ink hover:border-brand hover:bg-canvas"
              >
                {c}
              </button>
            ))}
          </div>
        ) : null}

        {thread.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="mb-3 text-right">
              <span className="inline-block max-w-[88%] rounded-[10px_10px_2px_10px] border border-brand-softer bg-brand-soft px-3 py-2 text-left text-[13px] leading-5 text-ink">
                {m.text}
              </span>
              <span className="mt-0.5 block text-[10px] text-faint">
                {m.scope ? `in ${docApp(m.scope)?.title ?? m.scope}` : "in all apps"}
              </span>
            </div>
          ) : (
            <AiAnswer key={i} m={m} />
          ),
        )}

        {problem ? (
          <div className="mt-3 rounded-[6px] border border-warn-line bg-warn-soft px-3 py-2.5 text-[13px] text-warn-ink">{problem}</div>
        ) : null}
        <div ref={bottom} />
      </div>

      <div className="flex flex-none flex-wrap items-center gap-[3px] border-t border-line px-4 pt-2.5" role="radiogroup" aria-label="Search in">
        <span className="mr-0.5 text-[11px] text-muted">Search</span>
        {[null, ...DOC_APPS.map((a) => a.app)].map((id) => {
          const on = scope === id;
          const app = id ? docApp(id) : undefined;
          return (
            <button
              key={id ?? "all"}
              type="button"
              role="radio"
              aria-checked={on}
              title={app ? `Only the ${app.title} documentation` : "Every app's documentation"}
              onClick={() => setPicked(id)}
              className={cx(
                "h-6 cursor-pointer rounded-full border px-2 text-[11px] font-medium",
                on ? "border-brand bg-brand text-white" : "border-line bg-surface text-body hover:border-brand-softer hover:text-brand-hover",
              )}
            >
              {app ? app.short : "All apps"}
              
            </button>
          );
        })}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
        className="flex flex-none items-end gap-2 px-4 pt-2 pb-3"
      >
        <textarea
          ref={input}
          autoFocus
          rows={1}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(q);
            }
            if (e.key === "Escape") onClose();
          }}
          disabled={thinking}
          placeholder={scope ? `Ask about the ${docApp(scope)?.title ?? scope}` : "Ask about any app"}
          className="max-h-32 min-h-10 min-w-0 flex-1 resize-none rounded-[6px] border border-line bg-surface px-3 py-2 text-[13px] leading-5 text-ink outline-none focus:border-brand [field-sizing:content]"
        />
        <button
          type="submit"
          disabled={thinking || !q.trim()}
          className="h-10 flex-none cursor-pointer rounded-[6px] border border-brand bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Ask
        </button>
      </form>
    </aside>
  );
}

function AiAnswer({ m }: { m: Extract<Message, { role: "ai" }> }) {
  const writing = !m.done;
  return (
    <div className="mb-5">
      <span className="mb-1.5 flex items-center gap-1.5">
        <span className="flex text-[#5223E0]">
          <SalesIcon name="spark" size={13} />
        </span>
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">From the documentation</span>
      </span>

      {writing && !m.text ? (
        <div className="mb-1.5 space-y-1">
          {m.steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-[12px] text-muted">
              <span className="block h-1.5 w-1.5 flex-none rounded-full bg-brand-softer" />
              <span className="truncate">{s}</span>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="block h-4 w-4 animate-spin rounded-full border-2 border-brand-softer border-t-brand" />
            <span className="text-[13px] text-muted">{m.steps.length > 1 ? "Reading…" : "Thinking…"}</span>
          </div>
        </div>
      ) : null}

      {m.text ? (
        <div className="text-[13px] leading-[20px] text-ink">
          <AnswerBody text={m.text} />
          {writing ? <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-brand-softer align-middle" /> : null}
        </div>
      ) : null}

      {m.done && m.sources.length ? (
        <div className="mt-2.5">
          <div className="mb-1 text-[10px] font-semibold tracking-[0.07em] text-faint uppercase">Sources</div>
          <div className="flex flex-wrap gap-1.5">
            {m.sources.map((s) => (
              <Link
                key={s.href}
                href={s.href}
                className="inline-flex max-w-full items-center gap-1 rounded-[4px] border border-line bg-canvas px-1.5 py-0.5 text-[11px] text-body no-underline hover:border-brand-softer hover:text-brand-hover hover:no-underline"
              >
                <span className="truncate">
                  {s.title}
                  {s.heading ? ` › ${s.heading}` : ""}
                </span>
                {s.tab ? <span className="flex-none text-faint">· {s.tab}</span> : null}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {m.done && m.meta ? (
        <span className="mt-1.5 block text-[11px] text-muted" title={m.steps.join(" · ")}>
          {m.meta.cached ? "Answered from a moment ago" : `${m.steps.length} ${m.steps.length === 1 ? "lookup" : "lookups"}`} ·{" "}
          {(m.meta.ms / 1000).toFixed(1)}s
        </span>
      ) : null}
    </div>
  );
}
