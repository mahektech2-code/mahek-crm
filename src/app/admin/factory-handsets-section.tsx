"use client";

import * as React from "react";
import { Badge, Card, EmptyState, Input, Select, Td, Th } from "@/components/ui/primitives";
import { phoneDisplay, stamp } from "@/lib/format";
import { ago, presence, type Presence } from "@/lib/handset-versions";
import {
  OTA_LABEL,
  handsetIssues,
  handsetName,
  otaStatus,
  type FactoryHandsetRow,
  type FactoryHandsetsPayload,
  type Issue,
  type OtaStatus,
} from "@/lib/factory-handsets";

/* ---------------------------------------------------------------------------
 * FACTORY HANDSETS — every Factory App phone, as it last described itself.
 *
 * Read every fifteen seconds while the tab is visible. A phone reports every
 * five minutes while somebody is signed in, so "last seen" is minutes old at
 * best and the screen says how old rather than implying live. A row is a
 * phone: a shared station phone shows whoever was on it last. Workers no
 * phone has reported for are listed too, as "No phone yet".
 *
 * Problems are the things somebody can walk over and fix — a camera not
 * allowed, work stuck on the phone, a clock off, a huge font — and a phone
 * with none says nothing about them.
 * ------------------------------------------------------------------------- */

const POLL_MS = 15_000;

type Filter = "all" | OtaStatus | "problems";
const FILTER_LABEL: Record<Filter, string> = { all: "All", problems: "With a problem", ...OTA_LABEL };
const ORDER: Record<OtaStatus, number> = { apk: 0, ota: 1, unknown: 2, latest: 3, none: 4 };
const AREA: Record<string, string> = { head: "Production Head", mixing: "Mixing", filling: "Filling", packing: "Packing", dispatch: "Dispatch", qc: "QC" };

export function FactoryHandsetsSection() {
  const [data, setData] = React.useState<FactoryHandsetsPayload | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [now, setNow] = React.useState<number | null>(null);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);

  React.useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 5000);
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
        const res = await fetch("/api/admin/factory-handsets", { cache: "no-store", signal: controller.signal });
        const body = (await res.json().catch(() => null)) as (FactoryHandsetsPayload & { error?: string }) | null;
        if (!res.ok || !body) throw new Error(body?.error ?? "The factory handsets could not be read.");
        if (!live) return;
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
  }, []);

  const rows = React.useMemo(
    () => (data?.rows ?? []).map((r) => ({ row: r, status: otaStatus(r, data!.newest), issues: now ? handsetIssues(r, now) : [] })),
    [data, now],
  );
  const counts = React.useMemo(() => {
    const c: Record<OtaStatus | "problems", number> = { latest: 0, ota: 0, apk: 0, unknown: 0, none: 0, problems: 0 };
    for (const r of rows) {
      c[r.status] += 1;
      if (r.issues.length) c.problems += 1;
    }
    return c;
  }, [rows]);
  const shown = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter(({ row, status, issues }) =>
        (filter === "all" || (filter === "problems" ? issues.length > 0 : status === filter)) &&
        (!needle || [row.name, row.phone, row.model, row.manufacturer, row.appVersion, row.godown, row.deviceId].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle))),
      )
      .sort((a, b) => (b.issues.length ? 1 : 0) - (a.issues.length ? 1 : 0) || ORDER[a.status] - ORDER[b.status] || a.row.name.localeCompare(b.row.name));
  }, [rows, filter, q]);

  const phones = rows.length - counts.none;
  const newest = data?.newest;

  return (
    <div className="mt-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
        {failed ? (
          <span className="inline-flex h-7 items-center gap-2 rounded-full border border-danger/30 bg-danger-soft px-3 text-[12px] font-medium text-danger">Not updating — retrying</span>
        ) : (
          <span className="inline-flex h-7 items-center gap-2 rounded-full border border-success/25 bg-success-soft px-3 text-[12px] font-medium text-success">
            <span className="h-2 w-2 rounded-full bg-success" />
            Live · every 15 seconds
          </span>
        )}
        {newest?.version ? (
          <span>
            Newest app <span className="font-mono font-medium text-ink">{newest.version}</span>
            {newest.updateCreatedAt ? (
              <>
                {" "}· update <span className="font-mono text-ink">{newest.updateId?.slice(0, 8)}</span> of {stamp(newest.updateCreatedAt)}
              </>
            ) : (
              " · no over-the-air update on it yet"
            )}
            {" "}· the newest any phone runs
          </span>
        ) : data ? (
          <span>No phone has reported yet. Phones report once they have the update that adds this page.</span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="On the latest" value={counts.latest} sub={`of ${phones} ${phones === 1 ? "phone" : "phones"}`} tone="success" active={filter === "latest"} onClick={() => setFilter(filter === "latest" ? "all" : "latest")} />
        <Tile label="Update waiting" value={counts.ota} sub="applies when the app is reopened" tone={counts.ota ? "warn" : "neutral"} active={filter === "ota"} onClick={() => setFilter(filter === "ota" ? "all" : "ota")} />
        <Tile label="Needs the new APK" value={counts.apk} sub="an older app version" tone={counts.apk ? "danger" : "neutral"} active={filter === "apk"} onClick={() => setFilter(filter === "apk" ? "all" : "apk")} />
        <Tile label="With a problem" value={counts.problems} sub="camera, stuck work, clock…" tone={counts.problems ? "danger" : "neutral"} active={filter === "problems"} onClick={() => setFilter(filter === "problems" ? "all" : "problems")} />
        <Tile label="No phone yet" value={counts.none} sub="factory workers never reported" tone="neutral" active={filter === "none"} onClick={() => setFilter(filter === "none" ? "all" : "none")} />
      </div>

      <Card className="overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <div className="flex flex-wrap items-end gap-2.5 border-b border-line px-4 py-3">
          <div className="w-[260px]">
            <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Search</div>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone model, version, godown" className="h-8" />
          </div>
          <div className="w-[200px]">
            <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Show</div>
            <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="h-8">
              {(Object.keys(FILTER_LABEL) as Filter[]).map((k) => (
                <option key={k} value={k}>
                  {FILTER_LABEL[k]} · {k === "all" ? rows.length : counts[k]}
                </option>
              ))}
            </Select>
          </div>
          <span className="flex-1" />
          <span className="pb-1.5 text-[13px] text-muted">{data ? `${shown.length} of ${rows.length}` : ""}</span>
        </div>

        {failed && !data ? (
          <div className="px-5 py-8 text-center text-[13px] text-danger">{failed}</div>
        ) : !data ? (
          <div className="px-5 py-10 text-center text-[13px] text-muted">Reading every factory phone…</div>
        ) : shown.length === 0 ? (
          <EmptyState title={rows.length ? "Nothing matches" : "No factory workers yet"} body={rows.length ? "Try another filter or a shorter search." : "Give somebody a floor profile in HRMS or the Factory app in Access, and they are listed here."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th>Handset</Th>
                  <Th>App</Th>
                  <Th>Network and work waiting</Th>
                  <Th align="right">Scans today</Th>
                  <Th align="right">Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ row, status, issues }) => {
                  const key = row.deviceId ?? "u:" + row.userId;
                  return (
                    <React.Fragment key={key}>
                      <Line row={row} status={status} issues={issues} now={now} open={open === key} onToggle={() => setOpen(open === key ? null : key)} />
                      {open === key && row.deviceId ? <Details row={row} now={now} /> : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-line px-4 py-2.5 text-[12px] text-muted">
          A phone reports every five minutes while somebody is signed in, and when the app is opened. An over-the-air update downloads on one launch and applies on the next. Click a phone for everything it reported.
        </div>
      </Card>
    </div>
  );
}

const TONES = { success: "text-success", warn: "text-warn-ink", danger: "text-danger", neutral: "text-ink" } as const;

function Tile({ label, value, sub, tone, active, onClick }: { label: string; value: number; sub: string; tone: keyof typeof TONES; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`cursor-pointer rounded-[6px] border bg-surface px-4 py-3 text-left shadow-[0_1px_2px_rgba(22,22,22,0.06)] transition-colors hover:border-line-strong ${active ? "border-brand ring-2 ring-brand-soft" : "border-line"}`}
    >
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
      <div className={`mt-1 text-[26px] leading-8 font-semibold tabular-nums ${TONES[tone]}`}>{value}</div>
      <div className="text-[12px] text-muted">{sub}</div>
    </button>
  );
}

const PRESENCE: Record<Presence, string> = { online: "bg-success", recent: "bg-warn", quiet: "bg-line-strong", never: "bg-line-strong" };
const STATUS_TONE: Record<OtaStatus, "success" | "warn" | "danger" | "neutral"> = { latest: "success", ota: "warn", apk: "danger", unknown: "neutral", none: "neutral" };

function Line({ row, status, issues, now, open, onToggle }: { row: FactoryHandsetRow; status: OtaStatus; issues: Issue[]; now: number | null; open: boolean; onToggle: () => void }) {
  const p = now ? presence(row.lastSeenAt, now) : "never";
  const name = handsetName(row);
  return (
    <tr onClick={row.deviceId ? onToggle : undefined} className={`${row.deviceId ? "cursor-pointer" : ""} ${open ? "bg-canvas" : "hover:bg-canvas"} align-top`}>
      <Td className="py-3">
        <div className="text-sm font-medium text-ink">{row.name}</div>
        <div className="text-[12px] text-muted">
          {[row.area ? (AREA[row.area] ?? row.area) : null, row.roleLabel, row.phone ? phoneDisplay(row.phone) : null].filter(Boolean).join(" · ") || "—"}
        </div>
        {issues.length ? (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {issues.map((i) => (
              <li key={i.text} className={`text-[12px] font-medium ${i.tone === "danger" ? "text-danger" : "text-warn-ink"}`}>
                {i.text}
              </li>
            ))}
          </ul>
        ) : null}
      </Td>
      <Td className="py-3">
        {row.deviceId ? (
          <>
            <div className="text-[13px] text-ink">{name ?? "Model not reported"}</div>
            <div className="text-[12px] text-muted">
              {row.os === "android" ? `Android ${row.osVersion ?? "?"}${row.apiLevel ? ` (API ${row.apiLevel})` : ""}` : (row.os ?? "—")}
              {row.godown ? ` · ${row.godown}` : ""}
            </div>
          </>
        ) : (
          <span className="text-[13px] text-muted">No phone has reported for them</span>
        )}
      </Td>
      <Td className="py-3">
        {row.deviceId ? (
          <>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[13px] font-semibold text-ink">{row.appVersion ?? "?"}</span>
              <Badge tone={STATUS_TONE[status]}>{OTA_LABEL[status]}</Badge>
            </div>
            <div className="mt-0.5 text-[11px] text-muted">
              {row.updateId ? (
                <span className="rounded-[3px] bg-divider px-1 font-mono" title={row.updateCreatedAt ? `Published ${stamp(row.updateCreatedAt)}` : undefined}>
                  OTA {row.updateId.slice(0, 8)}
                  {row.updateCreatedAt ? ` · ${stamp(row.updateCreatedAt)}` : ""}
                </span>
              ) : row.embedded ? (
                <span className="rounded-[3px] bg-divider px-1 font-mono">APK bundle</span>
              ) : null}
            </div>
          </>
        ) : (
          <Badge tone="neutral">{OTA_LABEL.none}</Badge>
        )}
      </Td>
      <Td className="py-3">
        {row.deviceId ? (
          <>
            <div className="text-[13px] text-ink capitalize">{row.network ?? "—"}{row.internet === false ? " · no internet" : ""}</div>
            <div className="text-[12px] text-muted">
              {row.queuePending ? `${row.queuePending} waiting to send` : "Nothing waiting"}
              {row.queueHeld ? ` · ${row.queueHeld} held` : ""}
            </div>
          </>
        ) : (
          <span className="text-[13px] text-muted">—</span>
        )}
      </Td>
      <Td align="right" className="py-3">
        <div className="text-[13px] text-ink tabular-nums">{row.scansToday || "—"}</div>
        {row.medianWaitMs != null ? <div className="text-[12px] text-muted">wait {(row.medianWaitMs / 1000).toFixed(1)} s</div> : null}
      </Td>
      <Td align="right" className="py-3 whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-ink">
          <span className={`h-2 w-2 rounded-full ${PRESENCE[p]}`} />
          {now ? ago(row.lastSeenAt, now) : "—"}
        </span>
      </Td>
    </tr>
  );
}

function Details({ row, now }: { row: FactoryHandsetRow; now: number | null }) {
  const facts: [string, React.ReactNode][] = [
    ["Phone id", <span key="id" className="font-mono">{row.deviceId}</span>],
    ["First reported", row.firstSeenAt ? stamp(row.firstSeenAt) : "—"],
    ["Last reported", row.lastSeenAt ? `${stamp(row.lastSeenAt)}${now ? ` (${ago(row.lastSeenAt, now)})` : ""}` : "—"],
    ["Maker / brand / model", [row.manufacturer, row.brand, row.model].filter(Boolean).join(" / ") || "—"],
    ["Android", row.osVersion ? `${row.osVersion}${row.apiLevel ? `, API ${row.apiLevel}` : ""}` : "—"],
    ["App version", row.appVersion ?? "—"],
    ["Over-the-air update", row.updateId ? `${row.updateId}${row.updateCreatedAt ? `, published ${stamp(row.updateCreatedAt)}` : ""}` : row.embedded ? "None — running the APK's own bundle" : "—"],
    ["Update channel", row.channel ?? "—"],
    ["Network", `${row.network ?? "—"}${row.internet == null ? "" : row.internet ? ", internet reachable" : ", no internet"}`],
    ["Work waiting", row.queuePending ? `${row.queuePending}, oldest from ${row.queueOldestAt ? stamp(row.queueOldestAt) : "?"}` : "None"],
    ["Held by the server", String(row.queueHeld ?? 0)],
    ["Camera", row.camera ?? "—"],
    ["Screen", row.screen ? `${row.screen} points` : "—"],
    ["Font size", row.fontScalePct ? `${row.fontScalePct}%` : "—"],
    ["Clock", row.clockSkewMs == null ? "—" : Math.abs(row.clockSkewMs) < 5000 ? "Right" : `${Math.round(Math.abs(row.clockSkewMs) / 1000)} s ${row.clockSkewMs > 0 ? "fast" : "slow"}`],
    ["Language", row.lang ?? "—"],
    ["Loading scans today", `${row.scansToday}${row.lastScanAt ? `, last ${stamp(row.lastScanAt)}` : ""}${row.medianWaitMs != null ? `, median wait ${(row.medianWaitMs / 1000).toFixed(1)} s` : ""}`],
    ["Phone and server judged differently today", String(row.disagreeToday)],
  ];
  return (
    <tr className="bg-canvas">
      <td colSpan={6} className="px-4 pb-4">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 rounded-[6px] border border-line bg-surface px-4 py-3 sm:grid-cols-2">
          {facts.map(([k, v]) => (
            <div key={k} className="flex gap-3 text-[13px]">
              <dt className="w-[200px] shrink-0 text-muted">{k}</dt>
              <dd className="text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </td>
    </tr>
  );
}
