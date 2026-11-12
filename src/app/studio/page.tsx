import type { Metadata } from "next";
import Link from "next/link";
import { canOpenModule, requireModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { Card, CardHeader, EmptyState, PageHeader, buttonClass } from "@/components/ui/primitives";
import { shortDate, stamp } from "@/lib/format";
import { istDateKey } from "@/lib/studio/date";
import { designsFor, dueFor, listPosters, upcomingFestivals } from "@/lib/studio/service";
import { RemindersList, type ReminderView } from "./_ui/reminders";
import { DesignGrid, DesignTile, plural } from "./_ui/parts";

export const metadata: Metadata = { title: "Home" };
export const dynamic = "force-dynamic";

export default async function StudioHome() {
  const user = await requireUser();
  await requireModule(user.id, "studio.home");
  const todayKey = istDateKey(new Date());
  const [due, festivals, posters, designs, canMake, canBulk, canSeePosters] = await Promise.all([
    dueFor(user.id, todayKey),
    upcomingFestivals(todayKey, "30"),
    listPosters({ whose: "mine" }),
    designsFor(),
    canOpenModule(user.id, "studio.make"),
    canOpenModule(user.id, "studio.bulk"),
    canOpenModule(user.id, "studio.posters"),
  ]);
  const occasionOf = new Map(festivals.map((f) => [`festival:${f.id}`, f.designs.occasionId]));
  const reminders: ReminderView[] = due.map((r) => {
    const occasion = occasionOf.get(r.key) ?? null;
    return { key: r.key, kind: r.kind, title: r.title, date: r.date, dateLabel: shortDate(r.date), daysUntil: r.daysUntil, unread: r.unread, hasDesign: r.hasDesign, href: occasion && canBulk ? `/studio/bulk/new?occasion=${occasion}` : null };
  });
  const next = festivals.find((f) => f.designs.any);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <PageHeader
        title="Studio"
        subtitle="Festival and promotional posters for your leads and customers, from approved designs."
        actions={
          <>
            {canBulk ? <Link href="/studio/bulk/new" className={buttonClass({ variant: "secondary" })}>Bulk posters</Link> : null}
            {canMake ? <Link href="/studio/make" className={buttonClass({ variant: "primary" })}>Make a poster</Link> : null}
          </>
        }
      />
      {next ? (
        <Card className="mb-4 flex items-center gap-4 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-muted">Next festival with a design</div>
            <div className="flex items-center gap-2 text-lg font-semibold text-ink">
              {next.label}
              <span className="text-sm font-normal text-muted">
                {next.daysUntil === 0 ? "today" : next.daysUntil === 1 ? "tomorrow" : `in ${next.daysUntil} days`} · {shortDate(next.date)}
              </span>
            </div>
            <div className="text-[13px] text-muted">{plural(next.designs.lead + next.designs.customer, "design")} ready for it.</div>
          </div>
          {canBulk && next.designs.occasionId ? (
            <Link href={`/studio/bulk/new?occasion=${next.designs.occasionId}`} className={buttonClass({ variant: "primary" })}>
              Make {next.label} posters
            </Link>
          ) : null}
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader title="Coming up" hint="Festivals and the birthdays and anniversaries everybody shares, inside their reminder window." action={<Link href="/studio/dates" className="text-sm">All dates</Link>} />
          <RemindersList items={reminders} />
        </Card>
        <Card>
          <CardHeader title="Your recent posters" action={canSeePosters ? <Link href="/studio/posters" className="text-sm">All</Link> : null} />
          {posters.rows.length ? (
            <ul className="divide-y divide-divider">
              {posters.rows.slice(0, 8).map((p) => (
                <li key={p.id} className="px-5 py-2.5">
                  <Link href={`/studio/posters/${p.id}`} className="block text-sm font-medium text-ink">
                    {p.company}
                  </Link>
                  <div className="text-[12.5px] text-muted">
                    {p.templateName} · {stamp(p.createdAt)}
                    {p.shareCount ? ` · shared ${plural(p.shareCount, "time")}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No posters yet" body="Pick a lead or a customer and a design — it takes under a minute." />
          )}
        </Card>
      </div>

      <h2 className="mt-6 mb-3 text-lg font-semibold text-ink">Designs</h2>
      <DesignGrid>
        {designs.map((d) => (
          <DesignTile key={d.id} design={d} />
        ))}
      </DesignGrid>
      {designs.length === 0 ? <p className="text-sm text-muted">No approved designs yet.</p> : null}
    </div>
  );
}
