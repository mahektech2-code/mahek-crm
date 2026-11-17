import Link from "next/link";
import { stamp } from "@/lib/format";
import { parseBuildLabel } from "@/lib/handset-versions";
import { buildDistribution, compareVersions, type BuildCount } from "@/lib/services/admin-console-service";
import { getConfig } from "@/lib/config/store";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { Card, CardHead, Pill } from "../_shell/kit";
import { FloorInput } from "./floor-input";

/**
 * APP RELEASES — which build every phone runs, for the two handset apps, and
 * the floor below which a phone is asked to update.
 *
 * Read off what each phone reports about itself on every request. A release
 * is built and signed by the "MBOS APK" and "Factory APK" workflows, never
 * from a laptop (DEPLOY.md); this screen is where you see it land. MahekOne
 * keeps no record of the releases themselves, so "History" is every build a
 * phone is on, newest first.
 */

/** The canvas's stack colours, newest first. */
const SHADES = ["#6835fb", "#b9a6f9", "#d9930d", "#b3261e", "#9aa5ba"];

type Build = { version: string; phones: number; lastSeen: Date | null };

/** A field label is "1.16.2 (39) · ota" — group by the version a person recognises. */
function byVersion(list: BuildCount[], parse: boolean): Build[] {
  const m = new Map<string, Build>();
  for (const b of list) {
    const v = parse ? (parseBuildLabel(b.version === "Not reported" ? null : b.version)?.version ?? "Not reported") : b.version;
    const cur = m.get(v) ?? { version: v, phones: 0, lastSeen: null };
    cur.phones += b.phones;
    if (b.lastSeen && (!cur.lastSeen || b.lastSeen > cur.lastSeen)) cur.lastSeen = b.lastSeen;
    m.set(v, cur);
  }
  return [...m.values()].sort((a, b) => compareVersions(b.version, a.version));
}

export default async function ReleasesPage() {
  await requirePlatformAdmin();
  const [dist, config] = await Promise.all([buildDistribution(), getConfig()]);
  const field = byVersion(dist.field, true);
  const factory = byVersion(dist.factory, false);
  const floors = { field: config["releases.salesmanMinimumVersion"].trim(), factory: config["releases.factoryMinimumVersion"].trim() };

  const history = [
    ...field.map((b) => ({ app: "Salesman App", floor: floors.field, latest: field[0]?.version, ...b })),
    ...factory.map((b) => ({ app: "Factory app", floor: floors.factory, latest: factory[0]?.version, ...b })),
  ].sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0));

  return (
    <AdminPage title="App releases">
      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-2">
        <Fleet
          title="Salesman App"
          tag={<Pill tone="brand">MBOS</Pill>}
          builds={field}
          download="/download/mbos"
          floorKey="releases.salesmanMinimumVersion"
          floor={floors.field}
          id="floor-field"
        />
        <Fleet
          title="Factory app"
          tag={<Pill tone="muted">Floor</Pill>}
          builds={factory}
          download="/download/factory"
          floorKey="releases.factoryMinimumVersion"
          floor={floors.factory}
          id="floor-factory"
        />
      </div>

      <Card>
        <CardHead title="History" />
        {history.length === 0 ? (
          <div className="px-[18px] py-8 text-center text-muted">No phone has reported a build yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {["App", "Version", "Last heard", "Standing", "Phones on it"].map((h) => (
                    <th key={h} className="bg-ink px-[18px] py-2.5 text-left text-xs font-semibold whitespace-nowrap text-white normal-case">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const below = h.floor && h.version !== "Not reported" && compareVersions(h.version, h.floor) < 0;
                  return (
                    <tr key={h.app + h.version}>
                      <td className="h-[46px] border-b border-divider px-[18px] whitespace-nowrap">
                        <b className="font-semibold text-ink">{h.app}</b>
                      </td>
                      <td className="h-[46px] border-b border-divider px-[18px] font-mono whitespace-nowrap">{h.version}</td>
                      <td className="h-[46px] border-b border-divider px-[18px] whitespace-nowrap">{h.lastSeen ? stamp(h.lastSeen) : "—"}</td>
                      <td className="h-[46px] border-b border-divider px-[18px] whitespace-nowrap">
                        {below ? (
                          <Pill tone="danger">Below the floor</Pill>
                        ) : h.version === h.latest ? (
                          <Pill tone="ok">Latest</Pill>
                        ) : h.version === "Not reported" ? (
                          <Pill tone="muted">Not reported</Pill>
                        ) : (
                          <Pill tone="warn">Old</Pill>
                        )}
                      </td>
                      <td className="h-[46px] border-b border-divider px-[18px] whitespace-nowrap tabular-nums">{h.phones}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AdminPage>
  );
}

function Fleet({
  title,
  tag,
  builds,
  download,
  floorKey,
  floor,
  id,
}: {
  title: string;
  tag: React.ReactNode;
  builds: Build[];
  download: string;
  floorKey: string;
  floor: string;
  id: string;
}) {
  const total = builds.reduce((n, b) => n + b.phones, 0);
  const latest = builds.find((b) => b.version !== "Not reported");
  const below = floor
    ? builds.filter((b) => b.version !== "Not reported" && compareVersions(b.version, floor) < 0).reduce((n, b) => n + b.phones, 0)
    : 0;
  return (
    <Card>
      <div className="flex items-center gap-2.5 border-b border-divider px-[18px] py-3.5">
        <h2 className="m-0 text-base font-bold text-ink">{title}</h2>
        {tag}
        <span className="flex-1" />
        <Link
          href={download}
          aria-label={`Download the ${title} APK`}
          title="Download"
          className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-control border border-line bg-surface text-ink hover:bg-canvas"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
          </svg>
        </Link>
      </div>
      <div className="grid grid-cols-3 gap-4 p-[18px]">
        <Kv label="Latest" value={<span className="font-mono">{latest?.version ?? "—"}</span>} />
        <Kv label="Phones" value={total} />
        <Kv label="Below the floor" value={floor ? below : "—"} danger={below > 0} />
      </div>
      {total ? (
        <>
          <div className="mx-[18px] flex h-3.5 overflow-hidden rounded-[7px]" role="img" aria-label={builds.map((b) => `${b.phones} on ${b.version}`).join(", ")}>
            {builds.map((b, i) => (
              <i key={b.version} className="block h-full" style={{ width: `${(b.phones / total) * 100}%`, background: SHADES[Math.min(i, SHADES.length - 1)] }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-[18px] px-[18px] pt-2.5 pb-[18px] text-[13px]">
            {builds.map((b, i) => (
              <span key={b.version} className="inline-flex items-center gap-1.5">
                <i className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: SHADES[Math.min(i, SHADES.length - 1)] }} />
                {b.version} · {b.phones}
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className="px-[18px] pb-[18px] text-muted">No phone has reported a build yet.</div>
      )}
      <div className="flex items-center gap-3 border-t border-divider px-[18px] py-3.5">
        <label htmlFor={id} className="flex-1 font-medium text-ink">
          Ask to update below
        </label>
        <FloorInput id={id} settingKey={floorKey} value={floor} />
      </div>
    </Card>
  );
}

function Kv({ label, value, danger }: { label: string; value: React.ReactNode; danger?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-semibold text-muted">{label}</span>
      <b className={`text-lg ${danger ? "text-danger" : "text-ink"}`}>{value}</b>
    </div>
  );
}
