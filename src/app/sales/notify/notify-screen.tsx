"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { sendFieldNotification } from "@/lib/actions/sales";
import { Banner, Button, ScreenHeader } from "../parts";

type Person = { id: string; name: string; hasPush: boolean };

/**
 * A message the office writes by hand.
 *
 * Everything else a salesman sees in his notification list is produced by an
 * event this app already understands — a leave decided, a tour approved.
 * This is the one screen that writes a notification nobody derived, so it
 * asks for exactly two things and nothing else: who, and what.
 */
export function NotifyScreen({ people }: { people: Person[] }) {
  const router = useRouter();
  const toast = useToast();

  const [audience, setAudience] = React.useState<"all" | "ids">("all");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const withoutPush = people.filter((p) => !p.hasPush).length;

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function send() {
    setBusy(true);
    setError(null);
    const result = await sendFieldNotification({
      audience,
      userIds: audience === "ids" ? [...picked] : undefined,
      title,
      body,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setTitle("");
    setBody("");
    setPicked(new Set());
    toast.push(result.message ?? "Sent.");
    router.refresh();
  }

  const recipientCount = audience === "all" ? people.length : picked.size;
  const canSend = title.trim() && body.trim() && recipientCount > 0 && !busy;

  return (
    <div className="p-6">
      <ScreenHeader
        title="Send a notification"
        subtitle="Lands in the app straight away, and pushes to a handset that has notifications turned on. There is no undo — read it back before you send it."
      />

      {error ? <Banner tone="danger" title="That did not send" body={error} /> : null}

      {withoutPush > 0 ? (
        <Banner
          tone="info"
          title="Not everyone will feel a buzz"
          body={`${withoutPush} of ${people.length} in your team have no handset registered for push yet — they still see this the next time they open the app, they just are not alerted to it.`}
        />
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-[6px] border border-line bg-surface px-4 py-3">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAudience("all")}
            className={
              "h-8.5 rounded-[4px] border px-3.5 text-[13px] " +
              (audience === "all"
                ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                : "border-line bg-surface text-body hover:bg-canvas")
            }
          >
            Everyone in my team ({people.length})
          </button>
          <button
            type="button"
            onClick={() => setAudience("ids")}
            className={
              "h-8.5 rounded-[4px] border px-3.5 text-[13px] " +
              (audience === "ids"
                ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                : "border-line bg-surface text-body hover:bg-canvas")
            }
          >
            Pick people
          </button>
        </div>
      </div>

      {audience === "ids" ? (
        <div className="mb-4 max-h-[280px] overflow-y-auto rounded-[6px] border border-line bg-surface">
          {people.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted">
              Nobody in your team holds the field app.
            </p>
          ) : (
            people.map((p, i) => (
              <label
                key={p.id}
                className={
                  "flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm " +
                  (i ? "border-t border-[#F7F8FA]" : "")
                }
              >
                <input
                  type="checkbox"
                  checked={picked.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="size-4"
                />
                <span className="flex-1 text-ink">{p.name}</span>
                {!p.hasPush ? <span className="text-[11px] text-muted">no push registered</span> : null}
              </label>
            ))
          )}
        </div>
      ) : null}

      <div className="mb-4 rounded-[6px] border border-line bg-surface px-4 py-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Title
          </span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New price list from Monday"
            className="h-8.5 w-full rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="mt-3 block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Message
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="Rates for the DEALER tag change from Monday — check the new numbers before quoting anybody this week."
            className="w-full rounded-[4px] border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
      </div>

      <Button tone="primary" disabled={!canSend} onClick={() => void send()}>
        {busy ? "Sending…" : `Send to ${recipientCount || 0}`}
      </Button>
    </div>
  );
}
