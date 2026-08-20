"use client";

import * as React from "react";
import { Badge, Card, type Tone } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";

export type MessageEntry = {
  id: string;
  /** ISO — the server owns the clock, the same as every other entry here. */
  at: string;
  by: string;
  status: string;
  channelLabel: string;
  destination: string;
  destKind: "personal" | "group";
  templateName: string | null;
  body: string;
  edited: boolean;
};

/**
 * A copied message and a confirmed one are different facts about whether the
 * customer heard from us, so they never share a tone. Anything still sitting
 * at `prepared` or `copied` reads as unfinished, because it is.
 */
const STATUS_TONE: Record<string, Tone> = {
  prepared: "muted",
  copied: "warn",
  queued: "muted",
  sent_manually: "success",
  sent: "success",
  delivered: "success",
  read: "success",
  failed: "danger",
  cancelled: "muted",
};

const STATUS_LABEL: Record<string, string> = {
  prepared: "Prepared",
  copied: "Copied, not confirmed",
  queued: "Queued",
  sent_manually: "Confirmed sent",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function MessageHistory({
  messages,
  total,
}: {
  messages: MessageEntry[];
  /** Every message ever sent, not the page — the sentence has to stay true. */
  total: number;
}) {
  const capped = messages.length < total;
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-divider px-5 py-3.5">
        <span className="text-lg leading-6 font-semibold text-ink">
          Message history
        </span>
        <span className="text-[13px] text-muted">
          {capped
            ? `showing the newest ${messages.length} of ${total.toLocaleString("en-IN")}`
            : total === 1
              ? "1 message"
              : `${total} messages`}{" "}
          · every send is kept, whichever route it took
        </span>
      </div>

      {messages.length ? (
        // Scrolls inside itself rather than growing the page, like every other
        // panel on this record.
        <div className="max-h-[420px] overflow-y-auto px-5 py-4">
          {messages.map((m) => (
            <div
              key={m.id}
              className="border-b border-divider pb-3.5 last:border-b-0 last:pb-0 [&+&]:pt-3.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>
                  {STATUS_LABEL[m.status] ?? m.status}
                </Badge>
                <span className="text-[11px] text-muted">{m.channelLabel}</span>
                <span className="text-[11px] text-muted">
                  ·{" "}
                  {m.destKind === "group"
                    ? `${m.destination} (group)`
                    : m.destination}
                </span>
                <span className="ml-auto text-[11px] text-muted">
                  {stamp(m.at)} · {m.by}
                </span>
              </div>

              {m.body.trim() ? (
                <div className="mt-2 rounded-[4px] border border-divider bg-canvas px-3 py-2">
                  {m.body.split(/\n/).map((line, i) => (
                    <span
                      key={i}
                      className="block text-[13px] leading-5 text-body empty:h-2"
                    >
                      {line}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-[13px] text-muted italic">
                  {m.templateName ?? "Message"} - body not recorded
                </div>
              )}

              {m.edited ? (
                <div className="mt-1 text-[11px] text-muted">
                  Edited before sending
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="px-5 py-6 text-sm text-muted">
          No messages sent to this customer yet. Anything sent from the CRM
          appears here in full.
        </div>
      )}
    </Card>
  );
}
