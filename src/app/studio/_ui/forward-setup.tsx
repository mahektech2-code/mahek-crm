"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input, Textarea, checkboxClass, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { searchRecipients, startForward, type PickRow } from "@/lib/actions/studio-forward";
import { CAPTION_MAX, FORWARD_MAX } from "@/lib/studio/domain/forward";

/* ---------------------------------------------------------------------------
 * CHOOSE, REVIEW, CONFIRM. The poster is fixed; what is chosen here is who it
 * goes to and the message that opens each chat. The list is read through the
 * server in the asker's own scope and never carries a phone number. Nothing is
 * written until the confirmation is pressed, and pressing it twice cannot
 * start the forward twice.
 * ------------------------------------------------------------------------- */

const LISTS = [
  { id: "lead", label: "Leads" },
  { id: "customer", label: "Customers" },
  { id: "lost", label: "Lost leads" },
] as const;

export function ForwardSetup({ forwardId, title, imageUrl }: { forwardId: string; title: string; imageUrl: string }) {
  const router = useRouter();
  const toast = useToast();
  const [list, setList] = useState<string>("customer");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PickRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Map<string, PickRow>>(new Map());
  const [caption, setCaption] = useState("");
  const [step, setStep] = useState<"choose" | "confirm">("choose");
  const [busy, setBusy] = useState(false);
  const [repeats, setRepeats] = useState<{ id: string; name: string }[] | null>(null);

  const load = useCallback(async (l: string, query: string) => {
    setLoading(true);
    const res = await searchRecipients(l, query);
    setLoading(false);
    if (res.ok) {
      setRows(res.data.rows);
      setTotal(res.data.total);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(list, q), 250);
    return () => clearTimeout(t);
  }, [list, q, load]);

  const toggle = (r: PickRow) =>
    setPicked((cur) => {
      const next = new Map(cur);
      if (next.has(r.id)) next.delete(r.id);
      else if (next.size < FORWARD_MAX) next.set(r.id, r);
      return next;
    });
  const remove = (id: string) =>
    setPicked((cur) => {
      const next = new Map(cur);
      next.delete(id);
      return next;
    });

  async function start(includeRepeats: boolean) {
    setBusy(true);
    const res = await startForward({ forwardId, customerIds: [...picked.keys()], caption, includeRepeats });
    setBusy(false);
    if (!res.ok) return void toast.push(res.error, "error");
    if (res.data.repeats?.length) return setRepeats(res.data.repeats);
    toast.push(`Forward started for ${res.data.started} ${res.data.started === 1 ? "person" : "people"}.`, "info");
    router.refresh();
  }

  const chosen = [...picked.values()];

  if (step === "confirm") {
    return (
      <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="p-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- the uploaded poster */}
          <img src={imageUrl} alt={title} className="mx-auto block max-h-[60vh] w-auto rounded-control" />
        </Card>
        <Card className="flex flex-col gap-3 p-4">
          <div className="text-base font-semibold text-ink">Confirm</div>
          <p className="text-sm text-ink">
            Forward <b>{title}</b> to <b data-testid="confirm-count">{chosen.length}</b> {chosen.length === 1 ? "person" : "people"}. The same picture goes to everyone, unchanged.
          </p>
          <p className="text-[13px] text-muted">MahekOne will not send anything. You will get a list: for each person, open their chat, attach the poster and send it yourself, then mark it done.</p>
          <ul className="max-h-[32vh] divide-y divide-divider overflow-y-auto rounded-control border border-line">
            {chosen.map((r) => (
              <li key={r.id} className="px-3 py-1.5 text-sm">
                {r.company} <span className="text-muted">{r.place}</span>
              </li>
            ))}
          </ul>
          {repeats ? (
            <div className="rounded-control border border-warn-line bg-warn-soft p-3 text-sm" data-testid="repeat-warning">
              <b>You already forwarded this same poster to:</b> {repeats.map((r) => r.name).join(", ")}.
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => void start(false)} disabled={busy}>
                  Leave them out
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void start(true)} disabled={busy}>
                  Include them again
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button onClick={() => setStep("choose")} disabled={busy}>
              Back
            </Button>
            <Button variant="primary" onClick={() => void start(false)} disabled={busy || !chosen.length}>
              {busy ? "Starting…" : `Start forwarding to ${chosen.length}`}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <Card className="flex flex-col gap-3 p-4 lg:sticky lg:top-4 lg:self-start">
        {/* eslint-disable-next-line @next/next/no-img-element -- the uploaded poster */}
        <img src={imageUrl} alt={title} className="w-full rounded-control border border-line" />
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Message that opens each chat</span>
          <Textarea rows={4} value={caption} maxLength={CAPTION_MAX} onChange={(e) => setCaption(e.target.value)} placeholder="Wishing you a happy Navratri! — Mahek Marketing India" />
        </label>
        <div className="rounded-control border border-line p-2.5">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium">Recipients</span>
            <span data-testid="picked-count" className="text-muted">
              {chosen.length} chosen
            </span>
          </div>
          {chosen.length ? (
            <ul className="max-h-[28vh] divide-y divide-divider overflow-y-auto">
              {chosen.map((r) => (
                <li key={r.id} className="flex items-center gap-2 py-1 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{r.company}</span>
                  <button type="button" className="text-muted hover:text-danger" onClick={() => remove(r.id)} aria-label={`Remove ${r.company}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">Nobody chosen yet.</p>
          )}
        </div>
        <Button variant="primary" onClick={() => setStep("confirm")} disabled={!chosen.length}>
          Review and confirm
        </Button>
        <p className="text-[12.5px] text-muted">Up to {FORWARD_MAX} people at a time, from your own book.</p>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-2.5">
          {LISTS.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setList(l.id)}
              className={cx("rounded-full border px-3 py-1 text-sm", list === l.id ? "border-brand bg-brand-soft text-brand" : "border-line text-muted")}
            >
              {l.label}
            </button>
          ))}
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, company or city" className="ml-auto w-[260px]" />
        </div>
        <ul className="max-h-[70vh] divide-y divide-divider overflow-y-auto">
          {rows.map((r) => (
            <li key={r.id}>
              <label className={cx("flex cursor-pointer items-center gap-3 px-4 py-2", picked.has(r.id) ? "bg-brand-soft" : null)}>
                <input type="checkbox" className={checkboxClass} checked={picked.has(r.id)} onChange={() => toggle(r)} disabled={r.doNotContact} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{r.company}</span>
                  <span className="block truncate text-[12.5px] text-muted">{[r.contact, r.place].filter(Boolean).join(" · ") || "—"}</span>
                </span>
                {r.doNotContact ? <Badge tone="danger">Do not contact</Badge> : null}
              </label>
            </li>
          ))}
        </ul>
        {!rows.length && !loading ? <p className="px-4 py-6 text-sm text-muted">Nobody to list. Try a different search.</p> : null}
        {total > rows.length ? <p className="border-t border-divider px-4 py-2 text-[12.5px] text-muted">Showing {rows.length} of {total}. Search to find somebody further down.</p> : null}
      </Card>
    </div>
  );
}
