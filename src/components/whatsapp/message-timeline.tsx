import { Badge } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { DeliveryStatus } from "./delivery-status";
import type { TrackerRow, RuleOutlook } from "@/lib/services/whatsapp-tracker-service";

/**
 * Every WhatsApp message to one customer, newest first, each with the full
 * trail of receipts — prepared, sent, delivered, read, replied — and who or
 * which rule sent it. Shared by the payment panel and the customer record.
 */
export function MessageTimeline({ messages, empty = "No WhatsApp messages to this customer yet." }: { messages: TrackerRow[]; empty?: string }) {
  if (!messages.length) return <p className="text-[13px] text-muted">{empty}</p>;
  return (
    <ol className="divide-y divide-divider rounded-[6px] border border-line">
      {messages.map((m) => (
        <li key={m.id} className="px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{m.templateName ?? "Message"}</span>
            <DeliveryStatus m={m} showTime={false} />
            <span className="text-[12px] text-muted">
              {m.viaRule ? "Automatic rule" : m.sentBy} · {m.mode === "automatic" ? "WhatsApp API" : "pasted by hand"}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-muted">
            <Step label="Written" at={m.preparedAt} />
            <Step label={m.mode === "automatic" ? "Sent" : "Confirmed"} at={m.sentAt ?? m.confirmedSentAt} />
            {m.mode === "automatic" ? (
              <>
                <Step label="Delivered" at={m.deliveredAt} />
                <Step label="Read" at={m.readAt} />
              </>
            ) : null}
            {m.repliedAt ? <Step label="Replied" at={m.repliedAt} /> : null}
          </div>
          {m.status === "failed" && m.failureReason ? (
            <div className="mt-1 text-[12px] text-danger">{m.failureReason}</div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function Step({ label, at }: { label: string; at: string | null }) {
  return (
    <span className={at ? "text-body" : "text-line-strong"}>
      {label}: {at ? stamp(at) : "—"}
    </span>
  );
}

/**
 * The founder's automation rules as they stand for THIS customer — which one
 * applies today and which will next. Shown to the telecaller so an automatic
 * message is never a surprise, and never duplicated by a manual one.
 */
export function RuleOutlookList({ rules }: { rules: RuleOutlook[] }) {
  if (!rules.length) return <p className="text-[13px] text-muted">No automatic WhatsApp rules are set up.</p>;
  return (
    <ul className="divide-y divide-divider rounded-[6px] border border-line">
      {rules.map((r) => (
        <li key={r.ruleId} className="flex items-start gap-3 px-3.5 py-2.5">
          <Badge tone={r.status === "live" ? "success" : r.status === "preview" ? "brand" : "muted"}>
            {r.status === "live" ? "Live" : r.status === "preview" ? "Preview" : "Off"}
          </Badge>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">{r.templateName}</div>
            <div className="text-[12px] text-muted">{r.sentence}</div>
            <div className={r.inRange ? "text-[12px] text-ink" : "text-[12px] text-muted"}>{r.verdict}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
