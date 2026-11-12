import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { canOpenModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { longDate, shortDate } from "@/lib/format";
import { istDateKey } from "@/lib/studio/date";
import { CATEGORY_LABELS, isVerified } from "@/lib/studio/domain/festival-calendar";
import { nextOccurrence } from "@/lib/studio/domain/recurring-date";
import { festivalCalendar, peopleDates, upcomingFestivals } from "@/lib/studio/service";
import { PeopleDatesList, PersonDateForm, type PersonDateView } from "../_ui/people-dates";
import { Tabs } from "../_ui/parts";

export const metadata: Metadata = { title: "Dates" };
export const dynamic = "force-dynamic";

export default async function DatesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const sp = await searchParams;
  const view = sp.view === "people" ? "people" : "festivals";
  const user = await requireUser();
  const todayKey = istDateKey(new Date());
  const [festivals, people, canBulk] = await Promise.all([upcomingFestivals(todayKey, "all"), peopleDates(), canOpenModule(user.id, "studio.bulk")]);
  const coverage = festivalCalendar().coverage;
  const items: PersonDateView[] = people
    .map((p) => {
      const o = nextOccurrence(p.date, todayKey);
      return { id: p.id, version: p.version, kind: p.kind, personName: p.personName, company: p.company, date: p.date, note: p.note, leadDays: p.leadDays, next: o ? shortDate(o.date) : null, daysUntil: o?.daysUntil ?? null, years: o?.years ?? null, updatedBy: p.updatedBy.label };
    })
    .sort((a, b) => (a.daysUntil ?? 9999) - (b.daysUntil ?? 9999) || a.personName.localeCompare(b.personName));
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <PageHeader title="Dates" subtitle="Festivals worth a poster, and the birthdays and anniversaries everybody in the Studio shares." />
      <Tabs
        items={[
          { href: "/studio/dates", label: "Festivals", count: festivals.length, active: view === "festivals" },
          { href: "/studio/dates?view=people", label: "Birthdays & anniversaries", count: items.length, active: view === "people" },
        ]}
      />
      {view === "festivals" ? (
        <Card>
          <CardHeader title="Coming festivals" hint={`Dates are listed for ${longDate(coverage.from)} to ${longDate(coverage.to)} only, because festival dates move every year; nothing outside that is guessed.`} />
          <ul className="divide-y divide-divider">
            {festivals.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-5 py-2.5">
                <div className="w-[110px] flex-none text-sm">
                  <div className="font-semibold text-ink">{f.daysUntil === 0 ? "Today" : f.daysUntil === 1 ? "Tomorrow" : `In ${f.daysUntil} days`}</div>
                  <div className="text-[12px] text-muted">{shortDate(f.date)}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-ink">
                    {f.label}
                    {isVerified(f) ? null : <Badge tone="warn" title="This date is not from an official list. Check it before relying on it.">Unverified date</Badge>}
                  </div>
                  <div className="text-[12.5px] text-muted">
                    {CATEGORY_LABELS[f.category]}
                    {f.list ? ` · ${f.list === "gazetted" ? "gazetted holiday" : "restricted holiday"}` : ""}
                    {f.designs.any ? ` · ${f.designs.lead + f.designs.customer} design${f.designs.lead + f.designs.customer === 1 ? "" : "s"}` : " · no design for it yet"}
                  </div>
                </div>
                {f.designs.occasionId && canBulk ? (
                  <Link href={`/studio/bulk/new?occasion=${f.designs.occasionId}`} className="text-sm font-medium">
                    Make posters
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
          {!festivals.length ? <p className="px-5 py-4 text-sm text-muted">No festivals left in the calendar. It needs next year’s dates added.</p> : null}
        </Card>
      ) : (
        <>
          <Card className="mb-4 p-4">
            <div className="mb-3 text-sm font-semibold text-ink">Add a date</div>
            <PersonDateForm />
          </Card>
          <Card>
            <CardHeader title="Everybody's dates" hint="There is no birthday or anniversary design yet, so these remind rather than make a poster." />
            <PeopleDatesList items={items} />
          </Card>
        </>
      )}
    </div>
  );
}
