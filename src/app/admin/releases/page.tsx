import Link from "next/link";
import { Badge, Card, CardHeader, EmptyState, Td, Th } from "@/components/ui/primitives";
import { ADMIN } from "@/lib/admin-routes";
import { stamp } from "@/lib/format";
import { buildDistribution, compareVersions, type BuildCount } from "@/lib/services/admin-console-service";
import { getConfig } from "@/lib/config/store";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";

/**
 * APP RELEASES — which build every phone runs, for the two handset apps.
 *
 * Read off what each phone reports about itself on every request. A release
 * is built and signed by the "MBOS APK" and "Factory APK" workflows, never
 * from a laptop (DEPLOY.md); this screen is where you see it land.
 */
export default async function ReleasesPage() {
  await requirePlatformAdmin();
  const [{ field, factory }, config] = await Promise.all([buildDistribution(), getConfig()]);
  const floors = { field: config["releases.salesmanMinimumVersion"].trim(), factory: config["releases.factoryMinimumVersion"].trim() };
  const below = (l: BuildCount[], floor: string) =>
    floor ? l.filter((b) => b.version !== "Not reported" && compareVersions(b.version, floor) < 0).reduce((n, b) => n + b.phones, 0) : 0;
  const total = (l: BuildCount[]) => l.reduce((n, b) => n + b.phones, 0);
  const onLatest = (l: BuildCount[]) => l[0]?.phones ?? 0;

  return (
    <AdminPage
      title="App releases"
      subtitle="Which build every phone runs. Releases are built by the APK workflows."
      metrics={[
        { label: "Salesman App · latest", value: field[0]?.version ?? "—", sub: `${onLatest(field)} of ${total(field)} phones` },
        { label: "Factory app · latest", value: factory[0]?.version ?? "—", sub: `${onLatest(factory)} of ${total(factory)} phones` },
        {
          label: "Below the floor",
          value: String(below(field, floors.field) + below(factory, floors.factory)),
          tone: below(field, floors.field) + below(factory, floors.factory) ? "danger" : undefined,
        },
        {
          label: "Behind",
          value: String(total(field) - onLatest(field) + total(factory) - onLatest(factory)),
          tone: total(field) - onLatest(field) + total(factory) - onLatest(factory) ? "warn" : undefined,
        },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Fleet title="Salesman App" builds={field} href={ADMIN.handsets} floor={floors.field} />
        <Fleet title="Factory app" builds={factory} href={ADMIN.factoryHandsets} floor={floors.factory} />
      </div>
      <div className="mt-3 text-[13px] text-muted">
        <Link href={ADMIN.settingsFor("platform", "releases")}>Set the update floor</Link>
      </div>
    </AdminPage>
  );
}

const SHADES = ["bg-brand", "bg-brand-softer", "bg-warn", "bg-danger", "bg-line-strong"];

function Fleet({ title, builds, href, floor }: { title: string; builds: BuildCount[]; href: string; floor: string }) {
  const total = builds.reduce((n, b) => n + b.phones, 0);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={title}
        action={
          <span className="flex items-center gap-3">
            {floor ? <Badge tone="brand">Floor {floor}</Badge> : null}
            <Link href={href} className="text-sm font-semibold">
              Handsets
            </Link>
          </span>
        }
      />
      {total === 0 ? (
        <EmptyState title="No phone has reported" />
      ) : (
        <>
          <div className="px-5 pt-4">
            <div
              className="flex h-3.5 overflow-hidden rounded-full"
              role="img"
              aria-label={builds.map((b) => `${b.phones} on ${b.version}`).join(", ")}
            >
              {builds.map((b, i) => (
                <span key={b.version} className={SHADES[Math.min(i, SHADES.length - 1)]} style={{ width: `${(b.phones / total) * 100}%` }} />
              ))}
            </div>
          </div>
          <table className="mt-4">
            <thead>
              <tr>
                <Th>Build</Th>
                <Th align="right">Phones</Th>
                <Th>Last heard</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {builds.map((b, i) => (
                <tr key={b.version} className="border-b border-divider">
                  <Td>
                    <span className="inline-flex items-center gap-2 font-mono text-sm text-ink">
                      <span className={`h-2.5 w-2.5 rounded-sm ${SHADES[Math.min(i, SHADES.length - 1)]}`} />
                      {b.version}
                    </span>
                  </Td>
                  <Td align="right" className="font-semibold text-ink">
                    {b.phones}
                  </Td>
                  <Td className="text-muted">{stamp(b.lastSeen)}</Td>
                  <Td>
                    {floor && b.version !== "Not reported" && compareVersions(b.version, floor) < 0 ? (
                      <Badge tone="danger">Below the floor</Badge>
                    ) : i === 0 ? (
                      <Badge tone="success">Latest</Badge>
                    ) : (
                      <Badge tone="warn">Behind</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}
