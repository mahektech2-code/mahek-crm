"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Callout, Input } from "@/components/ui/primitives";
import { openConversation, refreshFromKapso, sendForward, sendPoster, sendText } from "@/lib/actions/studio-inbox";
import { clock, stamp, stampDate } from "@/lib/format";
import { CAPTION_MAX, STATUS_LABEL, WINDOW_CLOSED_MESSAGE, type MessageStatus } from "@/lib/studio/domain/inbox";
import type { PublicConnection } from "@/lib/studio/inbox-view";

/* The Studio's WhatsApp Inbox. The server is the source of truth: this screen
   only asks (every few seconds, and not at all while the tab is hidden) and
   shows what came back. A webhook writes the database; the poll reads it. */

type Conv = {
  id: string;
  phone: string | null;
  title: string;
  nameSource: "crm" | "whatsapp" | "number";
  customerId: string | null;
  lastMessageText: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  unread: number;
  windowOpen: boolean;
  windowClosesAt: string | null;
  blocked: "do_not_contact" | "whatsapp_dnd" | null;
};
type Msg = {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  caption: string | null;
  hasMedia: boolean;
  status: MessageStatus | null;
  errorText: string | null;
  origin: string | null;
  at: string;
  sentByName: string | null;
  posterId: string | null;
};
type Snapshot = { connection: PublicConnection; conversations: Conv[]; active: Conv | null; messages: Msg[] };
type Item = { id: string; title: string; sub?: string; thumb: string };

const POLL_MS = 4000;
const newKey = () => `k${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

const dayLabel = (iso: string) => stampDate(iso);

export function InboxApp({ initial, openId }: { initial: Snapshot; openId: string | null }) {
  const [snap, setSnap] = useState<Snapshot>(initial);
  const [openIdState, setOpenId] = useState<string | null>(openId);
  const [q, setQ] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const key = useRef(newKey());
  const endRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (openNow: string | null, query: string) => {
    try {
      const url = `/api/studio/inbox?c=${encodeURIComponent(openNow ?? "")}&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Snapshot & { ok: boolean };
      if (data.ok) setSnap({ connection: data.connection, conversations: data.conversations, active: data.active, messages: data.messages });
    } catch {
      /* A poll that fails changes nothing on screen; the next one tries again. */
    }
  }, []);

  /* Ask again a moment after the search or the open conversation changes, and every few seconds after that. A hidden tab does not ask. */
  useEffect(() => {
    const run = () => {
      if (!document.hidden) void load(openIdState, q);
    };
    const first = setTimeout(run, 250);
    const every = setInterval(run, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [q, openIdState, load]);

  const lastId = snap.messages[snap.messages.length - 1]?.id;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId, openIdState]);

  const open = async (c: Conv) => {
    setOpenId(c.id);
    setError(null);
    setNote(null);
    setText("");
    window.history.replaceState(null, "", `?c=${encodeURIComponent(c.id)}`);
    if (c.unread > 0) void openConversation(c.id).then(() => load(c.id, q));
  };

  const active = snap.active && snap.active.id === openIdState ? snap.active : null;
  const conn = snap.connection;
  const preview = conn.state === "preview";
  const ready = conn.state === "connected" || preview;
  const canSend = ready && active && active.windowOpen && !active.blocked;

  const submitText = async () => {
    if (!active || !text.trim() || busy) return;
    setBusy(true);
    setError(null);
    let r: Awaited<ReturnType<typeof sendText>>;
    try {
      r = await sendText({ conversationId: active.id, body: text, clientKey: key.current });
    } catch {
      /* No answer came back. The key is kept, so pressing Send again cannot send it twice. */
      setBusy(false);
      setError("No answer came back, so it is not known whether this went. Check the conversation, then press Send again — it will not be sent twice.");
      void load(openIdState, q);
      return;
    }
    key.current = newKey();
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      void load(openIdState, q);
      return;
    }
    setText("");
    void load(openIdState, q);
  };

  const refresh = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await refreshFromKapso();
    setBusy(false);
    if (!r.ok) setError(r.error);
    else setNote(r.data.refreshed ? "Refreshed from Kapso." : `Refreshed a moment ago — try again in ${r.data.retryAfterSeconds ?? 30} seconds.`);
    void load(openIdState, q);
  };

  const grouped = useMemo(() => {
    const out: { day: string; items: Msg[] }[] = [];
    for (const m of snap.messages) {
      const d = dayLabel(m.at);
      const last = out[out.length - 1];
      if (last && last.day === d) last.items.push(m);
      else out.push({ day: d, items: [m] });
    }
    return out;
  }, [snap.messages]);

  return (
    <div className="space-y-3">
      <ConnectionBanner conn={conn} onRefresh={refresh} busy={busy} />
      {note ? <Callout tone="success">{note}</Callout> : null}
      <div className="grid h-[calc(100vh-290px)] min-h-[460px] grid-cols-[340px_minmax(0,1fr)] overflow-hidden rounded-card border border-line bg-surface">
        {/* Conversation list */}
        <aside className="flex min-h-0 flex-col border-r border-line">
          <div className="border-b border-line p-3">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or number" aria-label="Search conversations" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {snap.conversations.length === 0 ? (
              <div className="p-5 text-[13px] text-muted">
                {ready ? (q ? "No conversation matches that search." : "No conversations yet. They appear here as customers message the company number, or after Refresh from Kapso.") : "Nothing to show until the company number is connected to Kapso."}
              </div>
            ) : (
              <ul>
                {snap.conversations.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => void open(c)} className={`flex w-full gap-3 border-b border-line px-3 py-3 text-left hover:bg-surface-2 ${c.id === openIdState ? "bg-surface-2" : ""}`}>
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-soft text-[14px] font-semibold text-brand">{c.title.trim().slice(0, 1).toUpperCase()}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-[14px] font-medium">{c.title}</span>
                          <span className="shrink-0 text-[11px] text-faint">{c.lastMessageAt ? clock(new Date(c.lastMessageAt)) : ""}</span>
                        </span>
                        <span className="block truncate text-[12px] text-muted">{c.phone ? `+${c.phone}` : "No number"}</span>
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-[12px] text-faint">{c.lastMessageText ?? ""}</span>
                          {c.unread > 0 ? <Badge tone="success">{c.unread}</Badge> : null}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Conversation */}
        <section className="flex min-h-0 flex-col">
          {!active ? (
            <div className="grid flex-1 place-items-center p-8 text-center text-[13px] text-muted">
              {ready ? "Choose a conversation on the left." : "The inbox opens here once Kapso holds the company number."}
            </div>
          ) : (
            <>
              <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold">{active.title}</div>
                  <div className="text-[12px] text-muted">
                    {active.phone ? `+${active.phone}` : "No number"} · {active.nameSource === "crm" ? "Name from the CRM" : active.nameSource === "whatsapp" ? "Name from WhatsApp" : "Not in the CRM"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {preview ? <Badge tone="warn">SAMPLE DATA</Badge> : null}
                  {active.blocked ? (
                    <Badge tone="danger" title="Nothing can be sent to this customer from the Studio">
                      {active.blocked === "do_not_contact" ? "Do not contact" : "WhatsApp DND"}
                    </Badge>
                  ) : (
                    <Badge tone={active.windowOpen ? "success" : "warn"} title={active.windowClosesAt ? `Window closes ${stamp(active.windowClosesAt)}` : "The customer has not messaged yet"}>
                      {active.windowOpen ? "Can reply" : "Reply window closed"}
                    </Badge>
                  )}
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto bg-surface-2 px-4 py-3">
                {grouped.length === 0 ? <div className="p-6 text-center text-[13px] text-muted">No messages stored for this conversation yet. Use Refresh from Kapso.</div> : null}
                {grouped.map((g) => (
                  <div key={g.day}>
                    <div className="my-3 text-center text-[11px] text-faint">{g.day}</div>
                    {g.items.map((m) => (
                      <Bubble key={m.id} m={m} />
                    ))}
                  </div>
                ))}
                <div ref={endRef} />
              </div>
              <footer className="border-t border-line p-3">
                {error ? <Callout tone="danger" className="mb-2">{error}</Callout> : null}
                {active.blocked ? (
                  <Callout tone="warn">{active.blocked === "do_not_contact" ? "This customer is marked do not contact. Nothing can be sent to them from the Studio." : "This customer has asked not to be messaged on WhatsApp. Nothing can be sent to them from the Studio."}</Callout>
                ) : !active.windowOpen ? (
                  <Callout tone="warn">{WINDOW_CLOSED_MESSAGE}</Callout>
                ) : !ready ? (
                  <Callout tone="warn">Sending is off until Kapso holds the company number.</Callout>
                ) : (
                  <div className="flex items-end gap-2">
                    <Button variant="secondary" onClick={() => setPicker(true)} disabled={busy} title="Send a poster from My posters or Upload & Bulk Forward">
                      + Poster
                    </Button>
                    <textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void submitText();
                        }
                      }}
                      rows={2}
                      placeholder="Type a message — Enter sends, Shift+Enter for a new line"
                      className="min-h-[44px] flex-1 resize-none rounded-control border border-line bg-surface px-3 py-2 text-[14px]"
                      aria-label="Message"
                    />
                    <Button variant="whatsapp" onClick={() => void submitText()} disabled={busy || !text.trim() || !canSend}>
                      Send
                    </Button>
                  </div>
                )}
              </footer>
            </>
          )}
        </section>
      </div>
      {picker && active ? (
        <PosterPicker
          conversationId={active.id}
          title={active.title}
          onClose={() => setPicker(false)}
          onSent={() => {
            setPicker(false);
            void load(openIdState, q);
          }}
        />
      ) : null}
    </div>
  );
}

function Bubble({ m }: { m: Msg }) {
  const out = m.direction === "outbound";
  return (
    <div className={`mb-2 flex ${out ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[75%] rounded-card px-3 py-2 text-[14px] shadow-sm ${out ? "bg-[#d9fdd3] text-ink" : "bg-surface text-ink"}`}>
        {m.hasMedia ? (
          m.posterId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={/^pv[pf]-\d$/.test(m.posterId) ? `/api/studio/inbox/preview-asset?id=${m.posterId}` : `/api/studio/posters/${encodeURIComponent(m.posterId)}/image?format=jpeg`} alt="Poster sent" className="mb-1 max-h-60 w-auto rounded-control" />
          ) : (
            <div className="mb-1 rounded-control bg-surface-2 px-3 py-6 text-center text-[12px] text-muted">{m.type === "image" ? "📷 Picture" : "Attachment"} — preview not available here</div>
          )
        ) : null}
        {m.body ?? m.caption ? <div className="whitespace-pre-wrap break-words">{m.body ?? m.caption}</div> : null}
        {m.hasMedia && m.body && m.caption ? <div className="whitespace-pre-wrap break-words">{m.caption}</div> : null}
        <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-faint">
          {out && m.origin === "business_app" ? <span title="Written on the phone, in the WhatsApp Business app">phone</span> : null}
          {out && m.sentByName ? <span>{m.sentByName}</span> : null}
          <span>{clock(new Date(m.at))}</span>
          {out && m.status ? <StatusMark status={m.status} /> : null}
        </div>
        {out && m.status === "failed" && m.errorText ? <div className="mt-1 text-[12px] text-danger">{m.errorText}</div> : null}
      </div>
    </div>
  );
}

function StatusMark({ status }: { status: MessageStatus }) {
  const tick = status === "pending" ? "…" : status === "sent" ? "✓" : status === "failed" ? "!" : "✓✓";
  return (
    <span className={status === "read" ? "text-[#2563eb]" : status === "failed" ? "text-danger" : ""} title={STATUS_LABEL[status]}>
      {tick} {STATUS_LABEL[status]}
    </span>
  );
}

function ConnectionBanner({ conn, onRefresh, busy }: { conn: PublicConnection; onRefresh: () => void; busy: boolean }) {
  if (conn.state === "preview") {
    return (
      <div className="rounded-card border-2 border-dashed border-warn bg-warn-soft px-4 py-3 text-[13px]" role="status">
        <div className="text-[15px] font-bold tracking-wide">LOCAL PREVIEW — SAMPLE DATA</div>
        <div className="mt-1">Every conversation, message and status on this screen is invented and held in this developer machine&apos;s memory only. Nothing is read from Kapso, nothing is stored, and no WhatsApp message is sent — pressing Send only adds a line to this sample chat. The real inbox is the disconnected screen you get with the preview switched off.</div>
      </div>
    );
  }
  if (conn.state === "connected") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface px-4 py-2 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="success">Connected to Kapso</Badge>
          <span className="font-medium">{conn.display ?? "Company number"}</span>
          {conn.coexistence ? <span className="text-muted">· also in the WhatsApp Business app</span> : null}
          {conn.status && conn.status !== "CONNECTED" ? <Badge tone="warn">{conn.status}</Badge> : null}
          {!conn.webhookSecretHeld ? <Badge tone="warn">Live updates off — webhook secret not set</Badge> : null}
        </div>
        <Button variant="secondary" size="sm" onClick={onRefresh} disabled={busy}>
          Refresh from Kapso
        </Button>
      </div>
    );
  }
  let lines: string[];
  if (conn.state === "no_key") lines = ["The Kapso key is not set. Add it in the Admin Console → Integrations, then reload this page."];
  else if (conn.state === "not_connected") {
    lines = [
      conn.reason === "sandbox_only"
        ? `Kapso holds only a sandbox number. The company number +${conn.expected} is not connected to this Kapso project yet, so there are no company conversations to show.`
        : `Kapso does not list the company number +${conn.expected} as a live number. It lists: ${conn.seen.map((x) => `${x.display ?? "unknown"}${x.sandbox ? " (sandbox)" : ""}`).join(", ") || "nothing"}.`,
      "A sandbox number is never shown here as the company's WhatsApp.",
    ];
  } else lines = [conn.error];
  return (
    <Callout tone="warn">
      <div className="font-medium">The WhatsApp Inbox is not connected yet</div>
      {lines.map((l) => (
        <div key={l} className="mt-1">
          {l}
        </div>
      ))}
    </Callout>
  );
}

function PosterPicker({ conversationId, title, onClose, onSent }: { conversationId: string; title: string; onClose: () => void; onSent: () => void }) {
  const [kind, setKind] = useState<"posters" | "forwards">("posters");
  const [items, setItems] = useState<Item[] | null>(null);
  const [canForwards, setCanForwards] = useState(false);
  const [pick, setPick] = useState<Item | null>(null);
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  useEffect(() => {
    let live = true;
    void fetch(`/api/studio/inbox/attachments?kind=${kind}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { ok: boolean; items: Item[]; canForwards: boolean }) => {
        if (!live) return;
        setItems(d.ok ? d.items : []);
        setCanForwards(Boolean(d.canForwards));
      })
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [kind]);

  const choose = async (it: Item) => {
    setPick(it);
    setCaption("");
    setError(null);
    try {
      const r = await fetch(`/api/studio/inbox/caption?kind=${kind === "forwards" ? "forward" : "poster"}&id=${encodeURIComponent(it.id)}`, { cache: "no-store" });
      const d = (await r.json()) as { ok: boolean; caption?: string };
      if (d.ok) setCaption(d.caption ?? "");
    } catch {
      /* No suggestion is not an error: the caption is the person's to write. */
    }
  };

  const send = async () => {
    if (!pick || busy) return;
    setBusy(true);
    setError(null);
    let r: Awaited<ReturnType<typeof sendPoster>>;
    try {
      r = kind === "posters" ? await sendPoster({ conversationId, posterId: pick.id, caption, clientKey: key.current }) : await sendForward({ conversationId, forwardId: pick.id, caption, clientKey: key.current });
    } catch {
      /* No answer came back. The key is kept, so pressing Send again cannot send it twice. */
      setBusy(false);
      setError("No answer came back, so it is not known whether this went. Check the conversation, then press Send again — it will not be sent twice.");
      return;
    }
    key.current = newKey();
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onSent();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Send a poster">
      <div className="flex max-h-[88vh] w-full max-w-[760px] flex-col overflow-hidden rounded-card bg-surface shadow-pop">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-[15px] font-semibold">Send a poster to {title}</div>
          <button type="button" onClick={onClose} className="text-[13px] text-muted hover:text-ink" aria-label="Close">
            Close
          </button>
        </div>
        {pick ? (
          <div className="grid gap-4 overflow-y-auto p-4 sm:grid-cols-[220px_minmax(0,1fr)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pick.thumb} alt={pick.title} className="w-full rounded-control border border-line" />
            <div>
              <div className="text-[14px] font-medium">{pick.title}</div>
              <label className="mt-3 block text-[12px] text-muted" htmlFor="wa-caption">
                Caption ({caption.length}/{CAPTION_MAX})
              </label>
              <textarea id="wa-caption" value={caption} onChange={(e) => setCaption(e.target.value)} rows={6} className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2 text-[14px]" />
              {error ? <Callout tone="danger" className="mt-2">{error}</Callout> : null}
              <div className="mt-3 flex gap-2">
                <Button variant="whatsapp" onClick={() => void send()} disabled={busy || caption.length > CAPTION_MAX}>
                  {busy ? "Sending…" : "Send poster with caption"}
                </Button>
                <Button variant="secondary" onClick={() => setPick(null)} disabled={busy}>
                  Back
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-3 flex gap-2">
              <Button variant={kind === "posters" ? "primary" : "secondary"} size="sm" onClick={() => setKind("posters")}>
                My posters
              </Button>
              {canForwards || kind === "forwards" ? (
                <Button variant={kind === "forwards" ? "primary" : "secondary"} size="sm" onClick={() => setKind("forwards")}>
                  Uploaded to forward
                </Button>
              ) : null}
            </div>
            {items === null ? (
              <div className="p-6 text-center text-[13px] text-muted">Loading…</div>
            ) : items.length === 0 ? (
              <div className="p-6 text-center text-[13px] text-muted">{kind === "posters" ? "You have not made any posters yet." : "You have not uploaded any pictures to forward."}</div>
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {items.map((it) => (
                  <li key={it.id}>
                    <button type="button" onClick={() => void choose(it)} className="block w-full overflow-hidden rounded-control border border-line text-left hover:border-brand">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={it.thumb} alt="" loading="lazy" className="aspect-square w-full object-cover" />
                      <span className="block truncate px-2 py-1 text-[12px]">{it.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
