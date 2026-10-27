"use client";

import * as React from "react";
import { Modal } from "./modal";
import { Badge, Button, Input, cx } from "./primitives";
import { previewImpact } from "@/lib/actions/impact";
import {
  EFFECT_WORDS,
  typedMatches,
  type ImpactConfirmation,
  type ImpactEffect,
  type ImpactReport,
} from "@/lib/impact/types";
import type { Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * THE CONFIRM THAT SAYS WHAT ELSE MOVES.
 *
 * A delete used to be "Are you sure?" over the one row that was clicked. This
 * reads the impact report — everything in every app that goes, unlinks or
 * changes with it — and the button stays shut until the person has typed the
 * record's name, which is the point at which they have read the list rather
 * than clicked through it.
 *
 * The confirmation carries the report's fingerprint, and the act checks the
 * report again before it writes. If somebody added an order while this was
 * open, the act answers `conflict`, and this shows the new list and asks
 * again — nobody confirms one picture and gets another.
 *
 * Mount it with a `key` per record: it loads on mount and starts clean.
 * ------------------------------------------------------------------------- */

const TONE: Record<ImpactEffect, "danger" | "warn" | "neutral" | "brand" | "muted"> = {
  deleted: "danger",
  unlinked: "warn",
  changed: "neutral",
  phones: "brand",
  kept: "muted",
};

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; report: ImpactReport };

export function ImpactDialog({
  kind,
  id,
  onClose,
  onConfirm,
  confirmLabel,
}: {
  kind: string;
  id: string;
  onClose: () => void;
  /** Runs the act with the confirmation. A `conflict` answer reloads the list. */
  onConfirm: (confirmation: ImpactConfirmation) => Promise<Result<unknown>>;
  /** The button's words where the report's own verb is not enough ("Delete forever"). */
  confirmLabel?: string;
}) {
  const [loaded, setLoaded] = React.useState<Loaded>({ state: "loading" });
  const [round, setRound] = React.useState(0);
  const [changed, setChanged] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    previewImpact(kind, id).then(
      (res) => {
        if (!alive) return;
        setLoaded(res.ok ? { state: "ready", report: res.data } : { state: "error", message: res.error });
      },
      () => alive && setLoaded({ state: "error", message: "Could not work out what this affects. Try again." }),
    );
    return () => {
      alive = false;
    };
  }, [kind, id, round]);

  const report = loaded.state === "ready" ? loaded.report : null;
  const matches = report ? typedMatches(typed, report.confirmWord) : false;
  const blocked = Boolean(report?.blockers.length);

  async function confirm() {
    if (!report || !matches || blocked) return;
    setBusy(true);
    setError(null);
    let res: Result<unknown>;
    try {
      res = await onConfirm({ typed, fingerprint: report.fingerprint });
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : "That could not be done." };
    } finally {
      setBusy(false);
    }
    if (res.ok) {
      onClose();
      return;
    }
    if (res.code === "conflict") {
      /* The list moved under them: show the new one and ask again. */
      setChanged(true);
      setTyped("");
      setLoaded({ state: "loading" });
      setRound((n) => n + 1);
      return;
    }
    setError(res.error);
  }

  /* Grouped by app, in the order the report already sorted them. */
  const byApp = new Map<string, ImpactReport["items"]>();
  for (const item of report?.items ?? []) byApp.set(item.app, [...(byApp.get(item.app) ?? []), item]);

  const verb = confirmLabel ?? report?.verb ?? "Confirm";

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title={report ? `${report.verb} ${report.title}?` : "What this affects"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={confirm}
            disabled={!report || !matches || blocked || busy}
            title={
              blocked
                ? "This cannot be done — the reason is above."
                : !matches && report
                  ? `Type "${report.confirmWord}" to confirm.`
                  : undefined
            }
          >
            {busy ? "Working…" : verb}
          </Button>
        </>
      }
    >
      {loaded.state === "loading" ? (
        <p className="text-sm text-muted">Working out what this affects across MahekOne…</p>
      ) : loaded.state === "error" ? (
        <p className="rounded-[4px] bg-danger-soft px-3 py-2 text-sm text-danger">{loaded.message}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {changed ? (
            <p className="rounded-[4px] border border-warn bg-warn-soft px-3 py-2 text-sm text-warn-ink">
              Something changed since you opened this. This is what it affects now — read it again
              before confirming.
            </p>
          ) : null}

          {report!.blockers.length ? (
            <div className="rounded-[4px] border border-danger bg-danger-soft px-3 py-2.5 text-sm text-danger">
              <p className="font-medium">This cannot be done.</p>
              <ul className="mt-1 list-disc pl-5">
                {report!.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {byApp.size === 0 ? (
            <p className="text-sm text-body">
              Nothing else in MahekOne is attached to this. Only {report!.title} itself is affected.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-body">
                This does not stay where you pressed it. Across MahekOne, this is what moves with it:
              </p>
              {[...byApp.entries()].map(([app, items]) => (
                <section key={app} className="rounded-[4px] border border-line">
                  <header className="border-b border-line bg-canvas px-3 py-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
                    {app}
                  </header>
                  <ul className="divide-y divide-divider">
                    {items.map((item) => (
                      <li key={`${item.label}|${item.effect}`} className="px-3 py-2">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <Badge tone={TONE[item.effect]}>{EFFECT_WORDS[item.effect]}</Badge>
                          <span className="text-sm text-ink">
                            {item.effect === "kept" && item.count === 0 ? "" : `${item.count.toLocaleString("en-IN")} `}
                            {item.label}
                          </span>
                        </div>
                        {item.examples?.length ? (
                          <p className="mt-0.5 text-[13px] text-muted">
                            {item.examples.slice(0, 5).join(" · ")}
                            {item.count > item.examples.length ? " …" : ""}
                          </p>
                        ) : null}
                        {item.note ? <p className="mt-0.5 text-[13px] text-pretty text-body">{item.note}</p> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          {!report!.blockers.length ? (
            <label className="block">
              <span className="mb-1 block text-sm text-body">
                Type <span className="font-medium text-ink">{report!.confirmWord}</span> to confirm
              </span>
              <Input
                autoFocus
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void confirm();
                }}
                invalid={Boolean(error)}
                aria-label={`Type ${report!.confirmWord} to confirm`}
                className={cx("w-full")}
              />
            </label>
          ) : null}

          {error ? <p className="rounded-[4px] bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
