"use client";

import { useState } from "react";
import { FilterPills } from "@/components/ui/overlays";
import { Badge, Button, Card, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { erpLogisticsMessageRetry, erpLogisticsMessageSent, erpLogisticsMessageSkip } from "@/lib/actions/erp-logistics";
import { waLink } from "@/lib/erp/engines/logistics";
import type { OutboxMessage } from "@/lib/erp/logistics";
import { Empty, plural, useAct } from "./common";

/**
 * Every WhatsApp the flow wrote for a customer. Those Wati could not send wait
 * at the top with the reason: open WhatsApp with the message already in it,
 * send, and mark it sent — or decide it should not go.
 */
const KIND: Record<string, string> = { lr: "LR shared", stage: "Status update", issue: "Problem", delivered: "Delivered" };
const STATUS: Record<string, { l: string; tone: "success" | "warn" | "danger" | "muted" | "neutral" }> = {
  sent: { l: "Sent", tone: "success" },
  delivered: { l: "Delivered", tone: "success" },
  read: { l: "Read", tone: "success" },
  sent_by_hand: { l: "Sent by hand", tone: "success" },
  to_send: { l: "To send", tone: "warn" },
  failed: { l: "Failed", tone: "danger" },
  skipped: { l: "Not sent", tone: "muted" },
};

type F = "waiting" | "all" | "skipped";

export function Messages({ rows, canWrite, wati }: { rows: OutboxMessage[]; canWrite: boolean; wati: string | null }) {
  const { run, pending } = useAct();
  const { push } = useToast();
  const waiting = rows.filter((m) => m.status === "to_send" || m.status === "failed");
  const [f, setF] = useState<F>(waiting.length ? "waiting" : "all");
  const shown = f === "waiting" ? waiting : f === "skipped" ? rows.filter((m) => m.status === "skipped") : rows;

  const copy = async (m: OutboxMessage) => {
    try {
      await navigator.clipboard.writeText(m.body);
      push("Copied — paste it into WhatsApp");
    } catch {
      push("Could not copy; select the text instead", "error");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <FilterPills<F>
          value={f}
          onChange={setF}
          options={[
            { key: "waiting", label: "To send by hand", count: waiting.length },
            { key: "all", label: "Every message", count: rows.length },
            { key: "skipped", label: "Could not be sent", count: rows.filter((m) => m.status === "skipped").length },
          ]}
        />
        <span className="ml-auto max-w-[520px] text-right text-[12px] text-muted">{wati ? `Messages go through Wati as ${wati} where the founder has WhatsApp on.` : "No Wati template is named for logistics (ERP settings → Logistics), so every message is sent by hand."}</span>
      </div>
      {!shown.length ? (
        <Card>
          <Empty>{f === "waiting" ? "Nothing waiting to be sent." : "No messages yet."}</Empty>
        </Card>
      ) : null}
      {shown.map((m) => {
        const link = waLink(m.phone, m.body);
        const st = STATUS[m.status] ?? { l: m.status, tone: "neutral" as const };
        const open = m.status === "to_send" || m.status === "failed";
        return (
          <Card key={m.id} className={cx("p-4", open && "border-warn/60")}>
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{m.customer}</span>
                  <Badge tone="neutral">{KIND[m.kind] ?? m.kind}</Badge>
                  <Badge tone={st.tone}>{st.l}</Badge>
                  {m.lrNo ? <span className="font-mono text-[12px] text-muted">LR {m.lrNo}</span> : null}
                </div>
                <div className="mt-0.5 text-[12px] text-muted">
                  {m.phone ?? "No number"} · written {new Date(m.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                  {m.createdBy ? ` by ${m.createdBy}` : ""}
                  {m.sentAt ? ` · sent ${new Date(m.sentAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}${m.sentBy ? ` by ${m.sentBy}` : ""}` : ""}
                </div>
                {m.why ? <div className={cx("mt-1 text-[12px]", m.status === "failed" ? "text-danger" : "text-warn-ink")}>{m.why}</div> : null}
              </div>
              {open && canWrite ? (
                <div className="flex flex-wrap items-center gap-2">
                  {link ? (
                    <a href={link} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-[4px] bg-[#25D366] px-3 text-[13px] font-medium text-white no-underline hover:no-underline">
                      Open in WhatsApp
                    </a>
                  ) : null}
                  <Button size="sm" onClick={() => copy(m)}>
                    Copy
                  </Button>
                  <Button size="sm" variant="primary" disabled={pending} onClick={() => run(() => erpLogisticsMessageSent(m.id))}>
                    Mark sent
                  </Button>
                  {wati ? (
                    <Button size="sm" disabled={pending} onClick={() => run(() => erpLogisticsMessageRetry(m.id))}>
                      Try Wati again
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => erpLogisticsMessageSkip(m.id))}>
                    Don&apos;t send
                  </Button>
                </div>
              ) : null}
            </div>
            <pre className="mt-3 max-h-[220px] overflow-auto rounded-[4px] bg-canvas px-3 py-2 font-sans text-[13px] whitespace-pre-wrap text-body">{m.body}</pre>
          </Card>
        );
      })}
      {waiting.length > 1 ? <div className="text-[12px] text-muted">{plural(waiting.length, "message")} waiting. Each opens WhatsApp with the text already typed.</div> : null}
    </div>
  );
}
