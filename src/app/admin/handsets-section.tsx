"use client";

import * as React from "react";
import Link from "next/link";
import { ADMIN } from "@/lib/admin-routes";
import { Card } from "./_shell/kit";
import { FleetFrame } from "./handsets/fleet-frame";
import { phoneDisplay, stamp } from "@/lib/format";
import {
  ago,
  parseBuildLabel,
  presence,
  versionStatus,
  type HandsetRow,
  type HandsetsPayload,
  type VersionStatus,
} from "@/lib/handset-versions";
import { releaseHandsetFromConsole } from "@/lib/actions/handsets";
import { ReleaseButton } from "@/app/sales/logins/release-button";

/* ---------------------------------------------------------------------------
 * HANDSETS — which MBOS build every salesman's phone is running, live.
 *
 * Read every ten seconds while the tab is visible, and the moment it becomes
 * visible again. A handset reports its build on every request and syncs the
 * instant it launches, so an upgrade lands here on the first sync after it —
 * and the row lights up when it does, which is the point of watching a rollout.
 *
 * Builds from before the heartbeat say their version only at sign-in; those
 * rows say "as of sign-in" rather than passing an old reading off as live.
 * ------------------------------------------------------------------------- */

const POLL_MS = 10_000;
/** How long a row stays lit after its version changes under you. */
const FLASH_MS = 12_000;

type Filter = "all" | VersionStatus;
type Sort = "status" | "name" | "heard";

const STATUS_ORDER: Record<VersionStatus, number> = { behind: 0, unknown: 1, none: 2, latest: 3 };

const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  behind: "Behind",
  latest: "On the latest",
  unknown: "Version unknown",
  none: "No handset",
};

export function HandsetsSection({ tabCounts }: { tabCounts: { field: number; factory: number } }) {
  const [data, setData] = React.useState<HandsetsPayload | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [now, setNow] = React.useState<number | null>(null);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [sort, setSort] = React.useState<Sort>("status");
  const [q, setQ] = React.useState("");
  const [flash, setFlash] = React.useState<Record<string, number>>({});
  const seen = React.useRef<Map<string, string | null> | null>(null);
  /* Bumped after a release, so the table re-reads at once rather than
     showing the old binding for up to ten seconds. */
  const [reloadKey, setReloadKey] = React.useState(0);

  /* The table's clock — read in an effect, never during render. */
  React.useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  React.useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const read = async () => {
      if (timer) clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch("/api/admin/handsets", { cache: "no-store", signal: controller.signal });
        const body = (await res.json().catch(() => null)) as (HandsetsPayload & { error?: string }) | null;
        if (!res.ok || !body) throw new Error(body?.error ?? "The handsets could not be read.");
        if (!live) return;

        /* Light up every row whose build moved since the last read — not on
           the first read, which has nothing to compare against. */
        const before = seen.current;
        const next = new Map(body.rows.map((r) => [r.userId, r.appVersion]));
        if (before) {
          const moved = body.rows.filter((r) => before.has(r.userId) && before.get(r.userId) !== r.appVersion);
          if (moved.length) {
            const at = Date.now();
            setFlash((f) => ({ ...f, ...Object.fromEntries(moved.map((r) => [r.userId, at])) }));
          }
        }
        seen.current = next;
        setData(body);
        setFailed(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError" && live) setFailed((e as Error).message);
      } finally {
        if (live && !document.hidden) timer = setTimeout(read, POLL_MS);
      }
    };

    const onVisible = () => {
      if (!document.hidden) void read();
      else if (timer) clearTimeout(timer);
    };

    void read();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reloadKey]);

  const reference = data?.reference ?? null;
  const rows = React.useMemo(
    () => (data?.rows ?? []).map((r) => ({ row: r, status: versionStatus(r, reference) })),
    [data, reference],
  );

  const counts = React.useMemo(() => {
    const c: Record<VersionStatus, number> = { latest: 0, behind: 0, unknown: 0, none: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const shown = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = rows.filter(
      ({ row, status }) =>
        (filter === "all" || status === filter) &&
        (!needle ||
          [row.name, row.phone, row.email, row.model, row.appVersion]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(needle))),
    );
    const heard = (r: HandsetRow) => (r.lastHeardAt ? Date.parse(r.lastHeardAt) : 0);
    return list.sort((a, b) => {
      if (sort === "name") return a.row.name.localeCompare(b.row.name);
      if (sort === "heard") return heard(b.row) - heard(a.row);
      return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.row.name.localeCompare(b.row.name);
    });
  }, [rows, filter, q, sort]);

  const low = data?.lowBatteryPercent ?? 20;
  const facts = React.useMemo(
    () => ({
      field: rows.filter((r) => r.row.deviceId).length,
      stopped: rows.filter((r) => r.row.deviceId && r.row.trackerStalledAt).length,
      restricted: rows.filter((r) => r.row.deviceId && locationTone(r.row) !== "g" && locationTone(r.row) !== null).length,
      lowBattery: rows.filter((r) => r.row.deviceId && r.row.batteryPercent != null && r.row.batteryPercent < low).length,
      noArea: rows.filter((r) => r.row.hasArea === false).length,
    }),
    [rows, low],
  );

  return (
    <FleetFrame
      tab="field"
      counts={tabCounts}
      search={{ value: q, onChange: setQ, placeholder: "Person or build" }}
      filters={{
        on: (filter !== "all" ? 1 : 0) + (sort !== "status" ? 1 : 0),
        groups: [
          {
            label: "Show",
            value: filter,
            onChange: (v) => setFilter(v as Filter),
            options: (Object.keys(FILTER_LABEL) as Filter[]).map((k) => ({
              value: k,
              label: FILTER_LABEL[k],
              count: k === "all" ? rows.length : counts[k as VersionStatus],
            })),
          },
          {
            label: "Sort",
            value: sort,
            onChange: (v) => setSort(v as Sort),
            options: [
              { value: "status", label: "Behind first" },
              { value: "heard", label: "Last heard — newest" },
              { value: "name", label: "Name — A to Z" },
            ],
          },
        ],
      }}
      figures={[
        { label: "In the field", value: data ? facts.field : "—", sub: failed ? "Not updating — retrying" : undefined },
        {
          label: "On latest build",
          value: data ? counts.latest : "—",
          sub: reference ? `Latest ${reference}` : undefined,
        },
        { label: "Trail stopped", value: data ? facts.stopped : "—", tone: facts.stopped ? "danger" : undefined },
        { label: "Location restricted", value: data ? facts.restricted : "—", tone: facts.restricted ? "warn" : undefined },
        { label: "Low battery", value: data ? facts.lowBattery : "—", tone: facts.lowBattery ? "warn" : undefined },
        { label: "No area set", value: data ? facts.noArea : "—" },
      ]}
    >
      <Card>
        {failed && !data ? (
          <div className="px-5 py-8 text-center text-[13px] text-danger">{failed}</div>
        ) : !data ? (
          <div className="px-5 py-10 text-center text-[13px] text-muted">Reading every handset…</div>
        ) : shown.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13px] text-muted">
            {rows.length ? "Nobody matches." : "Nobody has the Salesman App yet."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <FTH>Person</FTH>
                  <FTH>Build</FTH>
                  <FTH>Last heard</FTH>
                  <FTH>Battery</FTH>
                  <FTH>Location · GPS · Sync</FTH>
                  <FTH>Queued fixes</FTH>
                  <FTH>Status</FTH>
                  <FTH> </FTH>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ row, status }) => (
                  <HandsetLine
                    key={row.userId}
                    row={row}
                    status={status}
                    now={now}
                    low={low}
                    lit={!!(now && flash[row.userId] && now - flash[row.userId] < FLASH_MS)}
                    onReleased={() => setReloadKey((k) => k + 1)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </FleetFrame>
  );
}

/* ------------------------------------------------------------------ pieces */

function FTH({ children }: { children: React.ReactNode }) {
  return <th className="bg-ink px-3.5 py-2.5 text-left text-xs font-semibold whitespace-nowrap text-white normal-case">{children}</th>;
}

function FTD({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={`h-[52px] border-b border-divider px-3.5 whitespace-nowrap ${className ?? ""}`}>{children}</td>;
}

type IcTone = "g" | "a" | "x";
const IC_BG: Record<IcTone, string> = { g: "bg-success-soft", a: "bg-warn-soft", x: "bg-danger-soft" };
const IC_FG: Record<IcTone, string> = { g: "#1d7a45", a: "#8a5c05", x: "#b3261e" };

/** The location permission as a tile tone: always is green, while-using amber, off or refused red. */
function locationTone(r: HandsetRow): IcTone | null {
  if (r.locationServicesEnabled === false) return "x";
  const p = r.locationPermission;
  if (!p) return null;
  if (p === "always") return "g";
  if (p === "while_using" || p === "whenInUse" || p === "foreground" || p === "restricted") return "a";
  return "x";
}

function locationWords(r: HandsetRow): string {
  if (r.locationServicesEnabled === false) return "Location switched off";
  const p = r.locationPermission;
  if (p === "always") return "Location always";
  if (!p) return "Location not reported";
  if (p === "while_using" || p === "whenInUse" || p === "foreground") return 'Location "while using"';
  if (p === "restricted") return "Location restricted";
  return "Location refused";
}

function Ic({ tone, title, d }: { tone: IcTone; title: string; d: string }) {
  return (
    <span title={title} aria-label={title} className={`inline-flex h-[26px] w-[26px] items-center justify-center rounded-[6px] ${IC_BG[tone]}`}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={IC_FG[tone]} strokeWidth="2" aria-hidden>
        <path d={d} />
      </svg>
    </span>
  );
}

const PIN = "M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4";
const TRAIL = "M3 12h4l3-8 4 16 3-8h4";
const SYNC = "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5";

function Battery({ pct, charging, low }: { pct: number; charging: boolean | null | undefined; low: number }) {
  const colour = pct < low / 2 ? "#b3261e" : pct < low ? "#d9930d" : "#1d7a45";
  return (
    <span className="inline-flex items-center gap-1.5" title={charging ? "Charging" : undefined}>
      <i className="relative inline-block h-3 w-[26px] rounded-[3px] border-[1.5px] border-muted">
        <b className="absolute top-px bottom-px left-px rounded-[1px]" style={{ width: `${Math.max(4, Math.min(100, pct)) * 0.82}%`, background: colour }} />
      </i>
      {pct}%
    </span>
  );
}

type Verdict = { tone: "ok" | "warn" | "danger" | "muted"; text: string };

/** The one thing to say about a phone, worst first. A healthy phone says OK. */
function verdict(row: HandsetRow, status: VersionStatus, now: number | null, low: number): Verdict {
  if (!row.deviceId) return { tone: "muted", text: "No handset" };
  if (row.trackerStalledAt) return { tone: "danger", text: `Trail stopped ${clockAt(row.trackerStalledAt)}` };
  const loc = locationTone(row);
  if (loc === "x" || loc === "a") return { tone: "danger", text: locationWords(row) };
  if (status === "behind") return { tone: "warn", text: "Behind" };
  if (row.batteryPercent != null && row.batteryPercent < low) return { tone: "warn", text: `Battery ${row.batteryPercent}%` };
  if (row.hasArea === false) return { tone: "warn", text: "No area set" };
  if (now && presence(row.lastHeardAt, now) === "quiet") return { tone: "muted", text: "Quiet" };
  return { tone: "ok", text: "OK" };
}

const PILL_CLS: Record<Verdict["tone"], string> = {
  ok: "bg-success-soft text-success",
  warn: "bg-warn-soft text-warn-ink",
  danger: "bg-danger-soft text-danger",
  muted: "bg-[#eef1f6] text-[#4a5670]",
};

function clockAt(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

function HandsetLine({
  row,
  status,
  now,
  low,
  lit,
  onReleased,
}: {
  row: HandsetRow;
  status: VersionStatus;
  now: number | null;
  low: number;
  lit: boolean;
  onReleased: () => void;
}) {
  const label = parseBuildLabel(row.appVersion);
  const p = now ? presence(row.lastHeardAt, now) : "never";
  const v = verdict(row, status, now, low);
  const loc = locationTone(row);
  const bg = lit ? "bg-success-soft" : v.tone === "danger" ? "bg-[#fff7f6]" : "hover:bg-canvas";

  return (
    <tr className={`transition-colors duration-700 ${bg}`}>
      <FTD>
        <b className="font-semibold text-ink">{row.name}</b>
        <div className="text-muted">{row.deviceId ? (row.model ?? "Model not reported") : (row.phone ? phoneDisplay(row.phone) : (row.email ?? "No handset bound"))}</div>
      </FTD>
      <FTD className="font-mono text-[13px]">
        {label ? (
          <span title={[label.build ? `build ${label.build}` : null, label.bundle, row.appVersionReportedAt ? null : "as of sign-in"].filter(Boolean).join(" · ") || undefined}>
            {label.version}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </FTD>
      <FTD>
        <span title={row.lastHeardAt ? stamp(row.lastHeardAt) : undefined}>{now ? (p === "online" ? "Now" : cap(ago(row.lastHeardAt, now))) : "—"}</span>
      </FTD>
      <FTD>{row.batteryPercent != null ? <Battery pct={row.batteryPercent} charging={row.batteryCharging} low={low} /> : <span className="text-muted">—</span>}</FTD>
      <FTD>
        {row.deviceId ? (
          <span className="inline-flex gap-1.5">
            {loc ? <Ic tone={loc} title={locationWords(row)} d={PIN} /> : null}
            <Ic tone={row.trackerStalledAt ? "x" : "g"} title={row.trackerStalledAt ? `Trail stopped ${clockAt(row.trackerStalledAt)}` : "Trail running"} d={TRAIL} />
            <Ic tone={p === "online" || p === "recent" ? "g" : "a"} title={p === "online" ? "Syncing" : p === "recent" ? "Synced recently" : "Sync quiet"} d={SYNC} />
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </FTD>
      <FTD>
        {row.queuedPositions != null ? (
          row.queuedPositions > 100 ? (
            <b className="font-semibold text-ink">{row.queuedPositions.toLocaleString("en-IN")}</b>
          ) : (
            row.queuedPositions
          )
        ) : (
          <span className="text-muted">—</span>
        )}
      </FTD>
      <FTD>
        <span className={`inline-flex h-[22px] items-center rounded-full px-2 text-xs font-semibold ${PILL_CLS[v.tone]}`}>{v.text}</span>
        {lit ? <span className="ml-1.5 inline-flex h-[22px] items-center rounded-full bg-success-soft px-2 text-xs font-semibold text-success">Just upgraded</span> : null}
      </FTD>
      <FTD>
        <span className="flex items-center justify-end gap-2">
          {row.deviceId ? (
            <ReleaseButton
              deviceId={row.deviceId}
              salesmanName={row.name}
              handset={row.model ?? row.platform ?? "the handset he is signed in on"}
              release={releaseHandsetFromConsole}
              onReleased={onReleased}
            />
          ) : null}
          <Link
            href={ADMIN.person(row.userId)}
            className="inline-flex h-8 items-center rounded-control border border-line-strong bg-surface px-2.5 text-xs font-semibold text-ink no-underline hover:bg-[#f7f9fc] hover:no-underline"
          >
            Open
          </Link>
        </span>
      </FTD>
    </tr>
  );
}

function cap(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}
