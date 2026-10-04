"use client";

import * as React from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { RowMenu } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import { markThreadHandled, sendChatMessage } from "@/lib/actions/crm";
import { addDays, calendarDate, type BusinessDate } from "@/lib/business-date";
import { clock, phoneDisplay, shortDate } from "@/lib/format";
import { previewOf, whenLabel } from "@/lib/whatsapp-status";
import { MEDIA_LABEL, type MediaType } from "@/lib/whatsapp-delivery";
import { ReplyMedia } from "./reply-media";
import { ImageViewer, type ViewerImage } from "./image-viewer";
import type {
  ChatShow,
  Conversation,
  Thread,
} from "@/lib/services/whatsapp-chat-service";

/* ---------------------------------------------------------------------------
 * WHATSAPP, LAID OUT LIKE WHATSAPP WEB.
 *
 * The screen is the window. Nothing on the page scrolls: the chat list scrolls
 * in its own column, the open conversation scrolls in its own pane, and the
 * message box stays at the bottom — the way every telecaller already uses
 * WhatsApp on their own phone and laptop, so there is nothing to learn.
 *
 * Left: who we are talking to — every customer who wrote to us and every one
 * we messaged, newest first, with an unread count and the ticks on our last
 * message. Right: the conversation, or one of the screen's tools (a new
 * message from a template, a send run, the templates, the log), opened from
 * the left column's header the way WhatsApp opens New chat and Settings.
 *
 * LIVE, NOT REFRESHED. One Server-Sent Events stream (`/api/whatsapp/stream`)
 * says which conversation moved — a customer wrote, a tick arrived, a
 * colleague answered — and this re-reads the list and, if it is the one open,
 * the thread. A stream that cannot be held falls back to asking every fifteen
 * seconds, and the footer says which. Every read goes through the scoped
 * endpoints; the stream never carries words.
 * ------------------------------------------------------------------------- */

type List = {
  rows: Conversation[];
  openCount: number;
  seesUnknown: boolean;
  capped: boolean;
};
type Mode = "live" | "connecting" | "polling";

/** The tools that open in the right-hand pane instead of a conversation. */
export type WaTool = "send" | "run" | "templates" | "log";
const TOOL_TITLE: Record<WaTool, string> = {
  send: "New message",
  run: "Send run",
  templates: "Templates",
  log: "Message log",
};

const POLL_MS = 15_000;
/** How long a fresh stream has to say hello before it is not worth waiting on. */
const GRACE_MS = 8_000;

/** WhatsApp's own colours, so the screen reads as WhatsApp at a glance. */
const WA = {
  panel: "bg-[#f0f2f5]",
  wallpaper: "bg-[#efeae2]",
  outgoing: "bg-[#d9fdd3]",
  accent: "bg-[#00a884]",
  accentText: "text-[#008069]",
  read: "text-[#53bdeb]",
};

export function ChatTab({
  canWrite,
  recordHref,
  initial,
  initialKey,
  initialTool,
  today: businessDay,
  now: serverNow,
  scopeLabel,
  showAssignee,
  onOpenCount,
  headerExtra,
  notices,
  renderTool,
}: {
  /** False for the Read level: the chats and the log, and no way to answer. */
  canWrite: boolean;
  /** Where "Open record" goes — the CRM record, or the Accounts ledger. */
  recordHref: (customerId: string) => string;
  initial: List;
  /** The conversation named in the URL (`?chat=`), opened on arrival. */
  initialKey: string | null;
  /** A tool named in the URL (`?tab=send` and so on), opened on arrival. */
  initialTool: WaTool | null;
  today: string;
  /** The server's clock at render — the clock is never read during render. */
  now: number;
  scopeLabel: string;
  showAssignee: boolean;
  /** The unread count, for anything outside this screen that shows it. */
  onOpenCount: (n: number) => void;
  /** Beside the title in the left header: the API-on / manual indicator. */
  headerExtra: React.ReactNode;
  /** Slim bars under the header: a copy awaiting confirmation, sends failing. */
  notices: React.ReactNode;
  /** A tool's body. `customerId` preselects who a new message is for. */
  renderTool: (tool: WaTool, customerId: string | null) => React.ReactNode;
}) {
  const [show, setShow] = React.useState<ChatShow>("all");
  const [q, setQ] = React.useState("");
  const [list, setList] = React.useState<List>(initial);
  const [openKey, setOpenKey] = React.useState<string | null>(initialTool ? null : initialKey);
  const [tool, setTool] = React.useState<{ tool: WaTool; customerId: string | null } | null>(
    initialTool ? { tool: initialTool, customerId: null } : null,
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

  // The open thread, read whenever it changes.
  React.useEffect(() => {
    if (!openKey) return;
    void loadThread(openKey);
  }, [openKey, loadThread]);

  // The address follows what is open, so a conversation or a tool can be
  // linked to and survives a reload.
  React.useEffect(() => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("customer");
      if (tool) {
        url.searchParams.set("tab", tool.tool);
        url.searchParams.delete("chat");
      } else {
        url.searchParams.set("tab", "replies");
        if (openKey) url.searchParams.set("chat", openKey);
        else url.searchParams.delete("chat");
      }
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      /* Not worth failing over. */
    }
  }, [openKey, tool]);

  const openChat = (key: string) => {
    setTool(null);
    setOpenKey(key);
  };
  const openTool = (t: WaTool, customerId: string | null = null) => setTool({ tool: t, customerId });

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

  return (
    // The whole of the screen, and nothing past it: the page never scrolls,
    // only the list and the conversation inside it.
    <div className="absolute inset-0 flex overflow-hidden border-t border-line bg-[#d1d7db]">
      {/* ------------------------------------------------------------ chats */}
      <aside className="flex w-[30%] max-w-[440px] min-w-[320px] flex-col border-r border-[#d1d7db] bg-white">
        <div className={cx("flex h-[59px] flex-none items-center gap-2 px-4", WA.panel)}>
          <span className={cx("flex h-10 w-10 flex-none items-center justify-center rounded-full text-[15px] font-semibold text-white", WA.accent)}>
            M
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium text-[#111b21]">WhatsApp</div>
            <div className="truncate">{headerExtra}</div>
          </div>
          {canWrite ? (
            <IconButton title="New message from a template" onClick={() => openTool("send")}>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
                <path d="M19.005 3.175H4.674C3.642 3.175 3 3.789 3 4.821V21.02l3.544-3.514h12.461c1.033 0 2.064-1.06 2.064-2.093V4.821c-.001-1.032-1.032-1.646-2.064-1.646zm-4.989 9.869H7.041V11.1h6.975v1.944zm3-4H7.041V7.1h9.975v1.944z" />
              </svg>
            </IconButton>
          ) : null}
          <RowMenu
            items={
              canWrite
                ? [
                    { label: "New message", onSelect: () => openTool("send") },
                    { label: "Send run", onSelect: () => openTool("run") },
                    { label: "Templates", onSelect: () => openTool("templates") },
                    { label: "Message log", onSelect: () => openTool("log") },
                  ]
                : [{ label: "Message log", onSelect: () => openTool("log") }]
            }
          />
        </div>

        {notices}

        <div className="flex-none space-y-2 border-b border-[#e9edef] px-3 py-2">
          <label className={cx("flex h-9 items-center gap-3 rounded-lg px-3", WA.panel)}>
            <svg viewBox="0 0 24 24" className="h-4 w-4 flex-none text-[#54656f]" fill="currentColor" aria-hidden>
              <path d="M15.009 13.805h-.636l-.22-.219a5.184 5.184 0 0 0 1.256-3.386 5.207 5.207 0 1 0-5.207 5.208 5.183 5.183 0 0 0 3.385-1.255l.221.22v.635l4.004 3.999 1.194-1.195-3.997-4.007zm-4.808 0a3.605 3.605 0 1 1 0-7.21 3.605 3.605 0 0 1 0 7.21z" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, number or message"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-[#111b21] outline-none placeholder:text-[#667781]"
            />
            {q ? (
              <button onClick={() => setQ("")} className="cursor-pointer text-[#54656f]" aria-label="Clear search">
                ✕
              </button>
            ) : null}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {[
              { key: "all" as const, label: "All" },
              { key: "open" as const, label: list.openCount ? `Needs reply ${list.openCount}` : "Needs reply" },
              ...(list.seesUnknown ? [{ key: "unknown" as const, label: "Unknown numbers" }] : []),
            ].map((o) => (
              <button
                key={o.key}
                onClick={() => setShow(o.key)}
                className={cx(
                  "h-8 cursor-pointer rounded-full px-3 text-[13px]",
                  show === o.key ? "bg-[#e7fce3] font-medium text-[#008069]" : "bg-[#f0f2f5] text-[#54656f] hover:bg-[#e9edef]",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.rows.length ? (
            list.rows.map((c) => (
              <ChatRow
                key={c.key}
                c={c}
                active={!tool && openKey === c.key}
                today={businessDay}
                showAssignee={showAssignee}
                onOpen={() => openChat(c.key)}
              />
            ))
          ) : (
            <p className="px-6 py-10 text-center text-[14px] text-[#667781]">
              {q
                ? "No chat matches that search."
                : show === "open"
                  ? "Nobody is waiting for a reply."
                  : show === "unknown"
                    ? "No messages from unknown numbers."
                    : "No chats in the last 30 days."}
            </p>
          )}
          {list.capped ? (
            <p className="px-4 py-3 text-center text-[12px] text-[#667781]">Showing the newest 200 — search to find an older one.</p>
          ) : null}
        </div>

        <div className="flex flex-none items-center gap-1.5 border-t border-[#e9edef] px-4 py-2 text-[11px] text-[#667781]">
          <span
            className={cx(
              "inline-block h-1.5 w-1.5 rounded-full",
              mode === "live" ? "bg-[#00a884]" : mode === "polling" ? "bg-warn" : "bg-line-strong",
            )}
          />
          <span className="truncate">
            {mode === "live"
              ? "Live — new messages appear by themselves"
              : mode === "polling"
                ? "Checking every 15 seconds"
                : "Connecting…"}{" "}
            · {scopeLabel}
          </span>
        </div>
      </aside>

      {/* ------------------------------------------------- conversation / tool */}
      <section className="flex min-w-0 flex-1 flex-col">
        {tool ? (
          <div className="flex min-h-0 flex-1 flex-col bg-canvas">
            <div className={cx("flex h-[59px] flex-none items-center gap-3 border-l border-[#d1d7db] px-4", WA.panel)}>
              <IconButton title="Back to the chats" onClick={() => setTool(null)}>
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
                  <path d="M12 4l1.4 1.4L7.8 11H20v2H7.8l5.6 5.6L12 20l-8-8 8-8z" />
                </svg>
              </IconButton>
              <span className="text-[16px] font-medium text-[#111b21]">{TOOL_TITLE[tool.tool]}</span>
            </div>
            {/* Its own scroll, like the conversation it replaces. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {renderTool(tool.tool, tool.customerId)}
            </div>
          </div>
        ) : openKey && thread && thread.key === openKey ? (
          <ThreadPane
            key={openKey}
            thread={thread}
            today={businessDay}
            now={clockMs}
            showAssignee={showAssignee}
            canWrite={canWrite}
            recordHref={recordHref}
            onTemplate={(customerId) => openTool("send", customerId)}
            onChanged={() => {
              void loadThread(openKey);
              void loadList();
            }}
          />
        ) : openKey ? (
          <div className={cx("flex flex-1 items-center justify-center", WA.wallpaper)}>
            <span className="rounded-lg bg-white/80 px-3 py-1.5 text-[13px] text-[#54656f] shadow-sm">Opening the chat…</span>
          </div>
        ) : (
          <Welcome onNew={canWrite ? () => openTool("send") : null} />
        )}
      </section>
    </div>
  );
}

/** What the right pane shows with nothing open — WhatsApp Web's own resting screen. */
function Welcome({ onNew }: { onNew: (() => void) | null }) {
  return (
    <div className={cx("flex flex-1 flex-col items-center justify-center border-b-[6px] border-[#25d366] px-10 text-center", WA.panel)}>
      <div className={cx("flex h-20 w-20 items-center justify-center rounded-full text-3xl font-semibold text-white", WA.accent)}>M</div>
      <h2 className="mt-6 text-[28px] font-light text-[#41525d]">MahekOne for WhatsApp</h2>
      {onNew ? (
        <>
          <p className="mt-3 max-w-[460px] text-[14px] leading-6 text-[#667781]">
            Send and receive from the business number. Pick a chat on the left, or start one from an
            approved template.
          </p>
          <button
            onClick={onNew}
            className={cx("mt-6 h-10 cursor-pointer rounded-full px-6 text-[14px] font-medium text-white hover:opacity-90", WA.accent)}
          >
            New message
          </button>
        </>
      ) : (
        <p className="mt-3 max-w-[460px] text-[14px] leading-6 text-[#667781]">
          Pick a chat on the left to read it. Your access is read only, so replying and sending are not
          part of it.
        </p>
      )}
      <p className="mt-10 text-[12px] text-[#8696a0]">Every message is logged against the customer record, whichever way it is sent.</p>
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-10 w-10 flex-none cursor-pointer items-center justify-center rounded-full text-[#54656f] hover:bg-black/5"
    >
      {children}
    </button>
  );
}

/** A coloured circle with initials — the photograph WhatsApp would draw. */
function Avatar({ name, seed, size = 49 }: { name: string; seed: string; size?: number }) {
  const palette = ["#25d366", "#53bdeb", "#ff7f50", "#a17fe0", "#f59e0b", "#06b6d4", "#e879a6", "#64748b"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
  return (
    <span
      className="flex flex-none items-center justify-center rounded-full font-medium text-white"
      style={{ width: size, height: size, background: palette[h % palette.length], fontSize: size * 0.36 }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

/** The ticks WhatsApp draws on our own messages: ✓ sent, ✓✓ delivered, blue ✓✓ read. */
function Ticks({ status, className }: { status: string | null; className?: string }) {
  if (!status) return null;
  const read = status === "read";
  const double = read || status === "delivered";
  if (status === "failed") return <span className={cx("font-semibold text-danger", className)} title="Not delivered">!</span>;
  if (status === "queued" || status === "copied" || status === "prepared")
    return <span className={cx("text-[#8696a0]", className)} title={status === "copied" ? "Copied, not confirmed" : "Sending"}>◷</span>;
  return (
    <span className={cx(read ? WA.read : "text-[#8696a0]", "tracking-[-0.3em]", className)} title={read ? "Read" : double ? "Delivered" : "Sent"}>
      {double ? "✓✓" : "✓"}
    </span>
  );
}

function ChatRow({
  c,
  active,
  today: businessDay,
  showAssignee,
  onOpen,
}: {
  c: Conversation;
  active: boolean;
  today: string;
  showAssignee: boolean;
  onOpen: () => void;
}) {
  const tag = !c.customerId
    ? "Unknown number"
    : [c.kind === "lead" ? "Lead" : null, c.thirdParty ? "Third party" : null, showAssignee ? (c.assignedToName ?? "Unassigned") : null]
        .filter(Boolean)
        .join(" · ");
  return (
    <button
      onClick={onOpen}
      className={cx(
        "flex w-full cursor-pointer items-center gap-3 pl-3 text-left",
        active ? "bg-[#f0f2f5]" : "hover:bg-[#f5f6f6]",
      )}
    >
      <Avatar name={c.name} seed={c.key} />
      <div className="min-w-0 flex-1 border-b border-[#e9edef] py-3 pr-4">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[16px] text-[#111b21]">{c.name}</span>
          <span className={cx("flex-none text-[12px]", c.unanswered ? "font-medium text-[#1fa855]" : "text-[#667781]")}>
            {shortWhen(c.lastAt, businessDay)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          {c.lastFromThem ? null : <Ticks status={c.lastStatus} className="text-[13px]" />}
          <span className={cx("min-w-0 flex-1 truncate text-[14px]", c.unanswered ? "text-[#111b21]" : "text-[#667781]")}>
            {previewOf(c.lastText, 90)}
          </span>
          {c.unanswered ? (
            <span className="flex h-5 min-w-5 flex-none items-center justify-center rounded-full bg-[#25d366] px-1.5 text-[12px] font-medium text-white">
              {c.unanswered}
            </span>
          ) : null}
        </div>
        {tag ? <div className="mt-0.5 truncate text-[12px] text-[#8696a0]">{tag}</div> : null}
      </div>
    </button>
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
  canWrite,
  recordHref,
  onTemplate,
  onChanged,
}: {
  thread: Thread;
  today: string;
  now: number;
  showAssignee: boolean;
  canWrite: boolean;
  recordHref: (customerId: string) => string;
  /** Opens New message with this customer picked — the way past a closed window. */
  onTemplate: (customerId: string) => void;
  onChanged: () => void;
}) {
  const { run: act, push } = useToast();
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState<string | null>(null);
  // One key per message typed, so a double press sends it once.
  const [composeKey, setComposeKey] = React.useState(() => crypto.randomUUID());
  const scroller = React.useRef<HTMLDivElement>(null);

  // Every photograph in the conversation, in order, so the viewer can step
  // from one to the next — a slip and the cheque sent after it, side by side.
  const photos = React.useMemo(() => {
    const list: Array<ViewerImage & { eventId: string }> = [];
    for (const e of t.events) {
      if (e.media?.type !== "image") continue;
      list.push({
        eventId: e.id,
        url: e.media.url,
        caption: e.text && e.text !== MEDIA_LABEL["image" as MediaType] ? e.text : null,
        meta: `${e.fromThem ? t.name : e.viaRule ? "Automatic rule" : (e.by ?? "Mahek")} · ${whenLabel(e.at, businessDay)}`,
      });
    }
    return list;
  }, [t.events, t.name, businessDay]);
  const [viewing, setViewing] = React.useState<number | null>(null);

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
      const r = await sendChatMessage({ key: t.key, text: body, idempotencyKey: composeKey });
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

  // Which messages start a new day, and which start a run from one side —
  // only the first of a run carries the bubble's tail, as WhatsApp draws it.
  const days = t.events.map((e) => calendarDate(new Date(e.at)));
  const subline = [
    t.number ? phoneDisplay(t.number.replace(/\D/g, "").slice(-10)) : null,
    !t.customerId ? "Unknown number — not a customer or lead" : t.kind === "lead" ? "Lead" : null,
    t.thirdParty ? "Third party" : null,
    showAssignee && t.customerId ? (t.assignedToName ? `${t.assignedToName}'s customer` : "Unassigned") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // The box grows with what is typed, up to six lines, as WhatsApp's does.
  const rows = Math.min(6, Math.max(1, text.split("\n").length));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {viewing !== null && photos[viewing] ? (
        <ImageViewer images={photos} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
      ) : null}

      <header className={cx("flex h-[59px] flex-none items-center gap-3 border-l border-[#d1d7db] px-4", WA.panel)}>
        <Avatar name={t.name} seed={t.key} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] text-[#111b21]">{t.name}</div>
          <div className="truncate text-[13px] text-[#667781]">{subline}</div>
        </div>
        {canWrite ? (
          <button
            onClick={async () => {
              const r = await act(markThreadHandled(t.key, t.unanswered > 0));
              if (r.ok) onChanged();
            }}
            className="h-8 cursor-pointer rounded-full px-3 text-[13px] text-[#54656f] hover:bg-black/5"
            title={t.unanswered > 0 ? "Nothing more is owed here" : "Put it back on Needs reply"}
          >
            {t.unanswered > 0 ? `✓ Mark handled (${t.unanswered})` : "Mark as needing a reply"}
          </button>
        ) : null}
        {t.customerId ? (
          <Link
            href={recordHref(t.customerId)}
            className="h-8 rounded-full px-3 text-[13px] leading-8 text-[#54656f] no-underline hover:bg-black/5"
          >
            Open record
          </Link>
        ) : null}
      </header>

      {/* The conversation: its own scroll, on WhatsApp's wallpaper. */}
      <div ref={scroller} className={cx("min-h-0 flex-1 overflow-y-auto px-[6%] py-3", WA.wallpaper)}>
        {t.events.length === 0 ? (
          <div className="py-8 text-center">
            <span className="rounded-lg bg-[#fff5c4] px-3 py-1.5 text-[12.5px] text-[#54656f] shadow-sm">No messages yet.</span>
          </div>
        ) : null}
        {t.events.map((e, i) => {
          const day = days[i];
          const newDay = i === 0 || day !== days[i - 1];
          const firstOfRun = newDay || t.events[i - 1].fromThem !== e.fromThem;
          const bare = e.media && (e.text === MEDIA_LABEL[e.media.type as MediaType] || e.media.type === "document");
          return (
            <React.Fragment key={e.id}>
              {newDay ? (
                <div className="flex justify-center py-2">
                  <span className="rounded-lg bg-white px-3 py-1.5 text-[12.5px] text-[#54656f] uppercase shadow-sm">
                    {day === businessDay
                      ? "Today"
                      : day === addDays(businessDay as BusinessDate, -1)
                        ? "Yesterday"
                        : shortDate(day)}
                  </span>
                </div>
              ) : null}
              <div className={cx("flex", e.fromThem ? "justify-start" : "justify-end", firstOfRun ? "mt-2.5" : "mt-0.5")}>
                <div
                  className={cx(
                    "relative max-w-[65%] rounded-lg px-2 pt-1.5 pb-1 text-[14.2px] leading-[19px] text-[#111b21] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]",
                    e.fromThem ? "bg-white" : WA.outgoing,
                    firstOfRun && (e.fromThem ? "rounded-tl-none" : "rounded-tr-none"),
                  )}
                >
                  {!e.fromThem && e.templateName && e.templateName !== "Reply" ? (
                    <div className={cx("mb-0.5 text-[12px] font-medium", WA.accentText)}>{e.templateName}</div>
                  ) : null}
                  {e.media ? (
                    <div className="mb-1">
                      <ReplyMedia
                        type={e.media.type}
                        url={e.media.url}
                        pdf={e.media.pdf}
                        caption={e.text}
                        onOpen={
                          e.media.type === "image"
                            ? () => setViewing(photos.findIndex((p) => p.eventId === e.id))
                            : undefined
                        }
                      />
                    </div>
                  ) : null}
                  {/* The time sits inside the bubble, after the words, as WhatsApp sets it. */}
                  {bare ? null : <span className="px-0.5 whitespace-pre-wrap">{e.text}</span>}
                  <span className="float-right mt-1.5 ml-3 flex items-center gap-1 text-[11px] leading-none text-[#667781]">
                    {e.fromThem ? null : <span className="max-w-[140px] truncate">{e.viaRule ? "Automatic rule" : (e.by ?? "")}</span>}
                    <span>{clock(new Date(e.at))}</span>
                    {e.receipts ? <Ticks status={e.receipts.status} /> : null}
                  </span>
                  <span className="clear-both block" />
                </div>
              </div>
            </React.Fragment>
          );
        })}
        {sending ? (
          <div className="mt-0.5 flex justify-end">
            <div className={cx("max-w-[65%] rounded-lg px-2 pt-1.5 pb-1 text-[14.2px] text-[#111b21] shadow-sm", WA.outgoing)}>
              <span className="whitespace-pre-wrap">{sending}</span>
              <span className="float-right mt-1.5 ml-3 text-[11px] leading-none text-[#667781]">◷</span>
              <span className="clear-both block" />
            </div>
          </div>
        ) : null}
      </div>

      {/* The message bar. */}
      <footer className={cx("flex-none px-4 py-2.5", WA.panel)}>
        {!canWrite ? (
          /* Said rather than left as a missing box: an absent composer reads
             as a broken screen, and this is a decision somebody made. */
          <p className="py-2 text-center text-[13px] text-[#54656f]">
            Your access to WhatsApp is read only — you can read this conversation but not reply.
          </p>
        ) : t.blockedWhy ? (
          <p className="py-2 text-center text-[13px] text-[#54656f]">{t.blockedWhy}</p>
        ) : !windowOpen ? (
          <div className="flex items-center justify-center gap-3 py-1.5 text-center text-[13px] text-[#54656f]">
            <span>
              {ends
                ? `WhatsApp only allows free text within 24 hours of the customer's last message — that closed ${inline(whenLabel(ends.toISOString(), businessDay))}.`
                : "They have not written to us, so WhatsApp only allows an approved template."}
            </span>
            {t.customerId ? (
              <button
                onClick={() => onTemplate(t.customerId!)}
                className={cx("h-8 flex-none cursor-pointer rounded-full px-4 text-[13px] font-medium text-white hover:opacity-90", WA.accent)}
              >
                Send a template
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1 rounded-lg bg-white">
                <VoiceTextarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onDictate={setText}
                  onKeyDown={(e) => {
                    // Enter sends and Shift+Enter is a new line, as in WhatsApp.
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  maxLength={4000}
                  rows={rows}
                  className="min-h-[42px] resize-none border-0 bg-white py-2.5 text-[15px] shadow-none focus:ring-0"
                  placeholder="Type a message"
                  disabled={!canType}
                />
              </div>
              <button
                onClick={() => void send()}
                disabled={!text.trim() || Boolean(sending)}
                title="Send (Enter)"
                aria-label="Send"
                className={cx(
                  "mb-0.5 flex h-[42px] w-[42px] flex-none cursor-pointer items-center justify-center rounded-full text-white disabled:cursor-default disabled:opacity-40",
                  WA.accent,
                )}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
                  <path d="M1.101 21.757 23.8 12.028 1.101 2.3l.011 7.912 13.623 1.816-13.623 1.817-.011 7.912z" />
                </svg>
              </button>
            </div>
            <div className="mt-1 px-1 text-[11px] text-[#667781]">
              From the business number · free text until {ends ? inline(whenLabel(ends.toISOString(), businessDay)) : "-"} · Shift+Enter for a new line
            </div>
          </>
        )}
      </footer>
    </div>
  );
}

/** "Today, 9 am" mid-sentence is "today, 9 am"; "29 Sep" keeps its capital. */
function inline(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
