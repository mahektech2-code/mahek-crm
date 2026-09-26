import { Badge, cx } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { statusView, type TrackedMessage } from "@/lib/whatsapp-status";

/**
 * A message's status the way WhatsApp itself draws it — ✓, ✓✓, blue ✓✓ —
 * with the time it got there, and a hover that says what the state does and
 * does not prove. One component, so the worklist, the payment panel, the
 * customer record and the founder's tracker cannot disagree about a message.
 */
export function DeliveryStatus({ m, showTime = true }: { m: TrackedMessage; showTime?: boolean }) {
  const v = statusView(m);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={v.explain}>
      <Badge tone={v.tone === "brand" ? "brand" : v.tone}>
        {v.ticks ? (
          <span className={cx("mr-1 font-semibold", v.tone === "brand" ? "text-[#1d9bf0]" : "")}>{v.ticks}</span>
        ) : null}
        {v.label}
      </Badge>
      {m.repliedAt ? <Badge tone="warn">Replied</Badge> : null}
      {showTime && v.at ? <span className="text-[12px] text-muted">{stamp(v.at)}</span> : null}
    </span>
  );
}
