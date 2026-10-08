import { notFound } from "next/navigation";
import { ADMIN_TABS, tabIndexOf } from "@/lib/admin-routes";
import { listPeople } from "@/lib/services/admin-people-service";
import { liveSessions } from "@/lib/services/admin-platform-service";
import { auditFeed } from "@/lib/services/audit-feed-service";
import { listAccess } from "@/lib/services/access-service";
import { today } from "@/lib/queries";
import { requirePlatformAdmin } from "../../../_shell/context";
import { PersonDetail } from "../../person-detail";

export default async function PersonPage({ params }: { params: Promise<{ id: string; tab?: string[] }> }) {
  await requirePlatformAdmin();
  const { id, tab } = await params;
  /* The grants come from the Access screen's own reading, so the level and
     how far into each app it reaches read the same on both pages. */
  const [people, sessions, audit, day, access] = await Promise.all([
    listPeople(),
    liveSessions(id),
    auditFeed({ about: id, size: 50 }),
    today(),
    listAccess(),
  ]);
  const person = people.find((p) => p.id === id);
  if (!person) notFound();
  return (
    <PersonDetail
      person={person}
      grants={access.find((r) => r.userId === id)?.grants ?? []}
      tab={ADMIN_TABS.person[tabIndexOf(ADMIN_TABS.person, tab?.[0])].slug}
      sessions={sessions}
      audit={audit}
      today={day}
    />
  );
}
