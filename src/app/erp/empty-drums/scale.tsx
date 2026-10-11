"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import type { DrumLot, RecentDrum, RecordedDrum } from "@/lib/erp/scrap";
import { DRUM_STATUS_LABEL, tareVariance, weightCheck } from "@/lib/erp/engines/scrap";
import { erpLink } from "@/lib/erp/registry";
import { erpEmptyDrumLookup, erpEmptyDrumRecord } from "@/lib/actions/erp-scrap";
import { Badge, Button, Card, cx } from "@/components/ui/primitives";

/**
 * The scale. One field for the label, one for the weight, and the answer drawn
 * large — the person here is holding a drum, not reading a screen. A hand
 * scanner types the lot and an Enter into the first box; the weight box takes
 * focus as soon as the lot is found.
 */

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

const kgText = (x: number) => `${x.toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;
const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${kgText(Math.abs(x))}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

export function EmptyDrumScale({
  recent,
  canOverride,
  previewing,
  limits,
  stock,
}: {
  recent: RecentDrum[];
  canOverride: boolean;
  previewing: boolean;
  limits: { min: number; max: number };
  stock: { mahek: number; vendor: number; review: number };
}) {
  const router = useRouter();
  const codeBox = useRef<HTMLInputElement>(null);
  const weightBox = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [lot, setLot] = useState<DrumLot | null>(null);
  const [scanned, setScanned] = useState("");
  const [weight, setWeight] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<RecordedDrum | null>(null);
  const [pending, start] = useTransition();
  /* Every lookup is numbered and only the latest may answer: a hand scanner
     can fire the next code before the last answer is back, and that scan must
     be acted on rather than dropped, without an older answer landing on top. */
  const asked = useRef(0);

  const reset = () => {
    setLot(null);
    setScanned("");
    setWeight("");
    setNote("");
    setCode("");
    setTimeout(() => codeBox.current?.focus(), 0);
  };

  const find = (raw: string) => {
    const c = raw.trim();
    if (!c) return;
    setError(null);
    setSaved(null);
    const mine = ++asked.current;
    void (async () => {
      const res = await erpEmptyDrumLookup(c);
      if (mine !== asked.current) return;
      if (!res.ok) {
        setLot(null);
        setError(res.error);
        beep(false);
        setCode("");
        codeBox.current?.focus();
        return;
      }
      setLot(res.data);
      setScanned(c);
      setCode("");
      if ("refusal" in res.data.next) beep(false);
      else setTimeout(() => weightBox.current?.focus(), 0);
    })();
  };

  const kg = weight.trim() === "" ? null : Number(weight);
  const check = weightCheck(kg, limits.min, limits.max);
  const outside = !check.ok && !check.missing;
  const variance = lot && kg != null && kg > 0 ? tareVariance(kg, lot.declaredTareKg) : null;
  const next = lot?.next;
  const canSave = !!lot && !!next && "seq" in next && kg != null && kg > 0 && (!outside || (canOverride && note.trim().length >= 8)) && !previewing;

  const save = () => {
    if (!lot || !canSave || pending) return;
    setError(null);
    start(async () => {
      const res = await erpEmptyDrumRecord({ code: scanned, weightKg: kg, exceptionNote: outside ? note : null });
      if (!res.ok) {
        setError(res.error);
        beep(false);
        return;
      }
      setSaved(res.data);
      beep(true);
      reset();
      /* Outside the transition: the stock tiles and today's list catch up on
         their own, and the next scan never waits for them. */
      setTimeout(() => router.refresh(), 0);
    });
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card className="px-5 py-4">
          <div className="mb-2 text-[12px] font-medium tracking-[0.04em] text-muted uppercase">1 · Scan the drum&apos;s lot label</div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              find(code);
            }}
            className="flex gap-2"
          >
            <input
              ref={codeBox}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              autoCapitalize="characters"
              placeholder="Scan the QR or type the lot number"
              className="h-12 min-w-0 flex-1 rounded-[4px] border-2 border-brand bg-surface px-3 font-mono text-lg text-ink outline-none"
            />
            <Button variant="primary" disabled={!code.trim()} className="h-12">
              Find
            </Button>
          </form>
          <div className="mt-1.5 text-[12px] text-muted">
            The lot alone takes its next unrecorded drum. To name one drum, add its number: <span className="font-mono">ASTOL1201/3</span>.
          </div>
          {error && !lot ? (
            <div className="mt-3 rounded-[4px] border-l-[3px] border-l-danger bg-danger-soft px-4 py-3 text-[14px] text-danger">
              {error}
            </div>
          ) : null}
        </Card>

        {saved ? (
          <Card className="border-l-[4px] border-l-success px-5 py-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-[22px] font-semibold text-success">Saved · ED-{saved.drumNo}</span>
              <span className="text-[15px] text-body">
                drum {saved.seq} of {saved.drums} · {saved.item} · lot <span className="font-mono">{saved.lot}</span>
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[14px] text-body">
              <Badge tone={saved.status === "available" ? "success" : saved.status === "returnable" ? "brand" : "warn"}>{saved.statusLabel}</Badge>
              <span>{kgText(saved.weightKg)}</span>
              {saved.varianceKg != null ? <span className="text-muted">· variance {signed(saved.varianceKg)} against the declared tare</span> : null}
            </div>
            {saved.status === "review" ? (
              <p className="mt-2 text-[13px] text-warn-ink">The GRN does not say who owns this lot&apos;s drums, so it waits for the Production Head to decide. Nothing else for you to do.</p>
            ) : saved.status === "returnable" ? (
              <p className="mt-2 text-[13px] text-muted">This drum belongs to the supplier. Keep it apart — it goes back to them and is never sold as scrap.</p>
            ) : null}
          </Card>
        ) : null}

        {lot ? (
          <Card className="px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[12px] font-medium tracking-[0.04em] text-muted uppercase">From the GRN</div>
                <div className="mt-1 text-[20px] leading-7 font-semibold text-ink">{lot.item}</div>
                <div className="text-[14px] text-body">
                  {lot.supplier} · lot <span className="font-mono">{lot.lot}</span> · PR {lot.prNumber} · received {lot.grnDate} · {lot.godown}
                </div>
              </div>
              <Badge tone={lot.ownership === "mahek" ? "brand" : lot.ownership === "vendor" ? "neutral" : "warn"} className="h-6 text-[12px]">
                {lot.ownershipLabel}
              </Badge>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Fact label="Drums on the GRN" value={lot.drums == null ? "Not recorded" : String(lot.drums)} />
              <Fact label="Declared tare (each)" value={lot.declaredTareKg == null ? "Not on the GRN" : kgText(lot.declaredTareKg)} />
              <Fact label="Already emptied" value={`${lot.registered.length}${lot.drums ? ` of ${lot.drums}` : ""}`} />
            </div>

            {lot.drums ? (
              <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Drums of this lot">
                {Array.from({ length: lot.drums }, (_, i) => i + 1).map((n) => {
                  const r = lot.registered.find((x) => x.seq === n);
                  const isNext = "seq" in lot.next && lot.next.seq === n;
                  return (
                    <span
                      key={n}
                      title={r ? `ED-${r.drumNo} · ${kgText(r.weightKg)} · ${r.statusLabel}${r.by ? ` · ${r.by}` : ""}` : isNext ? "This drum" : "Not emptied yet"}
                      className={cx(
                        "flex h-8 min-w-8 items-center justify-center rounded-[4px] border px-1.5 text-[13px] tabular-nums",
                        r ? "border-success-soft bg-success-soft text-success" : isNext ? "border-brand bg-brand-soft font-semibold text-[#5223E0]" : "border-line bg-surface text-muted",
                      )}
                    >
                      {n}
                    </span>
                  );
                })}
              </div>
            ) : null}

            {"refusal" in lot.next ? (
              <div className="mt-4 rounded-[4px] border-l-[3px] border-l-danger bg-danger-soft px-4 py-3 text-[14px] text-danger">
                {lot.next.refusal}
                {(() => {
                  const ask = lot.next;
                  const existing = "existing" in ask && ask.existing != null ? lot.registered.find((r) => r.seq === ask.existing) : null;
                  return existing ? (
                    <div className="mt-1 text-[13px] text-body">
                      It was saved as ED-{existing.drumNo} · {kgText(existing.weightKg)} · {DRUM_STATUS_LABEL[existing.status]}
                      {existing.by ? ` · by ${existing.by}` : ""} at {time(existing.at)}. Nothing has been added to stock again.
                    </div>
                  ) : (
                    <div className="mt-1 text-[13px] text-body">Nothing has been added to stock. If this drum really is from this lot, tell the Production Head.</div>
                  );
                })()}
                <div className="mt-3">
                  <Button onClick={reset}>Scan another drum</Button>
                </div>
              </div>
            ) : (
              <div className="mt-5 border-t border-divider pt-4">
                <div className="mb-2 text-[12px] font-medium tracking-[0.04em] text-muted uppercase">
                  2 · Weigh drum {lot.next.seq}
                  {lot.drums ? ` of ${lot.drums}` : ""} empty
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    save();
                  }}
                  className="flex flex-col gap-3"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="relative">
                      <input
                        ref={weightBox}
                        value={weight}
                        onChange={(e) => setWeight(e.target.value.replace(/[^0-9.]/g, ""))}
                        inputMode="decimal"
                        placeholder="0.0"
                        aria-label="Empty weight in kg"
                        className={cx(
                          "h-14 w-[180px] rounded-[4px] border-2 bg-surface pr-12 pl-3 text-right text-[26px] font-semibold tabular-nums text-ink outline-none",
                          outside ? "border-warn" : "border-brand",
                        )}
                      />
                      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[15px] text-muted">kg</span>
                    </div>
                    {variance ? (
                      <div className="text-[14px]">
                        <div className="text-muted">Variance against the declared {kgText(lot.declaredTareKg!)}</div>
                        <div className={cx("text-[18px] font-semibold tabular-nums", variance.kg === 0 ? "text-success" : Math.abs(variance.kg) >= 1 ? "text-warn-ink" : "text-body")}>
                          {signed(variance.kg)}
                          {variance.pct != null ? <span className="ml-1 text-[13px] font-normal text-muted">({variance.pct > 0 ? "+" : ""}{variance.pct}%)</span> : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {outside ? (
                    <div className="rounded-[4px] border-l-[3px] border-l-warn bg-warn-soft px-4 py-3 text-[14px] text-warn-ink">
                      {!check.ok ? check.reason : ""} Weigh it again — is the drum really empty?
                      {canOverride ? (
                        <textarea
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          rows={2}
                          placeholder="If the weight is right, say why to save it anyway"
                          className="mt-2 block w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
                        />
                      ) : (
                        <div className="mt-1 text-[13px]">If it really weighs this, the Production Head can let it through.</div>
                      )}
                    </div>
                  ) : null}
                  {error ? <div className="text-[14px] text-danger">{error}</div> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" disabled={pending || !canSave} className="h-11 px-6 text-[15px]" title={previewing ? "Nothing can be saved while previewing." : undefined}>
                      {pending ? "Saving…" : `Save drum ${lot.next.seq}`}
                    </Button>
                    <Button type="button" onClick={reset} className="h-11">
                      Cancel
                    </Button>
                  </div>
                </form>
              </div>
            )}
          </Card>
        ) : !saved ? (
          <Card className="px-5 py-6 text-[14px] text-muted">
            Scan a drum to begin. Record a drum the day its material is used up — later its label may be unreadable, and an unreadable drum cannot be recorded.
          </Card>
        ) : null}
      </div>

      <div className="flex flex-col gap-4">
        <Card className="px-5 py-4">
          <div className="text-[12px] font-medium tracking-[0.04em] text-muted uppercase">Empty drums now</div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Link href={erpLink("drumStock")} className="no-underline hover:no-underline">
              <Fact label="Mahek stock" value={String(stock.mahek)} tone="brand" />
            </Link>
            <Link href={erpLink("returnableDrums")} className="no-underline hover:no-underline">
              <Fact label="To return" value={String(stock.vendor)} />
            </Link>
            <Link href={erpLink("emptyDrums")} className="no-underline hover:no-underline">
              <Fact label="To decide" value={String(stock.review)} tone={stock.review ? "warn" : undefined} />
            </Link>
          </div>
        </Card>
        <Card className="overflow-hidden">
          <div className="border-b border-divider px-5 py-3 text-[12px] font-medium tracking-[0.04em] text-muted uppercase">
            Weighed by you today · {recent.length}
          </div>
          {recent.length ? (
            recent.map((r) => (
              <div key={r.drumNo} className="flex items-center gap-3 border-b border-divider px-5 py-2.5 text-[13px] last:border-0">
                <span className="w-[52px] flex-none font-mono text-ink">ED-{r.drumNo}</span>
                <span className="min-w-0 flex-1 truncate text-body" title={`${r.item} · lot ${r.lot} · drum ${r.seq}`}>
                  {r.item} · <span className="font-mono">{r.lot}</span>/{r.seq}
                </span>
                <span className="flex-none whitespace-nowrap tabular-nums text-body">{kgText(r.weightKg)}</span>
                <span className="w-[68px] text-right whitespace-nowrap text-muted tabular-nums">{time(r.at)}</span>
              </div>
            ))
          ) : (
            <div className="px-5 py-4 text-[13px] text-muted">Nothing weighed by you yet today.</div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "brand" | "warn" }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
      <div className={cx("mt-0.5 text-[20px] leading-7 font-semibold tabular-nums", tone === "brand" ? "text-[#5223E0]" : tone === "warn" ? "text-warn-ink" : "text-ink")}>{value}</div>
    </div>
  );
}
