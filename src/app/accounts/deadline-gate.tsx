"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Badge, Button, Textarea, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { explainAccountsDelays } from "@/lib/actions/accounts-sla";
import {
  MAX_REMIND_DAYS,
  MIN_REMARK_CHARS,
  REMIND_CHOICES,
  remarkProblem,
  remindAtFor,
  type RemindChoice,
} from "@/lib/engines/accounts-sla";
import type { DeadlineItem } from "@/lib/services/accounts-sla-service";
import { APP_TIMEZONE } from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * THE ACCOUNTS DEADLINE, as the desk meets it.
 *
 * Anything past its working-hours deadline that nobody on the desk has given
 * a reason for — or whose "remind me" has come round — opens this dialog on
 * every Accounts screen, and it does not close until each item has a reason
 * and the desk has said when to be asked again. The admins have already been
 * told; this is where accounts say why.
 *
 * It does NOT open on the four screens where the work is done (approvals,
 * payments, credit notes, order changes): "Open and decide" goes there, and a
 * dialog standing in front of the very queue somebody was sent to would stop
 * them doing the thing it asks for. There, a bar at the foot offers it.
 * ------------------------------------------------------------------------- */

const WORK_SCREENS = ["/accounts/approvals", "/accounts/payments", "/accounts/credits", "/accounts/order-changes"];

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: APP_TIMEZONE, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );

/** "YYYY-MM-DDTHH:MM" for a datetime-local box, in India's wall clock. */
function localInputValue(ms: number): string {
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 16);
}

export function DeadlineGate({ items, nowMs }: { items: DeadlineItem[]; nowMs: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const [now, setNow] = React.useState(nowMs);
  const [openByHand, setOpenByHand] = React.useState(false);

  // A reminder coming round is noticed without a navigation; new breaches
  // arrive with the next refresh of the layout.
  React.useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const refresh = setInterval(() => router.refresh(), 5 * 60_000);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [router]);

  const owing = items.filter((i) => !i.remindAt || Date.parse(i.remindAt) <= now);
  if (!owing.length) return null;

  const onWorkScreen = WORK_SCREENS.some((w) => pathname.startsWith(w));
  const open = openByHand || !onWorkScreen;

  return (
    <>
      {!open ? (
        <div className="fixed right-5 bottom-5 z-[60] flex items-center gap-3 rounded-[6px] border border-danger bg-surface px-4 py-3 shadow-[0_8px_24px_rgba(22,22,22,0.16)]">
          <span className="h-2 w-2 rounded-full bg-danger" />
          <span className="text-sm text-ink">
            <b>{owing.length}</b> past the deadline {owing.length === 1 ? "needs" : "need"} a reason
          </span>
          <Button size="sm" variant="primary" onClick={() => setOpenByHand(true)}>
            Give reasons
          </Button>
        </div>
      ) : null}
      {open ? (
        <ReasonsDialog
          key={owing.map((o) => o.breachId).join(",")}
          items={owing}
          now={now}
          canClose={onWorkScreen}
          onClose={() => setOpenByHand(false)}
          onSaved={() => {
            setOpenByHand(false);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function ReasonsDialog({
  items,
  now,
  canClose,
  onClose,
  onSaved,
}: {
  items: DeadlineItem[];
  now: number;
  canClose: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [bodies, setBodies] = React.useState<Record<string, string>>({});
  const [choice, setChoice] = React.useState<RemindChoice>("1h");
  const [custom, setCustom] = React.useState(() => localInputValue(now + 3 * 3_600_000));
  const [busy, setBusy] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<Record<string, string>>({});

  const customMs = Date.parse(`${custom}:00+05:30`);
  const remindAt = remindAtFor(choice, now, Number.isFinite(customMs) ? customMs : null);
  const problems = items.map((i) => remarkProblem(bodies[i.breachId] ?? "", remindAt, now));
  const remindProblem = remarkProblem("x".repeat(MIN_REMARK_CHARS), remindAt, now);
  const ready = problems.every((p) => p === null);
  const first = items[0]?.breachId;

  async function save() {
    setBusy(true);
    const r = await explainAccountsDelays({
      items: items.map((i) => ({ breachId: i.breachId, body: bodies[i.breachId] ?? "" })),
      remind: choice,
      customAt: choice === "custom" ? new Date(customMs).toISOString() : null,
    });
    setBusy(false);
    if (!r.ok) {
      setServerErrors(Object.fromEntries((r.fieldErrors ?? []).map((f) => [f.field, f.message])));
      toast.push(r.error, "error");
      return;
    }
    toast.push(r.message ?? "Saved.");
    onSaved();
  }

  return (
    <Modal
      open
      width={720}
      // Nothing closes it but answering — except on a work screen, where it was opened by hand.
      onClose={canClose ? onClose : () => {}}
      title={
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-danger" />
            {items.length === 1 ? "This is past its deadline" : `${items.length} items are past their deadline`}
          </div>
          <p className="mt-1 text-sm font-normal text-muted">
            The admins have been told. Decide it now, or say why it is not done yet and when to ask you again.
          </p>
        </div>
      }
      footer={
        <>
          {canClose ? (
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Back to the queue
            </Button>
          ) : null}
          <Button variant="primary" onClick={save} disabled={!ready || busy}>
            {busy ? "Saving…" : items.length === 1 ? "Save reason" : `Save ${items.length} reasons`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {items.map((i) => {
          const body = bodies[i.breachId] ?? "";
          const err = serverErrors[i.breachId];
          const short = body.trim().length > 0 && body.trim().length < MIN_REMARK_CHARS;
          return (
            <div key={i.breachId} className="rounded-[6px] border border-line p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="danger">{i.kindLabel}</Badge>
                    <span className="text-xs text-muted">waited {i.waitedLabel} of working time · due {fmt(i.dueAt)}</span>
                  </div>
                  <div className="mt-1 truncate text-sm font-medium text-ink" title={i.description}>
                    {i.description.split(" · ").slice(1).join(" · ") || i.description}
                  </div>
                </div>
                <Link href={i.href} className="shrink-0 text-sm font-medium text-brand hover:underline" onClick={onClose}>
                  Open and decide →
                </Link>
              </div>
              {i.adminNote ? (
                <div className="mt-2 rounded-[4px] bg-warn-soft px-2.5 py-1.5 text-xs text-warn-ink">
                  <b>{i.adminNote.by}</b> asked {fmt(i.adminNote.at)}: “{i.adminNote.body}”
                </div>
              ) : null}
              {i.lastRemark ? (
                <div className="mt-2 text-xs text-muted">
                  Last reason, {i.lastRemark.by}, {fmt(i.lastRemark.at)}: “{i.lastRemark.body}”
                </div>
              ) : null}
              <Textarea
                className="mt-2 w-full"
                rows={2}
                maxLength={1000}
                placeholder="Why is this not done yet? e.g. Waiting for the bank statement to show the transfer"
                value={body}
                invalid={!!err || short}
                onChange={(e) => setBodies((b) => ({ ...b, [i.breachId]: e.target.value }))}
              />
              <div className="mt-1 flex items-center justify-between text-xs">
                <span className={cx(err || short ? "text-danger" : "text-muted")}>
                  {err ?? (short ? `At least ${MIN_REMARK_CHARS} characters` : "Required")}
                </span>
                {i.breachId === first && items.length > 1 && body.trim().length >= MIN_REMARK_CHARS ? (
                  <button
                    type="button"
                    className="cursor-pointer text-brand hover:underline"
                    onClick={() => setBodies(Object.fromEntries(items.map((x) => [x.breachId, body])))}
                  >
                    Use this reason for all {items.length}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}

        <div className="rounded-[6px] bg-canvas p-3">
          <div className="text-sm font-medium text-ink">Remind me</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {REMIND_CHOICES.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setChoice(c.key)}
                className={cx(
                  "cursor-pointer rounded-full border px-3 py-1 text-sm",
                  choice === c.key ? "border-brand bg-brand text-white" : "border-line-strong bg-surface text-body hover:bg-canvas",
                )}
              >
                {c.label}
              </button>
            ))}
            {choice === "custom" ? (
              <input
                type="datetime-local"
                className="h-8 rounded-[4px] border border-line-strong bg-surface px-2 text-sm"
                value={custom}
                min={localInputValue(now + 60_000)}
                max={localInputValue(now + MAX_REMIND_DAYS * 86_400_000)}
                onChange={(e) => setCustom(e.target.value)}
              />
            ) : null}
          </div>
          <div className={cx("mt-2 text-xs", remindProblem ? "text-danger" : "text-muted")}>
            {remindProblem ?? (remindAt ? `You will be asked again ${fmt(new Date(remindAt).toISOString())} if it is still not decided. The admins keep being told until it is.` : "")}
          </div>
        </div>
      </div>
    </Modal>
  );
}
