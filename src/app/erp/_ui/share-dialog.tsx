"use client";

import { useState } from "react";
import { Button, Callout, SectionLabel, checkboxClass, controlClass, cx, buttonClass } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import type { ShareOutcome, ShareSpec } from "@/lib/erp/ui";
import { addressLine, type ShareChannel } from "@/lib/erp/engines/po-share";
import { Badge } from "./badge";
import { useKit } from "./kit";
import { resultError } from "./use-act";

/* ---------------------------------------------------------------------------
 * THE SHARE WINDOW — how (WhatsApp, email, a copied link), who (the record's
 * own parties, ticked or not, and anybody typed in), and the message. Send
 * runs the record's share action; what comes back is drawn in the same
 * window, one line per person: sent, or a button that opens it on the
 * sender's own WhatsApp or mail app, or why it failed.
 * ------------------------------------------------------------------------- */

export function ShareDialog({
  screen,
  actionId,
  recordId,
  spec,
  onClose,
  onDone,
}: {
  screen: string;
  actionId: string;
  recordId: string;
  spec: ShareSpec;
  onClose: () => void;
  /** After a send: the toast and the refresh. */
  onDone: (message: string) => void;
}) {
  const kit = useKit();
  const [channel, setChannel] = useState<ShareChannel>(spec.channels[0]?.k ?? "whatsapp");
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(spec.recipients.filter((r) => r.checked).map((r) => r.key)));
  const [extra, setExtra] = useState("");
  const [message, setMessage] = useState(spec.message);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string; text: string } | null>(null);
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  /* Only the people this channel can reach are counted; the rest are drawn but cannot be ticked. */
  const reachable = (r: ShareSpec["recipients"][number]) => (channel === "whatsapp" ? !!r.whatsapp : channel === "email" ? !!r.email : true);
  const extras = extra.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  const count = spec.recipients.filter((r) => ticked.has(r.key) && reachable(r)).length + extras.length;

  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(what));
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    const to = spec.recipients.filter((r) => ticked.has(r.key) && reachable(r)).map((r) => r.key);
    const res = await kit.runAction(screen, actionId, recordId, { channel, to: JSON.stringify(to), extra, message });
    setBusy(false);
    if (!res.ok) {
      const fe = (res as { fieldErrors?: { field: string; message: string }[] }).fieldErrors?.[0];
      setError({ field: fe?.field, text: fe?.message ?? resultError(res) });
      return;
    }
    setOutcome(res.data as ShareOutcome);
    onDone(res.message ?? "Shared");
  };

  if (outcome)
    return (
      <Modal
        open
        onClose={onClose}
        width={600}
        title={
          <>
            {spec.title}
            <span className="mt-0.5 block text-meta font-normal text-muted">{channel === "link" ? "The link is ready." : "What happened, person by person."}</span>
          </>
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => copy("message", outcome.text)}>
              {copied === "message" ? "Message copied" : "Copy message"}
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        {outcome.link ? (
          <div className="mb-3 flex items-center gap-2 rounded-card border border-line bg-canvas px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-meta text-ink" title={outcome.link}>
              {outcome.link}
            </span>
            <Button size="sm" variant={channel === "link" ? "primary" : "secondary"} onClick={() => copy("link", outcome.link!)}>
              {copied === "link" ? "Copied" : "Copy link"}
            </Button>
          </div>
        ) : null}
        {outcome.results.length ? (
          <div className="overflow-hidden rounded-card border border-line">
            {outcome.results.map((r, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-divider px-3 py-2.5 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-meta font-semibold text-ink">{r.recipient}</div>
                  <div className={cx("text-xs", r.status === "failed" ? "text-danger" : "text-muted")}>
                    {r.status === "sent" ? `Sent${r.address ? ` · ${r.address}` : ""}` : r.status === "open" ? (r.why ?? "Send it from your own app") : (r.why ?? "Not sent")}
                  </div>
                </div>
                {r.status === "sent" ? (
                  <Badge label="Sent" tone="success" />
                ) : r.href ? (
                  <a href={r.href} target="_blank" rel="noreferrer" className={buttonClass({ size: "sm", variant: r.status === "open" ? "primary" : "secondary" })}>
                    {channel === "whatsapp" ? "Open WhatsApp" : "Open email"}
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </Modal>
    );

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={
        <>
          {spec.title}
          {spec.sub ? <span className="mt-0.5 block text-meta font-normal text-muted">{spec.sub}</span> : null}
        </>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="min-w-0 truncate text-xs text-muted" title={spec.last}>
            {spec.last ? `Last shared: ${spec.last}` : "Not shared yet"}
          </span>
          <span className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || (channel !== "link" && count === 0)} onClick={send}>
              {busy ? "Sending…" : channel === "link" ? "Get the link" : `Send to ${count} ${count === 1 ? "person" : "people"}`}
            </Button>
          </span>
        </div>
      }
    >
      <div className="grid gap-4">
        <section>
          <SectionLabel className="mb-1.5">Send by</SectionLabel>
          <div className="grid grid-cols-3 gap-2">
            {spec.channels.map((c) => (
              <button
                key={c.k}
                type="button"
                onClick={() => {
                  setChannel(c.k);
                  setError(null);
                }}
                className={cx(
                  "rounded-card border px-3 py-2.5 text-left transition-colors",
                  channel === c.k ? "border-brand bg-brand-soft shadow-[inset_0_0_0_1px_var(--color-brand)]" : "border-line hover:border-line-strong",
                )}
              >
                <span className={cx("block text-meta font-semibold", channel === c.k ? "text-brand" : "text-ink")}>{c.l}</span>
                <span className="mt-0.5 block text-xs text-muted">{c.d}</span>
              </button>
            ))}
          </div>
        </section>

        {channel !== "link" ? (
          <section>
            <SectionLabel className="mb-1.5">Send to</SectionLabel>
            <div className={cx("overflow-hidden rounded-card border", error?.field === "to" ? "border-danger" : "border-line")}>
              {spec.recipients.map((r) => {
                const can = reachable(r);
                const on = ticked.has(r.key) && can;
                const line = addressLine(channel, r);
                return (
                  <label key={r.key} className={cx("flex items-center gap-3 border-b border-divider px-3 py-2.5", can ? "cursor-pointer" : "opacity-60")}>
                    <input
                      type="checkbox" className={checkboxClass}
                      checked={on}
                      disabled={!can}
                      onChange={(e) => {
                        const next = new Set(ticked);
                        if (e.target.checked) next.add(r.key);
                        else next.delete(r.key);
                        setTicked(next);
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-meta font-semibold text-ink">
                        <span className="truncate">{r.name}</span>
                        {r.tag ? <Badge label={r.tag} tone="brand" /> : null}
                      </span>
                      <span className="block text-xs text-muted">{line ?? `No ${channel === "whatsapp" ? "WhatsApp number" : "email"} on record`}</span>
                    </span>
                  </label>
                );
              })}
              <div className="flex items-start gap-3 px-3 py-2.5">
                <span className="pt-1.5 text-meta font-semibold whitespace-nowrap text-brand">+ Someone else</span>
                <input
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  placeholder={channel === "whatsapp" ? "Mobile numbers, separated by commas" : "Email addresses, separated by commas"}
                  className={controlClass({ invalid: error?.field === "extra", className: "h-8 min-w-0 flex-1" })}
                />
              </div>
            </div>
          </section>
        ) : null}

        <section>
          <SectionLabel className="mb-1.5">Message</SectionLabel>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            maxLength={2000}
            className={controlClass({ invalid: error?.field === "message", className: "resize-y py-2 leading-5" })}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            {spec.attachment ? (
              <span className="inline-flex items-center gap-1.5 rounded-control border border-line bg-surface px-2 py-1 font-semibold text-ink">
                <span aria-hidden>📄</span>
                {spec.attachment}
              </span>
            ) : null}
            <span>{channel === "email" ? "The PDF goes with the email, and its link under the message." : "The link to the PDF is added under the message."}</span>
          </div>
        </section>

        {error ? (
          <Callout tone="danger">
            <span className="text-meta text-danger">{error.text}</span>
          </Callout>
        ) : null}
      </div>
    </Modal>
  );
}
