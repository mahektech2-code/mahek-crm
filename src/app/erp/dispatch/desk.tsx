"use client";

import { NavLink } from "@/components/shell/nav-link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import type { DispatchBoard, PickableBox } from "@/lib/erp/dispatch";
import type { ScanVerdict } from "@/lib/erp/engines/trace";
import { erpTraceHref } from "@/lib/erp/trace-links";
import { erpDispatchDecideOverride, erpDispatchRequestOverride, erpDispatchScan, erpDispatchUnscan, erpDispatchVerify } from "@/lib/actions/erp-trace";
import { Button, Card, cx, Input, Textarea } from "@/components/ui/primitives";
import { fd } from "@/lib/erp/ui";
import { useErpUi } from "../_ui/erp-ui";
import { Badge } from "../_ui/badge";
import { LinkButton, linkClass, SubTitle } from "../_ui/look";
import { PickBoxesButton } from "./pick-boxes";

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

export function DispatchDesk({ board, boxes, me, canDecide, administrator, canVerify, canAllocate, today }: { board: DispatchBoard; boxes: PickableBox[]; me: string; canDecide: boolean; administrator: boolean; canVerify: boolean; canAllocate: boolean; today: string }) {
  const router = useRouter();
  const ui = useErpUi();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [last, setLast] = useState<Last>(null);
  const [error, setError] = useState<{ title: string; text: string } | null>(null);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(today);
  const [vehicle, setVehicle] = useState("");
  const [driver, setDriver] = useState("");
  const [remark, setRemark] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const open = board.lines.filter((l) => !l.cancelled && !l.dispatched);
  const totalTarget = open.reduce((a, l) => a + l.target, 0);
  const totalScanned = open.reduce((a, l) => a + Math.min(l.scanned, l.target), 0);
  const gated = board.lines.filter((l) => l.gate && !l.dispatched);
  /* "Mark not verified" is an administrator's, and the line cannot be dispatched after it — so it is not waiting, and the panel says why. */
  const markedNot = board.lines.filter((l) => l.billed && !l.dispatched && l.verification === "Not Verify");
  const billedWaiting = board.lines.filter((l) => l.billed && !l.dispatched && l.verification !== "Not Verify");
  /* The invoice check is optional: a pending check holds nothing, a rejected invoice holds the order. */
  const invoiceWaiting = billedWaiting.filter((l) => l.invoiceCheck === "Rejected");
  const pendingOverrides = board.overrides.filter((o) => o.status === "Pending");

  const scan = (raw: string) => {
    const c = raw.trim();
    if (!c) return;
    setError(null);
    setFlash(null);
    start(async () => {
      const res = await erpDispatchScan(board.orderNo, c);
      if (!res.ok) {
        setError({ title: "Not scanned", text: res.error });
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
      if (!res.ok) setError({ title: "Not done", text: res.error ?? "That did not work." });
      else setFlash(res.message ?? "Done");
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-5">
          <Card className="overflow-hidden rounded-[10px]">
            {/* v4: who it is for, and how far through the boxes, said large. */}
            <div className="flex items-start justify-between gap-4 border-b border-divider px-5 py-4">
              <div className="min-w-0">
                <div className="truncate text-xl leading-7 font-bold text-ink">{board.delivery}</div>
                <div className="mt-0.5 text-meta text-muted">
                  Order <span className="font-mono">{board.orderNo}</span>
                  {board.delivery !== board.billing ? ` · billed to ${board.billing}` : ""}
                  {board.area ? ` · ${board.area}` : ""}
                  {board.transporter ? ` · ${board.transporter}` : ""}
                  {board.dispatchOn ? ` · leaves ${fd(board.dispatchOn)}` : ""}
                </div>
              </div>
              <div className="flex-none text-right">
                <div className="text-3xl leading-8 font-bold tracking-tight tabular-nums">
                  <span className="text-ink">{totalScanned}</span>
                  <span className="text-line-strong">/{totalTarget}</span>
                </div>
                <div className="text-xs text-muted">scanned</div>
              </div>
            </div>
            <div className="px-5 py-4">
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
                placeholder={open.length ? "Scan a box or lot QR, type its code, or pick boxes from the list" : "Nothing on this order is Ready to dispatch"}
                className="h-12 flex-1 rounded-lg border-2 border-brand bg-surface px-3.5 font-mono text-lg text-ink outline-none placeholder:text-faint"
              />
              <Button variant="primary" disabled={pending || !code.trim()} className="h-12">
                Scan
              </Button>
              {open.length ? (
                <PickBoxesButton
                  board={board}
                  boxes={boxes}
                  onDone={() => {
                    setLast(null);
                    setError(null);
                    router.refresh();
                  }}
                />
              ) : null}
            </form>
            <div className="mt-3.5 flex items-center gap-3">
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-divider">
                <span className="block h-full rounded-full bg-brand transition-[width]" style={{ width: `${totalTarget ? Math.round((100 * totalScanned) / totalTarget) : 0}%` }} />
              </span>
              <span className="flex-none text-meta text-body tabular-nums">
                {totalScanned} of {totalTarget} scanned
              </span>
            </div>
            </div>
            {board.lines.map((l) => (
              <div key={l.id} className={cx("flex items-center gap-4 border-t border-divider px-5 py-3", l.cancelled && "opacity-60")}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{l.skuName}</span>
                  <span className="block truncate text-meta text-muted">
                    {l.packLabel} · {l.alloc.length ? `Lots ${l.alloc.map((a) => `${a.lotCode} × ${a.qty}`).join(", ")}` : "No lot allocated yet — scanning allocates"}
                    {!l.unitsExist && l.alloc.length ? " · packed before box ids: no scan needed" : ""}
                  </span>
                  {/* Scanning allocates. Stock packed before box labels has
                      nothing to scan, so its lot is allocated here by hand —
                      the one place left that does it. */}
                  {canAllocate && !l.cancelled && !l.dispatched && !l.billed && l.alloc.reduce((a, x) => a + x.qty, 0) < l.target ? (
                    <LinkButton
                      onClick={() => ui.act("orders", { id: "allocate", l: "Allocate a lot by hand", loadsForm: true }, l.id)}
                      className="mt-0.5 text-meta"
                      title="For stock packed before box labels, which has nothing to scan"
                    >
                      Allocate a lot by hand (no box labels)
                    </LinkButton>
                  ) : null}
                </span>
                <span className="flex-none text-sm text-ink tabular-nums">
                  {l.scanned} / {l.target} <span className="text-muted">{l.boxed ? "boxes" : "units"}</span>
                </span>
                <span className="flex-none">
                  {l.dispatched ? (
                    <Badge label="Dispatched" tone="success" />
                  ) : l.cancelled ? (
                    <Badge label="Not Ready" tone="muted" />
                  ) : l.scanned >= l.target && l.target > 0 ? (
                    <Badge label="All scanned" tone="success" />
                  ) : l.gate ? (
                    <Badge label="To scan" tone="warn" />
                  ) : (
                    <Badge label="Scan optional" tone="neutral" />
                  )}
                </span>
                <span
                  aria-hidden
                  className={cx(
                    "flex h-5.5 w-5.5 flex-none items-center justify-center rounded-full text-xs",
                    l.dispatched || (l.scanned >= l.target && l.target > 0) ? "bg-success text-white" : "bg-divider text-line-strong",
                  )}
                >
                  ✓
                </span>
              </div>
            ))}
          </Card>

          {error ? <Panel tone="bad" title={error.title} text={error.text} /> : null}
          {flash ? <Panel tone="ok" title="Done" text={flash} /> : null}
          {last ? (
            last.verdict.ok ? (
              <Panel tone="ok" title="✓ Matched" text={last.verdict.message} />
            ) : (
              <Card className="overflow-hidden border-2 border-danger">
                <div className="bg-danger px-5 py-3 text-lg font-semibold text-white">{last.verdict.result === "mismatch" ? "✗ DISPATCH BLOCKED" : last.verdict.result === "duplicate" ? "✗ ALREADY SCANNED" : "✗ NOT ALLOWED"}</div>
                <div className="px-5 py-3">
                  <div className="text-base text-ink">{last.verdict.message}</div>
                  <div className="mt-1 font-mono text-meta text-muted">
                    <NavLink href={erpTraceHref(last.code)} className={linkClass()}>
                      {last.code}
                    </NavLink>
                  </div>
                  {last.verdict.result === "mismatch" && last.verdict.mismatch ? (
                    <div className="mt-3 border-t border-divider pt-3">
                      <SubTitle className="mb-1">Request an override</SubTitle>
                      <div className="mb-2 text-meta text-muted">Only somebody else holding the dispatch-override power can approve it. Once approved, scan the box again.</div>
                      <Textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        rows={2}
                        placeholder="Why must this box go: who agreed, what the customer was told"
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
            <SubTitle className="mb-0 border-b border-divider px-4 py-3">Boxes on this order ({board.units.length})</SubTitle>
            {board.units.length ? (
              board.units.map((u) => (
                <div key={u.id} className="flex items-center gap-3 border-b border-divider px-4 py-1.5 text-meta last:border-0">
                  <NavLink href={erpTraceHref(u.id)} className={linkClass("brand", "font-mono")}>
                    {u.id}
                  </NavLink>
                  <span className="min-w-0 flex-1 truncate text-body">
                    {u.sku} · lot {u.lotCode}
                    {u.by ? ` · ${u.by}` : ""}
                  </span>
                  {u.status === "dispatched" ? (
                    <Badge label="Dispatched" tone="success" />
                  ) : (
                    <LinkButton tone="danger" disabled={pending} onClick={() => act(() => erpDispatchUnscan(u.id))}>
                      Take off
                    </LinkButton>
                  )}
                </div>
              ))
            ) : (
              <div className="px-4 py-3 text-meta text-muted">Nothing scanned yet.</div>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card className="px-4 py-3">
            <SubTitle className="mb-0">Confirm dispatch</SubTitle>
            {!billedWaiting.length && markedNot.length ? (
              <div className="mt-1 text-meta text-warn-ink">An administrator marked this order not verified on Orders → Billing &amp; dispatch, so it cannot be confirmed here. Ask an ERP administrator.</div>
            ) : !billedWaiting.length ? (
              <div className="mt-1 text-meta text-muted">Nothing is billed and waiting. Bill the order on Orders → Ready to bill.</div>
            ) : invoiceWaiting.length ? (
              <div className="mt-1 text-meta text-warn-ink">
                Invoice {board.invoiceNo ?? ""} was rejected by the checker — it is corrected on Orders → Invoice check.
              </div>
            ) : gated.length ? (
              <div className="mt-1 text-meta text-warn-ink">{gated.map((l) => `${l.skuName}: ${l.gate}`).join("; ")}. Dispatch waits for every box.</div>
            ) : (
              <div className="mt-1 text-meta text-success">Invoice {board.invoiceNo ?? ""} entered, and every box is scanned and checked.</div>
            )}
            {canVerify ? (
              <div className="mt-3 flex flex-col gap-2">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Dispatch date" />
                <Input value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="Vehicle / tempo / truck no." aria-label="Vehicle number" />
                <Input value={driver} onChange={(e) => setDriver(e.target.value)} placeholder="Driver or transporter" aria-label="Driver or transporter" />
                <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="Remark or exception (optional)" aria-label="Dispatch remark" />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={pending || !billedWaiting.length || invoiceWaiting.length > 0 || gated.length > 0}
                  onClick={() => act(() => erpDispatchVerify(board.orderNo, { date, vehicle, driver, remark }))}
                >
                  Confirm dispatch
                </Button>
              </div>
            ) : (
              <div className="mt-2 text-meta text-muted">Billing &amp; dispatch is not on your account, so somebody in the office confirms the dispatch.</div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <SubTitle className="mb-0 border-b border-divider px-4 py-3">Overrides {pendingOverrides.length ? `· ${pendingOverrides.length} waiting` : ""}</SubTitle>
            {board.overrides.length ? (
              board.overrides.map((o) => {
                const mine = o.requestedById === me && !administrator;
                return (
                  <div key={o.id} className="border-b border-divider px-4 py-2.5 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-meta">{o.unitId}</span>
                      <Badge label={o.status} tone={o.status === "Pending" ? "warn" : o.status === "Declined" ? "danger" : "success"} />
                    </div>
                    <div className="text-meta text-body">
                      {o.mismatch === "size" ? "Pack size" : "Product"}: ordered {o.ordered}, scanned {o.scanned}
                    </div>
                    <div className="text-meta text-muted">
                      “{o.reason}” — {o.requestedBy ?? "?"}
                      {o.decidedBy ? ` · decided by ${o.decidedBy}${o.note ? `: ${o.note}` : ""}` : ""}
                    </div>
                    {o.status === "Pending" && canDecide ? (
                      mine ? (
                        <div className="mt-1 text-meta text-muted">You asked for this one; somebody else decides it.</div>
                      ) : (
                        <div className="mt-2 flex flex-col gap-1.5">
                          <Input
                            value={note[o.id] ?? ""}
                            onChange={(e) => setNote({ ...note, [o.id]: e.target.value })}
                            placeholder="Note (needed to decline)"
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
              <div className="px-4 py-3 text-meta text-muted">None. A box of the wrong product or pack size is stopped at the scan.</div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <SubTitle className="mb-0 border-b border-divider px-4 py-3">Scan log</SubTitle>
            {board.scans.length ? (
              board.scans.map((s, i) => (
                <div key={i} className="border-b border-divider px-4 py-1.5 last:border-0">
                  <div className="flex items-center gap-2 text-meta">
                    <Badge label={s.result} tone={s.result === "ok" ? "success" : s.result === "mismatch" || s.result === "duplicate" ? "danger" : "warn"} />
                    <span className="font-mono">{s.code}</span>
                  </div>
                  <div className="text-meta text-muted">
                    {s.message}
                    {s.by ? ` · ${s.by}` : ""}
                  </div>
                </div>
              ))
            ) : (
              <div className="px-4 py-3 text-meta text-muted">No scans yet.</div>
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
