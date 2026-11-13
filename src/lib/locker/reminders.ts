import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { lockerRemindersSent } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { today as todayIst } from "@/lib/format";
import { holdersOf } from "./vault-core";
import { lockerAuditTx } from "./audit";
import { actionDate, daysLabel, escalationLevel, rungLine, rungsSentOn } from "./engine";
import { notifyUsers, type NotifyEntry } from "@/lib/notify";
import { allAssets, lockerSettingsRow, reminderLadders, type AssetRow } from "./service";
import { cardRisks } from "./register-service";

/* ---------------------------------------------------------------------------
 * THE NIGHTLY REMINDER PASS — spec §7.1, §7.3, §12.
 *
 * For every live asset: the rungs of its criticality's ladder that fall on
 * today, measured against the ACTION day (the notice deadline for a contract,
 * the end date otherwise) and moved to the working day before when they land
 * on a day off. Each rung goes to a widening circle as it gets later —
 * owner, then the backup, then the approver and the department head, then
 * whoever holds the Locker's Approvals (management) — and is recorded in
 * `locker_reminders_sent` so a second run the same night sends nothing.
 *
 * DIGEST, NOT FIREHOSE: everything one person is owed tonight arrives as ONE
 * notification listing it, never one bell row per asset. The card-expiry trap
 * (§5.7) rides in the same digest: a card expiring inside the warning window
 * names every auto-renewal it pays, to the owners of those subscriptions.
 * ------------------------------------------------------------------------- */

type Line = { assetId: string; title: string; text: string; crit: number };

export async function runLockerReminders(day: string = todayIst()): Promise<{ rungs: number; cardAlerts: number; people: number; sent: number }> {
  const [assets, ladders, config, settings] = await Promise.all([allAssets(day), reminderLadders(), getConfig(), lockerSettingsRow()]);
  const workingDays = (config["workingDay.workingDays"] as number[] | undefined) ?? [1, 2, 3, 4, 5, 6];
  const management = (await holdersOf("locker.approvals")).map((h) => h.id);
  const byPerson = new Map<string, Line[]>();
  const add = (uid: string | null | undefined, l: Line) => {
    if (!uid) return;
    const list = byPerson.get(uid) ?? [];
    if (!list.some((x) => x.assetId === l.assetId && x.text === l.text)) list.push(l);
    byPerson.set(uid, list);
  };

  let rungs = 0;
  const due: { a: AssetRow; offset: number; to: string[] }[] = [];
  for (const a of assets) {
    if (!a.live || a.stage === "lost") continue;
    const when = actionDate(a, a.model);
    const offsets = ladders[a.criticality] ?? [];
    for (const offset of rungsSentOn(offsets, when, day, workingDays)) {
      /* A renewal already applied for or awaiting its document is not chased past its end. */
      if (offset > 0 && (a.stage === "renewal_filed" || a.stage === "awaiting_document")) continue;
      const level = escalationLevel(-offset);
      const to = new Set<string>();
      if (a.ownerId) to.add(a.ownerId);
      if (level >= 1 && a.backupId) to.add(a.backupId);
      if (level >= 2) {
        if (a.approverId) to.add(a.approverId);
        if (a.executorId) to.add(a.executorId);
      }
      /* Nobody owns it, or it is badly late: management hears. A business-critical
         asset inside 30 days with no renewal under way goes to them daily (§7.1). */
      if (!a.ownerId || level >= 3) management.forEach((m) => to.add(m));
      due.push({ a, offset, to: [...to] });
    }
    if (a.criticality === 4 && a.actionIn != null && a.actionIn >= 0 && a.actionIn <= 30 && !a.stage) {
      for (const m of management) add(m, { assetId: a.id, title: a.title, crit: 4, text: `${daysLabel(a.actionIn)} left and no renewal under way` });
    }
  }

  /* Dedupe against what was already sent for this end date and rung. */
  const sentRows: (typeof lockerRemindersSent.$inferInsert)[] = [];
  for (const d of due) {
    const [already] = await db
      .select({ id: lockerRemindersSent.id })
      .from(lockerRemindersSent)
      .where(and(eq(lockerRemindersSent.assetId, d.a.id), eq(lockerRemindersSent.offset, d.offset), d.a.endDate ? eq(lockerRemindersSent.endDate, d.a.endDate) : eq(lockerRemindersSent.assetId, d.a.id)));
    if (already) continue;
    rungs++;
    const text = rungLine(d.offset, d.a.model) + (d.a.type.leadDays && d.offset < 0 && -d.offset >= d.a.type.leadDays ? " — start the renewal now" : "");
    d.to.forEach((u) => add(u, { assetId: d.a.id, title: d.a.title, crit: d.a.criticality, text }));
    sentRows.push({ id: `lks_${randomUUID().slice(0, 12)}`, assetId: d.a.id, endDate: d.a.endDate, offset: d.offset, sentTo: d.to });
  }

  /* The card-expiry trap. */
  const cards = await cardRisks(assets, day);
  let cardAlerts = 0;
  if (settings.cardWarnDays > 0) {
    for (const c of cards) {
      cardAlerts++;
      for (const s of c.subs) add(s.ownerId, { assetId: s.id, title: s.title, crit: s.criticality, text: `paid by ${c.pm.label} ····${c.pm.last4}, which expires in ${c.daysLeft} days — the charge will fail` });
    }
  }

  const entries: NotifyEntry[] = [...byPerson.entries()].map(([userId, lines]) => {
    lines.sort((x, y) => y.crit - x.crit);
    const head = lines.slice(0, 6).map((l) => `${l.title}: ${l.text}`);
    return {
      userId,
      title: `Locker · ${lines.length} ${lines.length === 1 ? "thing needs" : "things need"} you today`,
      body: head.join(" · ") + (lines.length > 6 ? ` · and ${lines.length - 6} more` : ""),
      kind: lines.some((l) => l.crit === 4) ? "warn" : "info",
      href: "/locker/renewals",
    };
  });

  await db.transaction(async (tx) => {
    if (sentRows.length) await tx.insert(lockerRemindersSent).values(sentRows).onConflictDoNothing();
    await lockerAuditTx(tx, {
      actorId: null,
      actorName: "Locker reminders",
      action: "locker.reminder.sent",
      entityType: "locker_reminders",
      entityId: day,
      summary: `Sent ${rungs} reminder rungs and ${cardAlerts} card alerts as ${entries.length} digests`,
      detail: { day, rungs, cardAlerts, people: entries.length },
    });
  });
  if (entries.length) await notifyUsers(entries);
  return { rungs, cardAlerts, people: entries.length, sent: entries.length };
}
