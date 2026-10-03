import { notFound } from "next/navigation";
import { ADMIN_TABS, tabIndexOf } from "@/lib/admin-routes";
import { listPeople } from "@/lib/services/admin-people-service";
import { liveSessions } from "@/lib/services/admin-platform-service";
import { auditFeed } from "@/lib/services/audit-feed-service";
import { today } from "@/lib/queries";
import { requirePlatformAdmin } from "../../../_shell/context";
import { PersonDetail } from "../../person-detail";

export default async function PersonPage({ params }: { params: Promise<{ id: string; tab?: string[] }> }) {
  await requirePlatformAdmin();
  const { id, tab } = await params;
  const [people, sessions, audit, day] = await Promise.all([
    listPeople(),
    liveSessions(id),
    auditFeed({ about: id, size: 50 }),
    today(),
  ]);
  const person = people.find((p) => p.id === id);
  if (!person) notFound();
  return (
    <PersonDetail
      person={person}
      tab={ADMIN_TABS.person[tabIndexOf(ADMIN_TABS.person, tab?.[0])].slug}
      sessions={sessions}
      audit={audit}
      today={day}
    />
  );
}
