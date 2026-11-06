import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { pushToUsers } from "./mbos/push";
import { reachesHandset } from "./notification-apps";

/**
 * Telling somebody something, once, through every channel they have.
 *
 * THE ROW AND THE PUSH ARE ONE ACT, and keeping them apart is how this got
 * into the state it was found in. Sixteen places wrote a `notifications` row.
 * TWO of them also pushed, each with its own copy of the device lookup. The
 * other fourteen — an order declined, a target published, a book reassigned,
 * a leave request decided, a feedback reply — wrote a row that a field
 * salesman would see only when he next happened to open the app, which for a
 * decision made at four in the afternoon means the following morning.
 *
 * Nobody had decided that. It is just what happens when the courtesy is
 * bolted on at the call site rather than built into the act, because the
 * fifteenth caller copies whichever neighbour they read first.
 *
 * THE ROW IS THE RECORD AND THE PUSH IS THE COURTESY. The insert is awaited
 * and its failure is the caller's problem; the push is best-effort and
 * swallows its own. A phone that is off must never be able to fail a
 * decision, and the bell in the app is what the person sees either way.
 *
 * IT IS SAFE TO CALL FOR ANYBODY. Somebody with no handset — every telecaller,
 * every manager who works in a browser — costs one query that finds no
 * devices and sends nothing. There is no list of who is "a push user" to keep
 * in step with reality, because a list like that is wrong the day somebody is
 * given a phone.
 */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * WHERE IT GOES IS NOT OPTIONAL. A notification with no link used to count as
 * general, so a holiday meant for salesmen and a manager's "leave requested" were
 * drawn in every app's bell. Naming the destination is what keeps each app's bell
 * to its own work, so the compiler refuses an entry that names none.
 */
type NotifyDestination =
  /** Where the BELL goes, in MahekOne: a web route, and that app's bell. */
  | { href: string; mbosHref?: string | null; general?: never }
  /**
   * Where a TAP goes, on the handset: an MBOS route, and a different set of
   * screens entirely. `/notifications` when no screen is more precise. A row with
   * only this goes to the phone and appears in no bell on the web.
   */
  | { href?: null; mbosHref: string; general?: never }
  /** About the person or the whole company, not one app's work: shown everywhere. */
  | { general: true; href?: string | null; mbosHref?: string | null };

export type NotifyMessage = {
  title: string;
  body: string;
  /** `info` unless the caller says otherwise, matching the column's default. */
  kind?: string;
} & NotifyDestination;

export type NotifyEntry = { userId: string } & NotifyMessage;

/** Writes the bell rows and pushes them; answers the ids written, in the order given. */
export async function notifyUsers(entries: readonly NotifyEntry[]): Promise<string[]> {
  if (!entries.length) return [];

  const rows = entries.map((e) => ({
    id: id("ntf"),
    userId: e.userId,
    title: e.title,
    body: e.body,
    kind: e.kind ?? "info",
    href: e.href ?? null,
    /* Stored, not only pushed: the handset's bell list reads this row on the
       next pull, and without it the phone was handed the WEB route. */
    mbosHref: e.mbosHref ?? null,
  }));

  await db.insert(notifications).values(rows);

  /* Deliberately not awaited for its result, and deliberately awaited for its
     completion: the caller is usually inside a server action that is about to
     return, and a floating promise there can be cut off mid-request. It
     cannot throw — `pushToUsers` swallows everything — so awaiting costs the
     request the round trip and never its success. */
  await pushToUsers(
    rows.filter((r) => reachesHandset(r.href, r.mbosHref)).map((r) => ({
      userId: r.userId,
      title: r.title,
      body: r.body,
      href: r.mbosHref,
      notificationId: r.id,
      kind: r.kind,
    })),
  );
  return rows.map((r) => r.id);
}

/** One person, which is most callers. */
export async function notifyUser(entry: NotifyEntry): Promise<void> {
  await notifyUsers([entry]);
}
