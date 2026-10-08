"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import type { DispatchBoard } from "@/lib/erp/dispatch";
import type { ScanVerdict } from "@/lib/erp/engines/trace";
import { erpTraceHref } from "@/lib/erp/trace-links";
import { erpDispatchDecideOverride, erpDispatchRequestOverride, erpDispatchScan, erpDispatchUnscan, erpDispatchVerify } from "@/lib/actions/erp-trace";
import { Badge, Button, Card, cx, Progress } from "@/components/ui/primitives";
import { useErpUi } from "../_ui/erp-ui";

/**
 * The scanning desk. A hand scanner types the code and an Enter into the box,
 * which keeps focus between scans; every scan is judged on the server and the
 * answer is drawn LARGE — green with the line it counted against, red with
 * what differs — and heard, because the person scanning is looking at a box,
 * not at the screen.
 */
type Last = { code: string; verdict: ScanVerdict } | null;

function beep(ok: boolean) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const a = new Ctx();
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = ok ? "sine" : "square";
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(a.destination);
    o.start();
    o.stop(a.currentTime + (ok ? 0.12 : 0.45));
    o.onended = () => void a.close();
  } catch {
    /* No sound is no harm: the panel says it. */
  }
}

export function DispatchDesk({ board, me, canDecide, administrator, canVerify, canAllocate, today }: { board: DispatchBoard; me: string; canDecide: boolean; administrator: boolean; canVerify: boolean; canAllocate: boolean; today: string }) {
  const router = useRouter();
  const ui = useErpUi();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [last, setLast] = useState<Last>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const open = board.lines.filter((l) => !l.cancelled && !l.dispatched);
  const totalTarget = open.reduce((a, l) => a + l.target, 0);
  const totalScanned = open.reduce((a, l) => a + Math.min(l.scanned, l.target), 0);
  const gated = board.lines.filter((l) => l.gate && !l.dispatched);
  const billedWaiting = board.lines.filter((l) => l.billed && !l.dispatched);
  const pendingOverrides = board.overrides.filter((o) => o.status === "Pending");

  const scan = (raw: string) => {
    const c = raw.trim();
    if (!c) return;
    setError(null);
    setFlash(null);
    start(async () => {
      const res = await erpDispatchScan(board.orderNo, c);
      if (!res.ok) {
        setError(res.error);
        beep(false);
      } else {
        setLast({ code: res.data.code, verdict: res.data.verdict });
        setReason("");
        beep(res.data.verdict.ok);
      }
      setCode("");
      router.refresh();
      input.current?.focus();
    });
  };

  const act = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "That did not work.");
      else setFlash(res.message ?? "Done");
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-4">
          <Card className="px-5 py-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                scan(code);
              }}
              className="flex gap-2"
            >
              <input
                ref={input}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                disabled={!open.length}
                placeholder={open.length ? "Scan a box QR, or type its id and press Enter" : "Nothing on this order is Ready to dispatch"}
                className="h-12 flex-1 rounded-[4px] border-2 border-brand bg-surface px-3 font-mono text-lg text-ink outline-none"
              />
              <Button variant="primary" disabled={pending || !code.trim()} className="h-12">
                Scan
              </Button>
            </form>
            <div className="mt-3 flex items-center gap-3">
              <span className="text-sm text-body">
                {totalScanned} of {totalTarget} scanned
              </span>
              <div className="flex-1">
                <Progress value={totalTarget ? Math.round((100 * totalScanned) / totalTarget) : 0} />
              </div>
            </div>
          </Card>

          {error ? <Panel tone="bad" title="Not scanned" text={error} /> : null}
          {flash ? <Panel tone="ok" title="Done" text={flash} /> : null}
          {last ? (
            last.verdict.ok ? (
              <Panel tone="ok" title="✓ Matched" text={last.verdict.message} />
            ) : (
              <Card className="overflow-hidden border-2 border-danger">
                <div className="bg-danger px-5 py-3 text-lg font-semibold text-white">{last.verdict.result === "mismatch" ? "✗ DISPATCH BLOCKED" : last.verdict.result === "duplicate" ? "✗ ALREADY SCANNED" : "✗ NOT ALLOWED"}</div>
                <div className="px-5 py-3">
                  <div className="text-base text-ink">{last.verdict.message}</div>
                  <div className="mt-1 font-mono text-[13px] text-muted">
                    <Link href={erpTraceHref(last.code)}>{last.code}</Link>
                  </div>
                  {last.verdict.result === "mismatch" ? (
                    <div className="mt-3 border-t border-divider pt-3">
                      <div className="mb-1 text-[13px] font-medium text-ink">Request an override</div>
                      <div className="mb-2 text-[12px] text-muted">Only somebody else holding the dispatch-override power can approve it. Once approved, scan the box again.</div>
                      <textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        rows={2}
                        placeholder="Why must this box go: who agreed, what the customer was told"
                        className="w-full rounded-[4px] border border-line px-2.5 py-2 text-sm outline-none focus:border-brand"
                      />
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setLast(null)}>
                          Cancel
                        </Button>
                        <Button size="sm" variant="danger" disabled={pending || reason.trim().length < 10} onClick={() => act(() => erpDispatchRequestOverride(board.orderNo, last.code, reason))}>
                          Request override
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </Card>
            )
          ) : null}

          <Card className="overflow-hidden">
            <div className="grid grid-cols-[1fr_80px_150px_110px] gap-3 border-b border-divider bg-canvas px-4 py-2 text-[12px] font-medium text-muted">
              <span>Line</span>
              <span>Pack</span>
              <span>Scanned</span>
              <span>State</span>
            </div>
            {board.lines.map((l) => (
              <div key={l.id} className={cx("grid grid-cols-[1fr_80px_150px_110px] items-center gap-3 border-b border-divider px-4 py-2.5 last:border-0", l.cancelled && "opacity-60")}>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{l.skuName}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {l.alloc.length ? `Lots ${l.alloc.map((a) => `${a.lotCode} × ${a.qty}`).join(", ")}` : "No lot allocated yet — scanning allocates"}
                    {!l.unitsExist && l.alloc.length ? " · packed before box ids: no scan needed" : ""}
                  </span>
                  {/* Scanning allocates. Stock packed before box labels has
                      nothing to scan, so its lot is allocated here by hand —
                      the one place left that does it. */}
                  {canAllocate && !l.cancelled && !l.dispatched && !l.billed && l.alloc.reduce((a, x) => a + x.qty, 0) < l.target ? (
                    <button
                      type="button"
                      onClick={() => ui.act("orders", { id: "allocate", l: "Allocate a lot by hand", loadsForm: true }, l.id)}
                      className="mt-0.5 cursor-pointer text-[12px] text-[#5223E0] hover:underline"
                      title="For stock packed before box labels, which has nothing to scan"
                    >
                      Allocate a lot by hand (no box labels)
                    </button>
                  ) : null}
                </span>
                <span className="text-sm text-body">{l.packLabel}</span>
                <span className="text-sm tabular-nums">
                  {l.scanned} / {l.target} {l.boxed ? "boxes" : "units"}
                </span>
                <span>
                  {l.dispatched ? (
                    <Badge tone="success">Dispatched</Badge>
                  ) : l.cancelled ? (
                    <Badge tone="muted">Not Ready</Badge>
                  ) : l.scanned >= l.target && l.target > 0 ? (
                    <Badge tone="success">All scanned</Badge>
                  ) : l.gate ? (
                    <Badge tone="warn">To scan</Badge>
                  ) : (
                    <Badge tone="neutral">Scan optional</Badge>
                  )}
                </span>
              </div>
            ))}
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-divider bg-canvas px-4 py-2 text-[13px] font-medium text-ink">Boxes on this order ({board.units.length})</div>
            {board.units.length ? (
              board.units.map((u) => (
                <div key={u.id} className="flex items-center gap-3 border-b border-divider px-4 py-1.5 text-[13px] last:border-0">
                  <Link href={erpTraceHref(u.id)} className="font-mono">
                    {u.id}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-body">
                    {u.sku} · lot {u.lotCode}
                    {u.by ? ` · ${u.by}` : ""}
                  </span>
                  {u.status === "dispatched" ? (
                    <Badge tone="success">Dispatched</Badge>
                  ) : (
                    <button type="button" className="text-[12px] text-danger hover:underline" disabled={pending} onClick={() => act(() => erpDispatchUnscan(u.id))}>
                      Take off
                    </button>
                  )}
                </div>
              ))
            ) : (
              <div className="px-4 py-3 text-sm text-muted">Nothing scanned yet.</div>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="px-4 py-3">
            <div className="text-[13px] font-medium text-ink">Dispatch verification</div>
            {!billedWaiting.length ? (
              <div className="mt-1 text-[13px] text-muted">Nothing is billed and waiting. Bill the lines on Orders → Under process &amp; ready, then verify here.</div>
            ) : gated.length ? (
              <div className="mt-1 text-[13px] text-warn-ink">{gated.map((l) => `${l.skuName}: ${l.gate}`).join("; ")}. Do Verified waits for every box.</div>
            ) : (
              <div className="mt-1 text-[13px] text-success">Every box is scanned and checked.</div>
            )}
            {canVerify ? (
              <div className="mt-3 flex items-center gap-2">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8.5 rounded-[4px] border border-line px-2 text-sm" />
                <Button size="sm" variant="primary" disabled={pending || !billedWaiting.length || gated.length > 0} onClick={() => act(() => erpDispatchVerify(board.orderNo, date))}>
                  Do Verified
                </Button>
              </div>
            ) : (
              <div className="mt-2 text-[12px] text-muted">Billing &amp; dispatch is not on your account, so somebody in the office verifies.</div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-divider bg-canvas px-4 py-2 text-[13px] font-medium text-ink">Overrides {pendingOverrides.length ? `· ${pendingOverrides.length} waiting` : ""}</div>
            {board.overrides.length ? (
              board.overrides.map((o) => {
                const mine = o.requestedById === me && !administrator;
                return (
                  <div key={o.id} className="border-b border-divider px-4 py-2.5 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px]">{o.unitId}</span>
                      <Badge tone={o.status === "Pending" ? "warn" : o.status === "Declined" ? "danger" : "success"}>{o.status}</Badge>
                    </div>
                    <div className="text-[12px] text-body">
                      {o.mismatch === "size" ? "Pack size" : "Product"}: ordered {o.ordered}, scanned {o.scanned}
                    </div>
                    <div className="text-[12px] text-muted">
                      “{o.reason}” — {o.requestedBy ?? "?"}
                      {o.decidedBy ? ` · decided by ${o.decidedBy}${o.note ? `: ${o.note}` : ""}` : ""}
                    </div>
                    {o.status === "Pending" && canDecide ? (
                      mine ? (
                        <div className="mt-1 text-[12px] text-muted">You asked for this one; somebody else decides it.</div>
                      ) : (
                        <div className="mt-2 flex flex-col gap-1.5">
                          <input
                            value={note[o.id] ?? ""}
                            onChange={(e) => setNote({ ...note, [o.id]: e.target.value })}
                            placeholder="Note (needed to decline)"
                            className="h-8 rounded-[4px] border border-line px-2 text-[13px]"
                          />
                          <div className="flex gap-2">
                            <Button size="sm" variant="primary" disabled={pending} onClick={() => act(() => erpDispatchDecideOverride(o.id, true, note[o.id] ?? ""))}>
                              Approve
                            </Button>
                            <Button size="sm" variant="secondary" disabled={pending || !(note[o.id] ?? "").trim()} onClick={() => act(() => erpDispatchDecideOverride(o.id, false, note[o.id] ?? ""))}>
                              Decline
                            </Button>
                          </div>
                        </div>
                      )
                    ) : null}
                  </div>
                );
              })
            ) : (
              <div className="px-4 py-3 text-[13px] text-muted">None. A box of the wrong product or pack size is stopped at the scan.</div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-divider bg-canvas px-4 py-2 text-[13px] font-medium text-ink">Scan log</div>
            {board.scans.length ? (
              board.scans.map((s, i) => (
                <div key={i} className="border-b border-divider px-4 py-1.5 last:border-0">
                  <div className="flex items-center gap-2 text-[12px]">
                    <Badge tone={s.result === "ok" ? "success" : s.result === "mismatch" || s.result === "duplicate" ? "danger" : "warn"}>{s.result}</Badge>
                    <span className="font-mono">{s.code}</span>
                  </div>
                  <div className="text-[12px] text-muted">
                    {s.message}
                    {s.by ? ` · ${s.by}` : ""}
                  </div>
                </div>
              ))
            ) : (
              <div className="px-4 py-3 text-[13px] text-muted">No scans yet.</div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Panel({ tone, title, text }: { tone: "ok" | "bad"; title: string; text: string }) {
  return (
    <Card className={cx("overflow-hidden border-2", tone === "ok" ? "border-success" : "border-danger")}>
      <div className={cx("px-5 py-2 text-base font-semibold text-white", tone === "ok" ? "bg-success" : "bg-danger")}>{title}</div>
      <div className="px-5 py-3 text-base text-ink">{text}</div>
    </Card>
  );
}
