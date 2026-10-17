import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { hrmsNotifications, notifications } from "@/db/schema";
import { notifyUsers } from "@/lib/notify";

/* ---------------------------------------------------------------------------
 * AN ANNOUNCEMENT — a message somebody in the office sends to one person, a
 * few, or everybody — sent ONE way, from either screen that sends one.
 *
 * There were two senders and two read states. The Sales Dashboard's "Send a
 * notification" rang the bell and kept no record of what it said; HRMS's
 * Announcements kept a record and its own "seen" beside the bell's "read", so
 * a person could read a message in the bell and still show as unseen. Editing
 * a sent message changed HRMS's copy while the bell went on showing the old
 * words, and deleting one left it in everybody's bell.
 *
 * Now both senders write the same log (`hrms_notifications`), it remembers
 * the bell rows it wrote, and those rows are the only read state: seen is the
 * recipient's bell row read, an edit rewrites the bell rows' body, a delete
 * takes them out of the bell.
 * ------------------------------------------------------------------------- */

export type Announcement = {
  senderUserId: string;
  fromEmployeeId?: string | null;
  fromName: string;
  /** One employee it was addressed to, where it was. */
  toEmployeeId?: string | null;
  /** Who it is to, in words: a name, "All employees", "6 people in the field team". */
  toLabel: string;
  /** The bell's title; HRMS's announcements are titled with the sender. */
  title?: string | null;
  text: string;
  /** The HRMS list the bell opens, by key. */
  landing?: string | null;
  /** The web route the bell opens. */
  href?: string | null;
  recipients: string[];
  source: "hrms" | "sales";
};

export async function announce(a: Announcement): Promise<{ id: string; reached: number }> {
  const to = [...new Set(a.recipients)].filter((u) => u !== a.senderUserId);
  const title = a.title?.trim() || a.fromName;
  const bellIds = await notifyUsers(to.map((userId) => ({ userId, title, body: a.text, href: a.href ?? null })));
  const id = `hntf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(hrmsNotifications).values({
    id,
    fromEmployeeId: a.fromEmployeeId ?? null,
    fromName: a.fromName,
    toEmployeeId: a.toEmployeeId ?? null,
    toLabel: a.toLabel,
    title: a.title?.trim() || null,
    text: a.text,
    landing: a.landing ?? null,
    bellIds,
    recipientUserIds: to,
    source: a.source,
    createdById: a.senderUserId,
  });
  return { id, reached: to.length };
}

/** The bell rows an announcement wrote, with whether each has been read. */
export async function bellsOf(bellIds: string[]): Promise<{ id: string; userId: string; read: boolean }[]> {
  if (!bellIds.length) return [];
  return db.select({ id: notifications.id, userId: notifications.userId, read: notifications.read }).from(notifications).where(inArray(notifications.id, bellIds));
}

/** A changed message changes what people were sent. */
export async function rewordAnnouncement(bellIds: string[], text: string): Promise<void> {
  if (bellIds.length) await db.update(notifications).set({ body: text }).where(inArray(notifications.id, bellIds));
}

/** A deleted message leaves the bell too. */
export async function withdrawAnnouncement(bellIds: string[]): Promise<void> {
  if (bellIds.length) await db.delete(notifications).where(inArray(notifications.id, bellIds));
}

/** "Seen" is the recipient's own bell row marked read. */
export async function markAnnouncementSeen(bellIds: string[], userId: string): Promise<boolean> {
  if (!bellIds.length) return false;
  const r = await db.update(notifications).set({ read: true }).where(and(inArray(notifications.id, bellIds), eq(notifications.userId, userId))).returning({ id: notifications.id });
  return r.length > 0;
}
