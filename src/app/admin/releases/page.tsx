import Link from "next/link";
import { Badge, Card, CardHeader, EmptyState, Td, Th } from "@/components/ui/primitives";
import { ADMIN } from "@/lib/admin-routes";
import { stamp } from "@/lib/format";
import { buildDistribution, type BuildCount } from "@/lib/services/admin-console-service";
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
  const { field, factory } = await buildDistribution();
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
          label: "Behind",
          value: String(total(field) - onLatest(field) + total(factory) - onLatest(factory)),
          tone: total(field) - onLatest(field) + total(factory) - onLatest(factory) ? "warn" : undefined,
        },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Fleet title="Salesman App" builds={field} href={ADMIN.handsets} />
        <Fleet title="Factory app" builds={factory} href={ADMIN.factoryHandsets} />
      </div>
    </AdminPage>
  );
}

const SHADES = ["bg-brand", "bg-brand-softer", "bg-warn", "bg-danger", "bg-line-strong"];

function Fleet({ title, builds, href }: { title: string; builds: BuildCount[]; href: string }) {
  const total = builds.reduce((n, b) => n + b.phones, 0);
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} action={<Link href={href} className="text-sm font-semibold">Handsets</Link>} />
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
                  <Td>{i === 0 ? <Badge tone="success">Latest</Badge> : <Badge tone="warn">Behind</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}
