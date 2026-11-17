import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { ADMIN } from "@/lib/admin-routes";
import { APP_TIMEZONE } from "@/lib/business-date";
import { definition } from "@/lib/config/registry";
import { settingAddress } from "@/lib/config/settings-schemas";
import { getConfig } from "@/lib/config/store";
import { nowMs } from "@/lib/format";
import { valueLine } from "@/lib/services/admin-console-service";
import { AdminPage } from "../_shell/admin-page";
import { adminContext, requirePlatformAdmin } from "../_shell/context";
import { Avatar, BtnLink, Card, CardHead, Mono, Pill } from "../_shell/kit";
import { CsvButton } from "../roles/csv-button";
import {
  KINDS,
  changeCounts,
  changeRows,
  settingHistory,
  type ChangeRow,
  type Kind,
} from "./changes-data";
import { RestoreButton } from "./restore-button";

/**
 * CHANGE HISTORY — every change to how MahekOne is set up, the value before
 * beside the value after, drawn to the canvas.
 *
 * Read off the audit rows each writer already keeps: a setting, a key, the
 * expense policy, the catalogue, the WhatsApp switch. Restore writes a
 * setting's earlier value back through the same writer, so a restore is itself
 * a change in this list — and it is offered only on a setting's newest change,
 * because restoring an older one would undo every change since, silently.
 */

const RANGES = [7, 30, 90, 365] as const;

export default async function ChangesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    kind?: string;
    days?: string;
    key?: string;
  }>;
}) {
  await requirePlatformAdmin();
  const ctx = await adminContext();
  const sp = await searchParams;
  const days = RANGES.find((d) => String(d) === sp.days) ?? 30;
  const kind = (KINDS.find((k) => k.slug === sp.kind)?.slug ??
    null) as Kind | null;
  const needle = sp.q?.trim() ? `%${sp.q.trim().toLowerCase()}%` : null;

  const [counts, list] = await Promise.all([
    changeCounts(days, needle),
    changeRows(days, needle, kind),
  ]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const firstSetting = list.find((c) => c.kind === "settings")?.key ?? null;
  const picked = sp.key && definition(sp.key) ? sp.key : firstSetting;

  const href = (
    over: Partial<Record<"q" | "kind" | "days" | "key", string | null>>,
  ) => {
    const p = new URLSearchParams();
    const v = {
      q: sp.q ?? null,
      kind,
      days: days === 30 ? null : String(days),
      key: sp.key ?? null,
      ...over,
    };
    for (const [k, x] of Object.entries(v)) if (x) p.set(k, x);
    const s = p.toString();
    return s ? `${ADMIN.changes}?${s}` : ADMIN.changes;
  };
  const nextRange =
    RANGES[
      (RANGES.indexOf(days as (typeof RANGES)[number]) + 1) % RANGES.length
    ];

  const groups = byDay(list, nowMs());
  const lit =
    list.find((c) => c.kind === "settings" && c.key === picked)?.id ?? null;
  const csv = list.map((c) => [
    stampIso(c.at),
    KINDS.find((k) => k.slug === c.kind)?.label ?? c.kind,
    c.title,
    c.sub ?? "",
    c.from ?? "",
    c.to ?? "",
    c.actor ?? "",
  ]);

  return (
    <AdminPage
      title="Change history"
      subtitle="Every setup change, old value beside new. Restore writes the earlier value back and is itself recorded."
      actions={
        <>
          <form>
            {kind ? <input type="hidden" name="kind" value={kind} /> : null}
            {days !== 30 ? (
              <input type="hidden" name="days" value={days} />
            ) : null}
            <input
              name="q"
              defaultValue={sp.q ?? ""}
              placeholder="Setting or person"
              aria-label="Find a change"
              className="h-9 w-[260px] rounded-control border border-line-strong bg-surface px-3 text-[13px] text-ink"
            />
          </form>
          <BtnLink
            href={href({ days: nextRange === 30 ? null : String(nextRange) })}
          >
            {days === 365 ? "Last year" : `Last ${days} days`}
          </BtnLink>
          <CsvButton
            name="change-history"
            headers={["When", "Kind", "What", "Key", "Before", "After", "By"]}
            rows={csv}
            filters={[sp.q ?? null, kind]}
          />
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
        <Chip href={href({ kind: null })} on={!kind}>
          Everything · {total}
        </Chip>
        {KINDS.map((k) => (
          <Chip key={k.slug} href={href({ kind: k.slug })} on={kind === k.slug}>
            {k.label} · {counts[k.slug]}
          </Chip>
        ))}
      </div>

      <div
        className="grid items-start gap-[18px]"
        style={{ gridTemplateColumns: "minmax(0,1fr) 360px" }}
      >
        <Card>
          {list.length === 0 ? (
            <div className="px-[18px] py-10 text-center text-muted">
              Nothing changed in that range.
            </div>
          ) : (
            groups.map(([day, rows]) => (
              <div key={day}>
                <div
                  className="border-b border-divider px-[18px] pt-4 pb-2 text-xs font-semibold tracking-[0.05em] text-muted"
                  style={{ textTransform: "uppercase" }}
                >
                  {day}
                </div>
                {rows.map((c) => (
                  <Row
                    key={c.id}
                    c={c}
                    on={c.id === lit}
                    href={c.key ? href({ key: c.key }) : null}
                    canRestore={ctx.canWriteConfig}
                  />
                ))}
              </div>
            ))
          )}
        </Card>
        {picked ? <SettingPanel settingKey={picked} /> : <div />}
      </div>
    </AdminPage>
  );
}

function Chip({
  href,
  on,
  children,
}: {
  href: string;
  on: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex h-[34px] items-center rounded-full border px-3 text-[13px] font-semibold whitespace-nowrap no-underline hover:no-underline",
        on
          ? "border-ink bg-ink text-white"
          : "border-line bg-surface text-ink hover:border-line-strong",
      )}
    >
      {children}
    </Link>
  );
}

function Row({
  c,
  on,
  href,
  canRestore,
}: {
  c: ChangeRow;
  on: boolean;
  href: string | null;
  canRestore: boolean;
}) {
  const title = href ? (
    <Link
      href={href}
      className="font-semibold text-ink no-underline hover:underline"
    >
      {c.title}
    </Link>
  ) : (
    <span className="font-semibold text-ink">{c.title}</span>
  );
  const diff =
    c.from != null || c.to != null ? (
      <span className="inline-flex items-center gap-2">
        <span className="rounded-[5px] bg-danger-soft px-2 py-0.5 font-semibold text-danger line-through">
          {c.from ?? "—"}
        </span>
        <span aria-hidden className="text-body">
          →
        </span>
        <span className="rounded-[5px] bg-success-soft px-2 py-0.5 font-semibold text-success">
          {c.to ?? "—"}
        </span>
      </span>
    ) : null;
  const stacked = on && c.sub;
  return (
    <div
      className={cx(
        "flex items-center gap-4 border-b border-divider py-3.5 pr-[18px] pl-[18px] last:border-b-0",
        on && "border-l-[3px] border-l-brand bg-[#f7f5ff] pl-[15px]",
      )}
    >
      <span className="w-[60px] flex-none text-muted tabular-nums">
        {clock(c.at)}
      </span>
      <Avatar
        name={c.actor ?? "?"}
        size={32}
        tone={c.actor ? "navy" : "brand"}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {title}
          <Pill tone={c.kind === "settings" ? "brand" : "muted"}>{c.area}</Pill>
          {!stacked ? diff : null}
        </div>
        {c.sub && (stacked || c.kind === "keys") ? (
          <Mono className="mt-0.5 block text-muted">{c.sub}</Mono>
        ) : null}
        {stacked && diff ? <div className="mt-1.5">{diff}</div> : null}
      </div>
      <span className="flex-none">
        {c.restore && canRestore ? (
          <RestoreButton
            settingKey={c.restore.key}
            value={c.restore.value}
            label={c.restore.label}
          />
        ) : c.kind === "settings" ? (
          <span className="text-faint">—</span>
        ) : null}
      </span>
    </div>
  );
}

async function SettingPanel({ settingKey }: { settingKey: string }) {
  const def = definition(settingKey)!;
  const [config, history] = await Promise.all([
    getConfig(),
    settingHistory(settingKey),
  ]);
  const now = valueLine(
    (config as unknown as Record<string, unknown>)[settingKey],
  );
  const where = settingAddress(settingKey);
  return (
    <Card>
      <CardHead title={def.label} />
      <div className="flex flex-col gap-3 border-b border-divider px-[18px] py-4">
        <div className="flex items-center">
          <span className="flex-1 text-muted">Now</span>
          <b className="text-xl font-bold text-ink">{now}</b>
        </div>
        <div className="flex items-center">
          <span className="flex-1 text-muted">Default</span>
          <b className="font-semibold text-ink">{valueLine(def.default)}</b>
        </div>
        <div className="flex items-center">
          <span className="flex-1 text-muted">Changes</span>
          <b className="font-semibold text-ink">{history.length}</b>
        </div>
      </div>
      {history.map((h, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-divider px-[18px] py-3.5"
        >
          <span className="w-[72px] flex-none text-body">{dayShort(h.at)}</span>
          <div className="min-w-0">
            <span className="inline-flex items-center gap-2">
              <span className="rounded-[5px] bg-danger-soft px-2 py-0.5 font-semibold text-danger line-through">
                {h.from ?? "—"}
              </span>
              <span aria-hidden>→</span>
              <span className="rounded-[5px] bg-success-soft px-2 py-0.5 font-semibold text-success">
                {h.to}
              </span>
            </span>
            <div className="mt-1 text-muted">
              {h.from == null ? "First set" : (h.actor ?? "—")}
            </div>
          </div>
        </div>
      ))}
      <div className="px-[18px] py-3.5">
        <Link
          href={
            where
              ? `${ADMIN.settingsFor(where.page, where.tab)}#${settingKey}`
              : ADMIN.settings
          }
          className="flex h-9 w-full items-center justify-center rounded-control border border-line-strong bg-surface text-[13px] font-semibold text-ink no-underline hover:bg-[#f7f9fc] hover:no-underline"
        >
          Open in Settings
        </Link>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- dates */

const fmt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: APP_TIMEZONE, ...opts });
const CLOCK = fmt({ hour: "2-digit", minute: "2-digit", hour12: false });
const DAY = fmt({ day: "numeric", month: "short" });
const KEY = fmt({ year: "numeric", month: "2-digit", day: "2-digit" });
const clock = (d: Date) => CLOCK.format(d);
const dayShort = (d: Date) => DAY.format(d);
const stampIso = (d: Date) => `${KEY.format(d)} ${CLOCK.format(d)}`;

function byDay(list: ChangeRow[], now: number): Array<[string, ChangeRow[]]> {
  const today = KEY.format(new Date(now));
  const yesterday = KEY.format(new Date(now - 86_400_000));
  const out = new Map<string, ChangeRow[]>();
  for (const c of list) {
    const k = KEY.format(c.at);
    const label =
      k === today ? "Today" : k === yesterday ? "Yesterday" : DAY.format(c.at);
    (out.get(label) ?? out.set(label, []).get(label)!).push(c);
  }
  return [...out.entries()];
}
