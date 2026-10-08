"use client";

import * as React from "react";
import { Badge, Callout, Card, EmptyState, Input, Select, Td, Th } from "@/components/ui/primitives";
import { phoneDisplay, stamp } from "@/lib/format";
import {
  ago,
  parseBuildLabel,
  presence,
  versionStatus,
  type HandsetRow,
  type HandsetsPayload,
  type Presence,
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

export function HandsetsSection() {
  const [data, setData] = React.useState<HandsetsPayload | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = React.useState<number | null>(null);
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
        setFetchedAt(Date.now());
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

  const withHandset = rows.length - counts.none;
  const updatedAgo = fetchedAt && now ? Math.max(0, Math.round((now - fetchedAt) / 1000)) : null;

  return (
    <div className="mt-5 flex flex-col gap-4">
      {/* The live strip: the build everybody should be on, and how fresh this is. */}
      <div className="flex flex-wrap items-center gap-3">
        <LivePill failed={!!failed} updatedAgo={updatedAgo} />
        {data ? (
          <span className="text-[13px] text-muted">
            Latest build{" "}
            {reference ? (
              <span className="font-mono text-[13px] font-medium text-ink">{reference}</span>
            ) : (
              <span className="text-ink">not known yet</span>
            )}
            {data.referenceSource === "setting"
              ? " · set in Settings"
              : data.referenceSource === "newest"
                ? " · the newest any phone reports"
                : null}
          </span>
        ) : null}
      </div>

      {data && data.referenceSource !== "setting" ? (
        <Callout tone="brand">
          <div>
            Nobody has named the current build, so &ldquo;latest&rdquo; means the newest any phone is running.
            Set <span className="font-mono text-[12px]">mbos.sync.currentAppVersion</span> in Settings to the
            version you have released, and every phone short of it is marked behind — here and on the Live map.
          </div>
        </Callout>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="On the latest build"
          value={data ? `${counts.latest}` : "—"}
          sub={data ? `of ${withHandset} ${withHandset === 1 ? "handset" : "handsets"}` : ""}
          tone="success"
          meter={withHandset ? counts.latest / withHandset : 0}
          active={filter === "latest"}
          onClick={() => setFilter(filter === "latest" ? "all" : "latest")}
        />
        <Tile
          label="Behind"
          value={data ? `${counts.behind}` : "—"}
          sub={counts.behind ? "need the new build" : "nobody is behind"}
          tone={counts.behind ? "warn" : "neutral"}
          active={filter === "behind"}
          onClick={() => setFilter(filter === "behind" ? "all" : "behind")}
        />
        <Tile
          label="Version unknown"
          value={data ? `${counts.unknown}` : "—"}
          sub="never said which build"
          tone="neutral"
          active={filter === "unknown"}
          onClick={() => setFilter(filter === "unknown" ? "all" : "unknown")}
        />
        <Tile
          label="No handset"
          value={data ? `${counts.none}` : "—"}
          sub="granted MBOS, never signed in"
          tone={counts.none ? "danger" : "neutral"}
          active={filter === "none"}
          onClick={() => setFilter(filter === "none" ? "all" : "none")}
        />
      </div>

      <Card className="overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <div className="flex flex-wrap items-end gap-2.5 border-b border-line px-4 py-3">
          <div className="w-[260px]">
            <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Search</div>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, number, phone model or version"
              className="h-8"
            />
          </div>
          <div className="w-[180px]">
            <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Show</div>
            <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="h-8">
              {(Object.keys(FILTER_LABEL) as Filter[]).map((k) => (
                <option key={k} value={k}>
                  {FILTER_LABEL[k]}
                  {k === "all" ? ` · ${rows.length}` : ` · ${counts[k as VersionStatus]}`}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-[190px]">
            <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Sort</div>
            <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-8">
              <option value="status">Behind first</option>
              <option value="heard">Last heard — newest</option>
              <option value="name">Name — A to Z</option>
            </Select>
          </div>
          <span className="flex-1" />
          <span className="pb-1.5 text-[13px] text-muted">
            {data ? `${shown.length} of ${rows.length} ${rows.length === 1 ? "person" : "people"} with MBOS` : ""}
          </span>
        </div>

        {failed && !data ? (
          <div className="px-5 py-8 text-center text-[13px] text-danger">{failed}</div>
        ) : !data ? (
          <div className="px-5 py-10 text-center text-[13px] text-muted">Reading every handset…</div>
        ) : shown.length === 0 ? (
          <EmptyState
            title={rows.length ? "Nobody matches" : "Nobody has MBOS yet"}
            body={
              rows.length
                ? "Try another filter or a shorter search."
                : "Grant the Salesman App to somebody in People, and their handset will be listed here."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Salesperson</Th>
                  <Th>Handset</Th>
                  <Th>App version</Th>
                  <Th>Status</Th>
                  <Th>On this build</Th>
                  <Th align="right">Last heard</Th>
                  <Th align="right"> </Th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ row, status }) => (
                  <HandsetLine
                    key={row.userId}
                    row={row}
                    status={status}
                    now={now}
                    lit={!!(now && flash[row.userId] && now - flash[row.userId] < FLASH_MS)}
                    onReleased={() => setReloadKey((k) => k + 1)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-line px-4 py-2.5 text-[12px] text-muted">
          A phone reports its build on every sync and syncs the moment it opens, so an upgrade shows here within
          seconds of the app being reopened. Builds older than this feature report only when they sign in.
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function LivePill({ failed, updatedAgo }: { failed: boolean; updatedAgo: number | null }) {
  if (failed) {
    return (
      <span className="inline-flex h-7 items-center gap-2 rounded-full border border-danger/30 bg-danger-soft px-3 text-[12px] font-medium text-danger">
        <span className="h-2 w-2 rounded-full bg-danger" />
        Not updating — retrying
      </span>
    );
  }
  return (
    <span className="inline-flex h-7 items-center gap-2 rounded-full border border-success/25 bg-success-soft px-3 text-[12px] font-medium text-success">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
      </span>
      Live
      {updatedAgo !== null ? (
        <span className="font-normal text-success/80">· updated {updatedAgo < 2 ? "just now" : `${updatedAgo}s ago`}</span>
      ) : null}
    </span>
  );
}

const TILE_TONES = {
  success: { value: "text-success", bar: "bg-success" },
  warn: { value: "text-warn-ink", bar: "bg-warn" },
  danger: { value: "text-danger", bar: "bg-danger" },
  neutral: { value: "text-ink", bar: "bg-line-strong" },
} as const;

function Tile({
  label,
  value,
  sub,
  tone,
  meter,
  active,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  tone: keyof typeof TILE_TONES;
  meter?: number;
  active: boolean;
  onClick: () => void;
}) {
  const t = TILE_TONES[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`cursor-pointer rounded-[6px] border bg-surface px-4 py-3 text-left shadow-[0_1px_2px_rgba(22,22,22,0.06)] transition-colors hover:border-line-strong ${
        active ? "border-brand ring-2 ring-brand-soft" : "border-line"
      }`}
    >
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
      <div className={`mt-1 text-[26px] leading-8 font-semibold tabular-nums ${t.value}`}>{value}</div>
      <div className="text-[12px] text-muted">{sub}</div>
      {/* Every tile keeps the bar's room, so the four numbers sit on one line. */}
      <div className={`mt-2 h-1 overflow-hidden rounded-full ${meter !== undefined ? "bg-divider" : ""}`}>
        {meter !== undefined ? (
          <div className={`h-full rounded-full ${t.bar} transition-[width] duration-500`} style={{ width: `${Math.round(meter * 100)}%` }} />
        ) : null}
      </div>
    </button>
  );
}

const PRESENCE: Record<Presence, { dot: string; word: string }> = {
  online: { dot: "bg-success", word: "Syncing now" },
  recent: { dot: "bg-warn", word: "Recently" },
  quiet: { dot: "bg-line-strong", word: "Quiet" },
  never: { dot: "bg-line-strong", word: "Never" },
};

function HandsetLine({
  row,
  status,
  now,
  lit,
  onReleased,
}: {
  row: HandsetRow;
  status: VersionStatus;
  now: number | null;
  lit: boolean;
  onReleased: () => void;
}) {
  const label = parseBuildLabel(row.appVersion);
  const p = now ? presence(row.lastHeardAt, now) : "never";
  const bundle = label?.bundle;
  const live = Boolean(row.appVersionReportedAt);

  return (
    <tr className={`transition-colors duration-700 ${lit ? "bg-success-soft" : "hover:bg-canvas"}`}>
      <Td className="py-3">
        <div className="text-sm font-medium text-ink">{row.name}</div>
        <div className="text-[12px] text-muted">{row.phone ? phoneDisplay(row.phone) : (row.email ?? "—")}</div>
      </Td>
      <Td className="py-3">
        {row.deviceId ? (
          <>
            <div className="text-[13px] text-ink">{row.model ?? "Model not reported"}</div>
            <div className="text-[12px] text-muted capitalize">{row.platform ?? "—"}</div>
          </>
        ) : (
          <span className="text-[13px] text-muted">No handset bound</span>
        )}
      </Td>
      <Td className="py-3">
        {label ? (
          <>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[13px] font-semibold text-ink">{label.version}</span>
              {label.build ? <span className="text-[12px] text-muted">build {label.build}</span> : null}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
              {bundle ? (
                <span
                  className="rounded-[3px] bg-divider px-1 font-mono"
                  title={
                    bundle === "embedded"
                      ? "Running the bundle that came inside the APK"
                      : bundle === "updates off"
                        ? "This build cannot take over-the-air updates"
                        : "Running an over-the-air update"
                  }
                >
                  {bundle === "embedded" ? "APK bundle" : bundle === "updates off" ? "no OTA" : `OTA ${bundle}`}
                </span>
              ) : null}
              {!live ? (
                <span title="This build reports its version only when it signs in, so this is what it said then.">
                  as of sign-in
                </span>
              ) : null}
            </div>
          </>
        ) : row.deviceId ? (
          <span className="text-[13px] text-muted">Not reported</span>
        ) : (
          <span className="text-[13px] text-muted">—</span>
        )}
      </Td>
      <Td className="py-3">
        <StatusBadge status={status} />
        {lit ? (
          <Badge tone="success" className="ml-1.5">
            Just upgraded
          </Badge>
        ) : null}
      </Td>
      <Td className="py-3">
        {row.appVersionChangedAt ? (
          <div className="text-[13px] text-ink" title={stamp(row.appVersionChangedAt)}>
            Upgraded {now ? ago(row.appVersionChangedAt, now) : ""}
          </div>
        ) : row.boundAt ? (
          <div className="text-[13px] text-body" title={stamp(row.boundAt)}>
            Since sign-in · {now ? ago(row.boundAt, now) : ""}
          </div>
        ) : (
          <span className="text-[13px] text-muted">—</span>
        )}
      </Td>
      <Td align="right" className="py-3">
        <div className="flex items-center justify-end gap-2" title={row.lastHeardAt ? stamp(row.lastHeardAt) : undefined}>
          <span className="relative flex h-2 w-2">
            {p === "online" ? (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            ) : null}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${PRESENCE[p].dot}`} />
          </span>
          <span className="text-[13px] text-ink">{now ? ago(row.lastHeardAt, now) : "—"}</span>
        </div>
        <div className="text-[11px] text-muted">{PRESENCE[p].word}</div>
      </Td>
      {/* The sign-in refusal tells a salesman on a new phone to ask an admin
          to release the old one — this is where that admin is standing. Only
          a bound row has anything to release; the list carries active
          bindings only, so a released phone leaves the row on the next read. */}
      <Td align="right" className="py-3">
        {row.deviceId ? (
          <ReleaseButton
            deviceId={row.deviceId}
            salesmanName={row.name}
            handset={row.model ?? row.platform ?? "the handset he is signed in on"}
            release={releaseHandsetFromConsole}
            onReleased={onReleased}
          />
        ) : null}
      </Td>
    </tr>
  );
}

function StatusBadge({ status }: { status: VersionStatus }) {
  switch (status) {
    case "latest":
      return <Badge tone="success">Latest</Badge>;
    case "behind":
      return <Badge tone="warn">Behind</Badge>;
    case "unknown":
      return <Badge tone="neutral">Unknown</Badge>;
    default:
      return <Badge tone="muted">No handset</Badge>;
  }
}
