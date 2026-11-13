"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Callout } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { markRecipient, openRecipientChat } from "@/lib/actions/studio-forward";
import { STATUS_LABEL, tally, type ForwardStatus } from "@/lib/studio/domain/forward";

/* ---------------------------------------------------------------------------
 * WORKING THE LIST. Opening a chat is not sending, and a status here is only
 * what the person pressing it said — no delivery is ever claimed, because
 * nothing MahekOne can see could confirm one.
 * ------------------------------------------------------------------------- */

export type RunRow = { id: string; company: string; place: string; status: ForwardStatus };

const TONE: Record<ForwardStatus, "neutral" | "brand" | "success" | "warn"> = { pending: "neutral", opened: "brand", sent: "success", skipped: "warn" };

export function ForwardRun({ title, imageUrl, rows }: { title: string; imageUrl: string; rows: RunRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const t = tally(rows.map((r) => r.status));

  async function open(id: string) {
    setBusyId(id);
    const res = await openRecipientChat(id);
    setBusyId(null);
    if (!res.ok) return void toast.push(res.error, "error");
    window.open(res.data.href, "_blank", "noopener");
    router.refresh();
  }
  async function mark(id: string, status: ForwardStatus) {
    setBusyId(id);
    const res = await markRecipient(id, status);
    setBusyId(null);
    if (!res.ok) return void toast.push(res.error, "error");
    router.refresh();
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card className="flex flex-col gap-3 p-4 lg:sticky lg:top-4 lg:self-start">
        {/* eslint-disable-next-line @next/next/no-img-element -- the uploaded poster */}
        <img src={imageUrl} alt={title} className="w-full rounded-control border border-line" />
        <a href={`${imageUrl}?download=1`} className="text-sm font-medium">
          Download the poster to attach
        </a>
        <div className="text-[13px] text-muted" data-testid="tally">
          {t.sent} marked sent · {t.opened} chat opened · {t.skipped} skipped · {t.pending} not done yet · {t.total} in all
        </div>
      </Card>
      <div className="flex flex-col gap-3">
        <Callout tone="info">
          <span className="block">
            For each person: press <b>Open WhatsApp chat</b>, attach the poster you downloaded, send it, then press <b>Mark sent</b>. MahekOne cannot see whether WhatsApp delivered it, so “Marked sent” means you said you sent it.
          </span>
        </Callout>
        <Card>
          <ul className="divide-y divide-divider">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-status={r.status}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{r.company}</span>
                  <span className="block truncate text-[12.5px] text-muted">{r.place || "—"}</span>
                </span>
                <Badge tone={TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                <Button size="sm" variant="whatsapp" onClick={() => void open(r.id)} disabled={busyId === r.id || r.status === "sent" || r.status === "skipped"}>
                  Open WhatsApp chat
                </Button>
                {r.status === "sent" || r.status === "skipped" ? (
                  <Button size="sm" variant="ghost" onClick={() => void mark(r.id, "pending")} disabled={busyId === r.id}>
                    Undo
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="primary" onClick={() => void mark(r.id, "sent")} disabled={busyId === r.id}>
                      Mark sent
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void mark(r.id, "skipped")} disabled={busyId === r.id}>
                      Skip
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
