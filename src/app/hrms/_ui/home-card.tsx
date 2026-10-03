"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { hrmsCheckIn, hrmsCheckOut, hrmsRaiseLateHelp, type CheckResult } from "@/lib/actions/hrms-checkin";
import type { CheckInRefusal } from "@/lib/hrms/engines/attendance";
import { longDate } from "@/lib/format";
import { nowHM } from "@/lib/hrms/time";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { HIcon } from "./icons";

/* ---------------------------------------------------------------------------
 * The home card (design "Check in"). Location is read ONCE, when the button is
 * pressed, and sent to the server, which measures it against the office and
 * decides — the browser never judges its own distance. A refusal is drawn in
 * place with the one thing that fixes it: "I am late" raises the help request
 * from here rather than sending somebody to find another screen.
 * ------------------------------------------------------------------------- */

export type HomeState = {
  linked: boolean;
  name: string;
  date: string;
  qr: boolean;
  graceMinutes: number;
  nowMs: number;
  office?: string;
  officeHasPin?: boolean;
  official?: string;
  today?: {
    in: string;
    out: string | null;
    status: string;
    late: string;
    lateBad: boolean;
    remark: string;
    targetMin: number | null;
    inMin: number | null;
    workedMin: number | null;
    workDay: string;
    fullDayPercent: number;
    distance: string;
    worked: string;
  } | null;
};

export type WaitItem = { l: string; v: string; sub: string; tone: "danger" | "warn" | "brand" | "success" | "neutral"; href: string };

const DOT: Record<WaitItem["tone"], string> = {
  danger: "bg-danger",
  warn: "bg-warn",
  brand: "bg-brand",
  success: "bg-success",
  neutral: "bg-muted",
};

type Refused = { reason: CheckInRefusal | "error"; title: string; line: string };
type Fix = { lat: number | null; lng: number | null; accuracy: number | null };

function locate(): Promise<Fix | "denied"> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve({ lat: null, lng: null, accuracy: null });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => resolve(e.code === e.PERMISSION_DENIED ? "denied" : { lat: null, lng: null, accuracy: null }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

async function upload(file: File): Promise<string | null> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/hrms/attachments", { method: "POST", body: fd });
  if (!res.ok) return null;
  const j = (await res.json()) as { id?: string };
  return j.id ?? null;
}

function greeting(nowMs: number, name: string) {
  const h = Number(nowHM(new Date(nowMs)).slice(0, 2));
  return `Good ${h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"}, ${name.split(" ")[0]}`;
}

export function HomeCard({ state, wait, canHelp }: { state: HomeState; wait: WaitItem[]; canHelp: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<"" | "locating" | "saving">("");
  const [refused, setRefused] = useState<Refused | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [outConfirm, setOutConfirm] = useState(false);
  const [code, setCode] = useState("");
  const [qrOpen, setQrOpen] = useState(false);
  const [lateText, setLateText] = useState("");
  const t = state.today;

  async function finish(res: CheckResult) {
    setBusy("");
    if (!res.ok) {
      setRefused({ reason: "error", title: res.error, line: "" });
      return;
    }
    if (res.data.refusal) {
      setRefused({ reason: res.data.refusal, title: res.data.message ?? "", line: res.data.detail ?? "" });
      return;
    }
    setRefused(null);
    setPhoto(null);
    setOutConfirm(false);
    setQrOpen(false);
    if (res.message) toast.push(res.message);
    router.refresh();
  }

  async function act(kind: "in" | "out", qrCode?: string) {
    setRefused(null);
    let fix: Fix = { lat: null, lng: null, accuracy: null };
    if (!qrCode) {
      setBusy("locating");
      const f = await locate();
      if (f === "denied") {
        setBusy("");
        setRefused({
          reason: "denied",
          title: "Location is blocked for MahekOne",
          line: "Allow location for this site in your browser’s settings, then press the button again. HRMS reads it once, only when you check in or out.",
        });
        return;
      }
      fix = f;
    }
    setBusy("saving");
    const photoId = photo ? await upload(photo) : null;
    if (photo && !photoId) toast.push("The photograph did not upload — saving without it.", "error");
    const res = kind === "in" ? await hrmsCheckIn({ ...fix, photoId, code: qrCode ?? null }) : await hrmsCheckOut({ ...fix, photoId });
    await finish(res);
  }

  async function sendLate() {
    const res = await hrmsRaiseLateHelp(lateText);
    if (!res.ok) return toast.push(res.error, "error");
    toast.push(res.message ?? "Request sent");
    setLateText("");
    setRefused(null);
    router.refresh();
  }

  const nowMin = Number(nowHM(new Date(state.nowMs)).slice(0, 2)) * 60 + Number(nowHM(new Date(state.nowMs)).slice(3, 5));
  const liveWorked = t && !t.out && t.inMin != null ? Math.max(0, nowMin - t.inMin) : (t?.workedMin ?? 0);
  const pct = t?.targetMin ? Math.min(100, Math.round((liveWorked / t.targetMin) * 100)) : null;
  const workedLabel = t ? (t.out ? t.worked : `${Math.floor(liveWorked / 60)}h ${String(liveWorked % 60).padStart(2, "0")}m so far`) : "";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <section className="rounded-[8px] border border-line bg-surface p-5">
        <div className="text-[18px] font-semibold text-ink">{greeting(state.nowMs, state.name)}</div>
        <div className="mt-0.5 text-[13px] text-muted">{longDate(state.date)}</div>
        {state.linked ? (
          <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
            <span className={cx("rounded-full px-2 py-0.5 font-medium", t ? (t.out ? "bg-success-soft text-success" : "bg-brand-soft text-brand") : "bg-canvas text-body")}>
              {t ? (t.out ? "Checked out" : t.status === "Working" ? "Checked in" : t.status) : "Not checked in"}
            </span>
            <span className="text-muted">Office hours {state.official || "not set"}</span>
            {state.office ? <span className="text-muted">· {state.office}</span> : null}
          </div>
        ) : null}

        <div className="mt-5 grid gap-3">
          {!state.linked ? (
            <div className="rounded-[6px] border border-warn-line bg-warn-soft px-3.5 py-3 text-[13px] text-warn-ink">
              Your MahekOne account is not linked to an employee record yet, so you cannot check in. Ask HR to link it on the Access screen in the Admin Console.
            </div>
          ) : null}

          {busy === "locating" ? (
            <div className="flex items-center gap-2 text-[13px] text-body">
              <span className="size-2 animate-pulse rounded-full bg-brand" />
              Reading your location…
            </div>
          ) : null}

          {refused ? (
            <div className="rounded-[6px] border border-danger bg-danger-soft px-3.5 py-3">
              <div className="text-[14px] font-semibold text-danger">{refused.title}</div>
              {refused.line ? <div className="mt-1 text-[13px] text-body">{refused.line}</div> : null}
              {refused.reason === "late" && canHelp ? (
                <div className="mt-3 grid gap-2">
                  <textarea
                    value={lateText}
                    onChange={(e) => setLateText(e.target.value)}
                    rows={2}
                    placeholder="What happened? The person who resolves help requests decides and sets your check-in time."
                    className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-[13px]"
                  />
                  <div className="flex gap-2">
                    <button onClick={sendLate} disabled={!lateText.trim()} className="h-9 rounded-[4px] bg-brand px-3.5 text-[13px] font-medium text-white disabled:opacity-50">
                      Send “I am late today”
                    </button>
                    <button onClick={() => setRefused(null)} className="h-9 rounded-[4px] border border-line bg-surface px-3.5 text-[13px] font-medium text-body">
                      Close
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex gap-2">
                  {refused.reason === "outside" || refused.reason === "denied" ? (
                    <button onClick={() => act(t ? "out" : "in")} className="h-9 rounded-[4px] bg-brand px-3.5 text-[13px] font-medium text-white">
                      Try again
                    </button>
                  ) : null}
                  <button onClick={() => setRefused(null)} className="h-9 rounded-[4px] border border-line bg-surface px-3.5 text-[13px] font-medium text-body">
                    Close
                  </button>
                </div>
              )}
            </div>
          ) : null}

          {state.linked && !t ? (
            <div className="grid gap-2">
              <button
                onClick={() => act("in")}
                disabled={!!busy}
                className="flex h-14 items-center justify-center gap-2 rounded-[6px] bg-brand text-[16px] font-semibold text-white hover:bg-brand-hover disabled:opacity-60"
              >
                <HIcon n="clock" s={20} />
                {busy === "saving" ? "Checking in…" : "Check in"}
              </button>
              {state.qr ? (
                qrOpen ? (
                  <div className="flex gap-2">
                    <input
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="The code printed on the office QR"
                      className="h-9 flex-1 rounded-[4px] border border-line bg-surface px-2.5 text-[13px]"
                    />
                    <button onClick={() => act("in", code)} disabled={!code.trim() || !!busy} className="h-9 rounded-[4px] bg-brand px-3.5 text-[13px] font-medium text-white disabled:opacity-50">
                      Check in
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setQrOpen(true)} className="h-9 rounded-[4px] border border-line bg-surface text-[13px] font-medium text-body">
                    Enter the office QR code instead
                  </button>
                )
              ) : null}
              <PhotoPick photo={photo} onPick={setPhoto} />
            </div>
          ) : null}

          {t ? (
            <div className="grid gap-3">
              <div className="grid grid-cols-3 gap-3">
                <Fact l="Check in" v={t.in} />
                <Fact l="Check out" v={t.out ?? "—"} />
                <Fact l="Distance" v={t.distance || "—"} />
              </div>
              <div>
                <div className="flex justify-between text-[12px] text-body">
                  <span>{t.out ? "Worked" : "Working"} {workedLabel}</span>
                  <span className="text-muted">{pct != null ? `${pct}% of target · full day at ${t.fullDayPercent}%` : "No target hours set"}</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-canvas">
                  <div className={cx("h-full rounded-full", pct != null && pct >= t.fullDayPercent ? "bg-success" : "bg-brand")} style={{ width: `${pct ?? 0}%` }} />
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-[13px]">
                <span className={cx("font-medium", t.lateBad ? "text-danger" : "text-success")}>{t.late}</span>
                {t.remark ? <span className="text-muted">{t.remark}</span> : null}
              </div>
              {t.out ? (
                <div className="text-[13px] text-body">
                  Day: <span className="font-semibold">{t.workDay}</span>
                </div>
              ) : outConfirm ? (
                <div className="rounded-[6px] border border-line bg-canvas p-3">
                  <div className="text-[13px] text-body">Check out now? Your location is read once and compared with the office radius.</div>
                  <div className="mt-2">
                    <PhotoPick photo={photo} onPick={setPhoto} />
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => act("out")} disabled={!!busy} className="h-9 rounded-[4px] bg-brand px-3.5 text-[13px] font-medium text-white disabled:opacity-60">
                      {busy === "saving" ? "Checking out…" : "Check out"}
                    </button>
                    <button onClick={() => setOutConfirm(false)} className="h-9 rounded-[4px] border border-line bg-surface px-3.5 text-[13px] font-medium text-body">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setOutConfirm(true)} className="h-10 rounded-[6px] border border-brand bg-surface text-[14px] font-medium text-brand">
                  Check out
                </button>
              )}
            </div>
          ) : null}
          {state.linked && state.officeHasPin === false ? (
            <div className="text-[12px] text-muted">Your office has no location pin yet, so your distance cannot be measured. HR sets it on the Offices screen.</div>
          ) : null}
        </div>
      </section>

      <section className="rounded-[8px] border border-line bg-surface p-5">
        <div className="text-[14px] font-semibold text-ink">Waiting for you today</div>
        {wait.length === 0 ? <div className="mt-3 text-[13px] text-muted">Nothing is waiting for you. Everything you can act on today is done.</div> : null}
        <div className="mt-3 grid gap-2">
          {wait.map((w) => (
            <Link
              key={w.l}
              href={w.href}
              className="flex items-center gap-3 rounded-[6px] border border-line px-3 py-2.5 no-underline hover:border-brand hover:no-underline"
            >
              <span className={cx("size-2 shrink-0 rounded-full", DOT[w.tone])} />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] text-ink">{w.l}</span>
                {w.sub ? <span className="block text-[12px] text-muted">{w.sub}</span> : null}
              </span>
              <span className="text-[14px] font-semibold text-ink">{w.v}</span>
              <HIcon n="chev" s={16} className="text-muted" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function Fact({ l, v }: { l: string; v: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted">{l}</div>
      <div className="mt-0.5 text-[15px] font-semibold text-ink">{v}</div>
    </div>
  );
}

/** Optional photograph at either end — capture opens the camera on a phone. */
function PhotoPick({ photo, onPick }: { photo: File | null; onPick: (f: File | null) => void }) {
  return (
    <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body">
      <HIcon n="camera" s={16} />
      {photo ? `Photo added — ${photo.name.slice(0, 24)}` : "Add a photo (optional)"}
      <input type="file" accept="image/jpeg,image/png" capture="user" className="hidden" onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
    </label>
  );
}
