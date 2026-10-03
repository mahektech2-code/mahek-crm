"use client";

import * as React from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  cx,
} from "@/components/ui/primitives";
import { VoiceTextarea } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import { DeliveryStatus } from "@/components/whatsapp/delivery-status";
import { markThreadHandled, sendChatMessage } from "@/lib/actions/crm";
import { addDays, calendarDate, type BusinessDate } from "@/lib/business-date";
import { clock, phoneDisplay, shortDate } from "@/lib/format";
import { previewOf, whenLabel } from "@/lib/whatsapp-status";
import { MEDIA_LABEL, type MediaType } from "@/lib/whatsapp-delivery";
import { ReplyMedia } from "./reply-media";
import type {
  ChatShow,
  Conversation,
  Thread,
} from "@/lib/services/whatsapp-chat-service";

/* ---------------------------------------------------------------------------
 * THE WHATSAPP CHAT — a conversation list beside one thread, like a chat app.
 *
 * LIVE, NOT REFRESHED. The page opens one Server-Sent Events stream
 * (`/api/whatsapp/stream`); when a customer writes, a tick arrives or a
 * colleague answers, the server names the conversation that moved and this
 * screen re-reads the list and, if it is the one open, the thread. Nothing
 * reloads the page. A stream that cannot be held — a proxy that buffers, a
 * network that drops it — is caught by a grace timer and replaced by asking
 * every fifteen seconds, and the header says which of the two is happening.
 *
 * Every read goes through the same scoped endpoints as the rest of the CRM;
 * the stream only says WHICH conversation moved, never what was said.
 * ------------------------------------------------------------------------- */

type List = {
  rows: Conversation[];
  openCount: number;
  seesUnknown: boolean;
  capped: boolean;
};
type Mode = "live" | "connecting" | "polling";

const POLL_MS = 15_000;
/** How long a fresh stream has to say hello before it is not worth waiting on. */
const GRACE_MS = 8_000;

export function ChatTab({
  initial,
  initialKey,
  today: businessDay,
  now: serverNow,
  scopeLabel,
  showAssignee,
  onOpenCount,
}: {
  initial: List;
  /** The conversation named in the URL (`?chat=`), opened on arrival. */
  initialKey: string | null;
  today: string;
  /** The server's clock at render — the clock is never read during render. */
  now: number;
  scopeLabel: string;
  showAssignee: boolean;
  /** The tab's own count, kept live. */
  onOpenCount: (n: number) => void;
}) {
  const [show, setShow] = React.useState<ChatShow>(initialKey ? "all" : "open");
  const [q, setQ] = React.useState("");
  const [list, setList] = React.useState<List>(initial);
  const [openKey, setOpenKey] = React.useState<string | null>(
    initialKey ?? initial.rows[0]?.key ?? null,
  );
  const [thread, setThread] = React.useState<Thread | null>(null);
  const [mode, setMode] = React.useState<Mode>("connecting");
  /** Advanced on every read, so the 24-hour window is judged against a clock that moves. */
  const [clockMs, setClockMs] = React.useState(serverNow);

  // The newest filter and open thread, for callbacks that outlive a render.
  const showRef = React.useRef(show);
  const qRef = React.useRef(q);
  const openRef = React.useRef(openKey);
  React.useEffect(() => {
    showRef.current = show;
    qRef.current = q;
    openRef.current = openKey;
  }, [show, q, openKey]);

  const loadList = React.useCallback(
    () =>
      fetch(
        `/api/whatsapp/conversations?show=${showRef.current}&q=${encodeURIComponent(qRef.current)}`,
        {
          cache: "no-store",
        },
      )
        .then((res) => (res.ok ? (res.json() as Promise<List>) : null))
        .then((next) => {
          if (!next) return;
          setList(next);
          onOpenCount(next.openCount);
          setClockMs(Date.now());
        })
        .catch(() => {
          /* The next event or poll asks again. */
        }),
    [onOpenCount],
  );

  const loadThread = React.useCallback(
    (key: string | null) =>
      !key
        ? Promise.resolve()
        : fetch(`/api/whatsapp/thread?key=${encodeURIComponent(key)}`, {
            cache: "no-store",
          })
            .then((res) => (res.ok ? (res.json() as Promise<Thread>) : null))
            .then((next) => {
              // Only the thread still open may land: a slow answer for one
              // somebody has since clicked away from must not replace it.
              if (openRef.current !== key) return;
              setThread(next);
              setClockMs(Date.now());
            })
            .catch(() => {
              /* Left as it was. */
            }),
    [],
  );

  // The open thread, read whenever it changes. The URL follows it so a
  // conversation can be linked to and survives a reload.
  React.useEffect(() => {
    if (!openKey) return;
    void loadThread(openKey);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "replies");
      url.searchParams.set("chat", openKey);
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      /* Not worth failing over. */
    }
  }, [openKey, loadThread]);

  // The list, re-read when its filters change (the search after typing settles).
  React.useEffect(() => {
    const t = setTimeout(() => void loadList(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [show, q, loadList]);

  // THE LIVE CONNECTION. One stream for the life of the tab; a fallback poll
  // if it cannot be held. Torn down and rebuilt together on unmount.
  React.useEffect(() => {
    let stopped = false;
    let source: EventSource | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;

    const refreshFor = (key: string | null) => {
      // A burst — a message and its delivered tick a second apart — is one re-read.
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        void loadList();
        if (!key || key === openRef.current) void loadThread(openRef.current);
      }, 250);
    };

    const startPolling = () => {
      if (stopped || poll) return;
      source?.close();
      source = null;
      setMode("polling");
      poll = setInterval(() => {
        if (!document.hidden) refreshFor(null);
      }, POLL_MS);
    };

    const open = () => {
      if (stopped) return;
      setMode("connecting");
      const es = new EventSource("/api/whatsapp/stream");
      source = es;
      grace = setTimeout(startPolling, GRACE_MS);
      es.addEventListener("hello", () => {
        if (grace) clearTimeout(grace);
        grace = null;
        setMode("live");
        // Anything that moved while we were connecting.
        refreshFor(null);
      });
      es.addEventListener("wa", (ev) => {
        try {
          refreshFor(
            (JSON.parse((ev as MessageEvent).data) as { key: string }).key,
          );
        } catch {
          refreshFor(null);
        }
      });
      // The server ends every stream after a few minutes on purpose; the
      // browser reopens it by itself, and the hello on the far side re-reads.
      es.addEventListener("bye", () => setMode("connecting"));
      es.onerror = () => {
        if (!poll) setMode("connecting");
      };
    };

    open();
    const onFocus = () => refreshFor(null);
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      if (grace) clearTimeout(grace);
      if (poll) clearInterval(poll);
      if (pending) clearTimeout(pending);
      source?.close();
      window.removeEventListener("focus", onFocus);
    };
  }, [loadList, loadThread]);

  // A chat fills the window, as a chat app does: the box is sized to the
  // viewport and brought to the top of it, so the message box at the bottom is
  // always on screen rather than below the page's own header and figures.
  const frame = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    frame.current?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <div ref={frame} className="scroll-mt-3">
      <Card className="overflow-hidden">
        <div className="grid h-[calc(100vh-96px)] min-h-[460px] grid-cols-[minmax(280px,360px)_1fr]">
          {/* ------------------------------------------------ conversation list */}
          <div className="flex min-h-0 flex-col border-r border-line">
            <div className="space-y-2 border-b border-line px-3 py-2.5">
              <div className="flex flex-wrap gap-1.5">
                {[
                  {
                    key: "open" as const,
                    label: `Needs reply · ${list.openCount}`,
                  },
                  { key: "all" as const, label: "Last 30 days" },
                  ...(list.seesUnknown
                    ? [{ key: "unknown" as const, label: "Unknown numbers" }]
                    : []),
                ].map((o) => (
                  <button
                    key={o.key}
                    onClick={() => setShow(o.key)}
                    className={cx(
                      "h-7 cursor-pointer rounded-[4px] border px-2 text-[12px]",
                      show === o.key
                        ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                        : "border-line bg-surface text-body hover:bg-canvas",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, number or message"
                className="h-8"
              />
              <div className="flex items-center gap-1.5 text-[11px] text-muted">
                <span
                  className={cx(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    mode === "live"
                      ? "bg-success"
                      : mode === "polling"
                        ? "bg-warn"
                        : "bg-line-strong",
                  )}
                />
                {mode === "live"
                  ? "Live — new messages appear by themselves"
                  : mode === "polling"
                    ? "Checking every 15 seconds — the live connection is not available"
                    : "Connecting…"}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {list.rows.length ? (
                list.rows.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => setOpenKey(c.key)}
                    className={cx(
                      "block w-full cursor-pointer border-b border-divider px-3 py-2.5 text-left hover:bg-canvas",
                      openKey === c.key ? "bg-brand-soft/60" : "",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                        {c.name}
                      </span>
                      <span className="flex-none text-[11px] text-muted">
                        {shortWhen(c.lastAt, businessDay)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span
                        className={cx(
                          "min-w-0 flex-1 truncate text-[12px]",
                          c.unanswered ? "text-ink" : "text-muted",
                        )}
                      >
                        {c.lastFromThem ? "" : "You: "}
                        {previewOf(c.lastText, 80)}
                      </span>
                      {c.unanswered ? (
                        <span className="flex h-5 min-w-5 flex-none items-center justify-center rounded-full bg-success px-1.5 text-[11px] font-medium text-white">
                          {c.unanswered}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted">
                      {!c.customerId
                        ? "Unknown number · not a customer or lead"
                        : [
                            c.kind === "lead" ? "Lead" : null,
                            c.thirdParty ? "Third party" : null,
                            showAssignee
                              ? c.assignedToName
                                ? `${c.assignedToName}'s`
                                : "Unassigned"
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                    </div>
                  </button>
                ))
              ) : (
                <p className="px-4 py-8 text-center text-[13px] text-muted">
                  {q
                    ? "No conversation matches that search."
                    : show === "open"
                      ? "Nobody is waiting for a reply."
                      : show === "unknown"
                        ? "No messages from unknown numbers."
                        : "No conversations in the last 30 days."}
                </p>
              )}
              {list.capped ? (
                <p className="px-3 py-2 text-[11px] text-muted">
                  Showing the newest 200 — search to find an older one.
                </p>
              ) : null}
            </div>
            <div className="border-t border-line px-3 py-1.5 text-[11px] text-muted">
              {scopeLabel}
            </div>
          </div>

          {/* ----------------------------------------------------------- thread */}
          {openKey && thread && thread.key === openKey ? (
            <ThreadPane
              key={openKey}
              thread={thread}
              today={businessDay}
              now={clockMs}
              showAssignee={showAssignee}
              onChanged={() => {
                void loadThread(openKey);
                void loadList();
              }}
            />
          ) : (
            <div className="flex items-center justify-center">
              {openKey ? (
                <span className="text-[13px] text-muted">
                  Opening the conversation…
                </span>
              ) : (
                <EmptyState
                  title="Pick a conversation"
                  body="Every customer who has written to the business number is on the left, newest first."
                />
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

/** "10:42 am" today, "Yesterday", or "28 Sep" — a list cell, not a sentence. */
function shortWhen(at: string, businessDay: string): string {
  const d = new Date(at);
  const day = calendarDate(d);
  if (day === businessDay) return clock(d);
  if (day === addDays(businessDay as BusinessDate, -1)) return "Yesterday";
  return shortDate(day);
}

function ThreadPane({
  thread: t,
  today: businessDay,
  now,
  showAssignee,
  onChanged,
}: {
  thread: Thread;
  today: string;
  now: number;
  showAssignee: boolean;
  onChanged: () => void;
}) {
  const { run: act, push } = useToast();
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState<string | null>(null);
  // One key per message typed, so a double press sends it once.
  const [composeKey, setComposeKey] = React.useState(() => crypto.randomUUID());
  const scroller = React.useRef<HTMLDivElement>(null);

  const ends = t.windowEndsAt ? new Date(t.windowEndsAt) : null;
  const windowOpen = ends !== null && ends.getTime() > now;
  const canType = !t.blockedWhy && windowOpen;

  // Stay at the newest message, as a chat does — when it opens and whenever
  // something new arrives.
  React.useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [t.events.length, sending]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(body);
    setText("");
    try {
      const r = await sendChatMessage({
        key: t.key,
        text: body,
        idempotencyKey: composeKey,
      });
      if (!r.ok) {
        // Keep the words: a refused message is retyped by nobody.
        setText(body);
        push(r.error, "error");
      }
      setComposeKey(crypto.randomUUID());
      onChanged();
    } finally {
      setSending(null);
    }
  };

  // Which messages start a new day, worked out once rather than by a variable
  // carried through the render.
  const days = t.events.map((e) => calendarDate(new Date(e.at)));
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-medium text-ink">{t.name}</span>
            {!t.customerId ? (
              <Badge tone="danger">
                Unknown number · not a customer or lead
              </Badge>
            ) : t.kind === "lead" ? (
              <Badge tone="brand">Lead</Badge>
            ) : null}
            {t.thirdParty ? <Badge tone="neutral">Third party</Badge> : null}
          </div>
          <div className="text-[12px] text-muted">
            {t.number
              ? phoneDisplay(t.number.replace(/\D/g, "").slice(-10))
              : "No number"}
            {showAssignee && t.customerId
              ? ` · ${t.assignedToName ? `${t.assignedToName}'s customer` : "Unassigned"}`
              : ""}
          </div>
        </div>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            const r = await act(markThreadHandled(t.key, t.unanswered > 0));
            if (r.ok) onChanged();
          }}
        >
          {t.unanswered > 0
            ? `Mark handled · ${t.unanswered}`
            : "Mark as needing a reply"}
        </Button>
        {t.customerId ? (
          <Link
            href={`/crm/customers/${t.customerId}`}
            className="inline-flex h-7 items-center rounded-[4px] border border-line px-2.5 text-[13px] text-body no-underline hover:bg-canvas"
          >
            Open record
          </Link>
        ) : null}
      </div>

      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-canvas px-4 py-3"
      >
        {t.events.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-muted">
            No messages yet.
          </p>
        ) : null}
        {t.events.map((e, i) => {
          const day = days[i];
          const separator = i === 0 || day !== days[i - 1];
          return (
            <React.Fragment key={e.id}>
              {separator ? (
                <div className="py-2 text-center">
                  <span className="rounded-full bg-surface px-2.5 py-0.5 text-[11px] text-muted shadow-sm">
                    {day === businessDay
                      ? "Today"
                      : day === addDays(businessDay as BusinessDate, -1)
                        ? "Yesterday"
                        : shortDate(day)}
                  </span>
                </div>
              ) : null}
              <div
                className={cx(
                  "flex",
                  e.fromThem ? "justify-start" : "justify-end",
                )}
              >
                <div
                  className={cx(
                    "max-w-[72%] rounded-[8px] border px-3 py-1.5 shadow-sm",
                    e.fromThem
                      ? "rounded-tl-[2px] border-line bg-surface"
                      : "rounded-tr-[2px] border-line bg-success-soft",
                  )}
                >
                  {!e.fromThem &&
                  e.templateName &&
                  e.templateName !== "Reply" ? (
                    <div className="mb-0.5 text-[11px] font-medium text-muted">
                      {e.templateName}
                    </div>
                  ) : null}
                  {e.media ? (
                    <div className="mt-0.5 mb-1">
                      <ReplyMedia type={e.media.type} url={e.media.url} pdf={e.media.pdf} caption={e.text} />
                    </div>
                  ) : null}
                  {/* A file with no caption has only its label for words, which the file itself already says. */}
                  {e.media && (e.text === MEDIA_LABEL[e.media.type as MediaType] || e.media.type === "document") ? null : (
                    <p className="text-sm whitespace-pre-wrap text-ink">{e.text}</p>
                  )}
                  <div className="mt-0.5 flex flex-wrap items-center justify-end gap-1.5 text-[11px] text-muted">
                    {e.fromThem ? null : (
                      <span>{e.viaRule ? "Automatic rule" : (e.by ?? "")}</span>
                    )}
                    <span>{clock(new Date(e.at))}</span>
                    {e.receipts ? (
                      <DeliveryStatus m={e.receipts} showTime={false} />
                    ) : null}
                  </div>
                </div>
              </div>
            </React.Fragment>
          );
        })}
        {sending ? (
          <div className="flex justify-end">
            <div className="max-w-[72%] rounded-[8px] rounded-tr-[2px] border border-line bg-success-soft px-3 py-1.5 opacity-70">
              <p className="text-sm whitespace-pre-wrap text-ink">{sending}</p>
              <div className="mt-0.5 text-right text-[11px] text-muted">
                Sending…
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t border-line px-4 py-2.5">
        {t.blockedWhy ? (
          <p className="text-[13px] text-muted">{t.blockedWhy}</p>
        ) : !windowOpen ? (
          <p className="text-[13px] text-muted">
            {ends
              ? `WhatsApp only allows free text within 24 hours of the customer's last message, and that closed ${inline(whenLabel(ends.toISOString(), businessDay))}.`
              : "They have not written to us, so WhatsApp only allows an approved template."}
            {t.customerId ? (
              <>
                {" "}
                <Link
                  href={`/crm/whatsapp?customer=${t.customerId}`}
                  className="text-brand no-underline"
                >
                  Send an approved template →
                </Link>
              </>
            ) : null}
          </p>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <VoiceTextarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onDictate={setText}
                  onKeyDown={(e) => {
                    // Enter sends and Shift+Enter is a new line, as in every chat app.
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  maxLength={4000}
                  rows={2}
                  className="min-h-[44px]"
                  placeholder="Type a message — Enter to send, Shift+Enter for a new line"
                  disabled={!canType}
                />
              </div>
              <Button
                variant="primary"
                disabled={!text.trim() || Boolean(sending)}
                onClick={() => void send()}
              >
                Send
              </Button>
            </div>
            <div className="mt-1 text-[11px] text-muted">
              From the business number · free text until{" "}
              {ends ? inline(whenLabel(ends.toISOString(), businessDay)) : "-"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** "Today, 9 am" mid-sentence is "today, 9 am"; "29 Sep" keeps its capital. */
function inline(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
