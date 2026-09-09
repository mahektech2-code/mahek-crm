import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { mbosDevices, mbosPushReceipts } from "@/db/schema";
import { getConfig } from "../config/store";
import { APP_TIMEZONE } from "../business-date";
import { chunk, looksLikeExpoPushToken, RECEIPT_CHUNK, SEND_CHUNK, withinQuietHours } from "./push-rules";

export { chunk, looksLikeExpoPushToken, withinQuietHours, SEND_CHUNK } from "./push-rules";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * A push notification, and whether it arrived.
 *
 * Sent through Expo's own service rather than APNs or FCM directly: Expo sits
 * in front of both, and a token from `getExpoPushTokenAsync()` already carries
 * enough to route to the right platform. That is what makes this one HTTP call
 * rather than two credentialed integrations.
 *
 * BEST-EFFORT, ALWAYS. A push failing must never fail the write it rides on —
 * the `notifications` row is the record; this is a courtesy on top of it. Every
 * entry point here swallows its own failures for that reason.
 *
 * WHAT WAS MISSING, and it is most of the feature. Expo's API has two phases
 * and only the first was ever used. `send` answers with a TICKET per message,
 * and a ticket means "accepted", not "delivered" — the verdict comes later,
 * from `getReceipts`, which is the ONLY place `DeviceNotRegistered` is ever
 * reported. Without reading it, a token belonging to an app somebody
 * uninstalled stays on the device row for ever, every message to it is
 * discarded by Expo, and the office sees an unbroken run of successes. That is
 * why this file has a second half.
 */

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

export type PushReadiness = {
  ok: boolean;
  /** Said in words, for a screen. Empty when it is ready. */
  why: string;
  enabled: boolean;
  projectId: string;
  /** Active handsets holding a usable token. */
  reachable: number;
  /** Active handsets with no token — the ones push cannot reach. */
  unreachable: number;
};

/**
 * Whether push can actually do anything.
 *
 * Asked the way the microphone asks in MahekOne: a feature that fails when used
 * is worse than one that says plainly it is not set up.
 *
 * The COUNTS are the half a switch cannot tell you. "Push is on" with nine
 * handsets holding zero tokens between them is the state this subsystem was
 * found in, and no boolean anywhere would have said so.
 */
export async function pushReadiness(): Promise<PushReadiness> {
  const config = await getConfig();
  const enabled = config["mbos.push.enabled"];
  const projectId = (config["mbos.push.expoProjectId"] ?? "").trim();

  const rows = await db
    .select({ pushToken: mbosDevices.pushToken })
    .from(mbosDevices)
    .where(eq(mbosDevices.active, true));

  const reachable = rows.filter((r) => r.pushToken && looksLikeExpoPushToken(r.pushToken)).length;
  const unreachable = rows.length - reachable;

  const why = !enabled
    ? "Push is switched off in settings. Notifications are still written; they only wait for the app to be opened."
    : !projectId
      ? "No Expo project id is set, so no handset can be issued a push token. Set one in Settings — `eas init` produces it, and it is on the project's page at expo.dev."
      : reachable === 0
        ? rows.length === 0
          ? "No handset is registered, so there is nowhere to push to."
          : `${unreachable} ${unreachable === 1 ? "handset is" : "handsets are"} registered and none holds a push token. A handset asks for one on its next sign-in, and only after notification permission is granted.`
        : "";

  return { ok: enabled && !!projectId && reachable > 0, why, enabled, projectId, reachable, unreachable };
}

/* ----------------------------------------------------------------- sending */

export type PushTarget = {
  userId: string;
  title: string;
  body: string;
  /** Where tapping it should land — an MBOS route. See `lib/notify.ts`. */
  href?: string | null;
  /** The notification row it rides on, so a failure traces back to a message. */
  notificationId?: string | null;
};

type Message = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: "default" | null;
  priority: "high" | "normal";
  channelId: string;
};

type PendingRow = {
  deviceId: string;
  userId: string;
  notificationId: string | null;
  pushToken: string;
};

/**
 * Push to PEOPLE, not to tokens.
 *
 * Callers know who should hear about a thing. Which handsets that person is
 * signed in on, whether any can be reached, and what to do when one cannot are
 * this module's problem. Before this, two call sites did their own device
 * lookup and fourteen others pushed nothing at all.
 *
 * QUIET HOURS SILENCE IT, THEY DO NOT DELAY IT. A held push needs an outbox, a
 * scheduler, and a rule for one still waiting when the thing it describes has
 * been superseded. Sending it silently — no sound, ordinary priority — puts the
 * information on the phone immediately and still lets somebody sleep, which is
 * what the setting is for.
 */
export async function pushToUsers(targets: readonly PushTarget[]): Promise<void> {
  try {
    if (!targets.length) return;
    const config = await getConfig();
    if (!config["mbos.push.enabled"]) return;

    const userIds = [...new Set(targets.map((t) => t.userId))];
    const devices = await db
      .select({
        userId: mbosDevices.userId,
        deviceId: mbosDevices.deviceId,
        pushToken: mbosDevices.pushToken,
      })
      .from(mbosDevices)
      .where(and(inArray(mbosDevices.userId, userIds), eq(mbosDevices.active, true)));

    const byUser = new Map<string, { deviceId: string; pushToken: string }[]>();
    for (const d of devices) {
      if (!d.pushToken || !looksLikeExpoPushToken(d.pushToken)) continue;
      byUser.set(d.userId, [
        ...(byUser.get(d.userId) ?? []),
        { deviceId: d.deviceId, pushToken: d.pushToken },
      ]);
    }
    if (!byUser.size) return;

    const quiet = withinQuietHours(localHour(), config["mbos.push.quietHours"]);

    /* One message per (target, handset). Somebody signed in on two phones
       hears it on both, which is the honest reading of "tell this person";
       `mbos.devices.onePerPerson` is what makes that rare. */
    const messages: Message[] = [];
    const pending: PendingRow[] = [];

    for (const t of targets) {
      for (const d of byUser.get(t.userId) ?? []) {
        messages.push({
          to: d.pushToken,
          title: t.title,
          body: t.body,
          data: { href: t.href ?? null, notificationId: t.notificationId ?? null },
          sound: quiet ? null : "default",
          priority: quiet ? "normal" : "high",
          /* Android takes its importance from the CHANNEL and from nowhere
             else, so a message naming none lands in the default channel and
             makes no sound however high its priority claims to be. */
          channelId: quiet ? "quiet" : "default",
        });
        pending.push({
          deviceId: d.deviceId,
          userId: t.userId,
          notificationId: t.notificationId ?? null,
          pushToken: d.pushToken,
        });
      }
    }

    const written: {
      id: string;
      ticketId: string | null;
      deviceId: string;
      userId: string;
      notificationId: string | null;
      pushToken: string;
      status: string;
      errorCode: string | null;
      errorDetail: string | null;
    }[] = [];

    const batches = chunk(messages, SEND_CHUNK);
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const offset = b * SEND_CHUNK;
      let tickets: unknown[] = [];

      try {
        const response = await fetch(EXPO_SEND_URL, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(batch),
        });
        const json = (await response.json()) as { data?: unknown[] };
        tickets = Array.isArray(json?.data) ? json.data : [];
      } catch {
        /* No signal, Expo down, a body that would not parse. Every message in
           the batch is recorded as failed rather than forgotten: the point of
           the table is that a push nobody can account for does not exist. */
        tickets = [];
      }

      for (let i = 0; i < batch.length; i++) {
        const base = pending[offset + i];
        const ticket = tickets[i] as
          | { status?: string; id?: string; message?: string; details?: { error?: string } }
          | undefined;

        const ok = ticket?.status === "ok" && !!ticket.id;
        written.push({
          id: id("push"),
          ticketId: ok ? (ticket!.id as string) : null,
          deviceId: base.deviceId,
          userId: base.userId,
          notificationId: base.notificationId,
          pushToken: base.pushToken,
          status: ok ? "accepted" : "failed",
          errorCode: ok ? null : (ticket?.details?.error ?? "send_failed"),
          errorDetail: ok ? null : (ticket?.message ?? "Expo did not accept the message."),
        });
      }
    }

    if (written.length) await db.insert(mbosPushReceipts).values(written);

    /* A token Expo refused at send time is dead NOW, not in fifteen minutes.
       Clearing it here spares every message queued before the receipt poller
       next runs. */
    await invalidateTokens(
      written.filter((r) => r.errorCode === "DeviceNotRegistered").map((r) => r.pushToken),
    );
  } catch {
    /* A push must never be able to fail the write it rides on, and that
       includes this module's own bookkeeping. */
  }
}

/* ---------------------------------------------------------------- receipts */

export type ReceiptSummary = {
  checked: number;
  delivered: number;
  failed: number;
  tokensCleared: number;
};

/**
 * Read what Expo made of the messages it accepted.
 *
 * Runs on a schedule well inside Expo's 24-hour receipt window. Three
 * outcomes, and only one of them is interesting for long:
 *
 *   DELIVERED — the row is deleted. The notification row is the record, and a
 *   second copy of "this worked" is not worth keeping.
 *
 *   FAILED — kept with the reason, because it is the only evidence of why
 *   somebody never heard about a decision.
 *
 *   `DeviceNotRegistered` — kept AND the token cleared, which is the whole
 *   reason this half exists. It is the only signal Expo ever gives that an app
 *   was uninstalled or reinstalled, and it arrives nowhere else.
 */
export async function collectPushReceipts(): Promise<ReceiptSummary> {
  const summary: ReceiptSummary = { checked: 0, delivered: 0, failed: 0, tokensCleared: 0 };

  const pending = await db
    .select({
      id: mbosPushReceipts.id,
      ticketId: mbosPushReceipts.ticketId,
      pushToken: mbosPushReceipts.pushToken,
    })
    .from(mbosPushReceipts)
    .where(and(eq(mbosPushReceipts.status, "accepted"), isNull(mbosPushReceipts.checkedAt)))
    .limit(5_000);

  const withTickets = pending.filter(
    (p): p is { id: string; ticketId: string; pushToken: string } => !!p.ticketId,
  );
  if (!withTickets.length) return summary;

  const deadTokens: string[] = [];

  for (const batch of chunk(withTickets, RECEIPT_CHUNK)) {
    let receipts: Record<string, { status?: string; message?: string; details?: { error?: string } }> = {};
    try {
      const response = await fetch(EXPO_RECEIPTS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ids: batch.map((b) => b.ticketId) }),
      });
      const json = (await response.json()) as { data?: typeof receipts };
      receipts = json?.data ?? {};
    } catch {
      /* Leave them pending. A receipt that could not be FETCHED is not a
         failed delivery, and recording one would invent an error. */
      continue;
    }

    for (const row of batch) {
      const receipt = receipts[row.ticketId];
      /* Expo omits a ticket it has not finished with. Leaving those untouched
         is what makes this safe to run every few minutes. */
      if (!receipt) continue;

      summary.checked++;

      if (receipt.status === "ok") {
        summary.delivered++;
        await db.delete(mbosPushReceipts).where(eq(mbosPushReceipts.id, row.id));
        continue;
      }

      summary.failed++;
      const errorCode = receipt.details?.error ?? "unknown";
      await db
        .update(mbosPushReceipts)
        .set({
          status: "failed",
          errorCode,
          errorDetail: receipt.message ?? null,
          checkedAt: new Date(),
        })
        .where(eq(mbosPushReceipts.id, row.id));

      if (errorCode === "DeviceNotRegistered") deadTokens.push(row.pushToken);
    }
  }

  summary.tokensCleared = await invalidateTokens(deadTokens);
  return summary;
}

/**
 * A token that will never work again, taken off the device row.
 *
 * Matched on the TOKEN, not the device id: a handset that has reinstalled may
 * already have registered a new token against the same device row, and
 * clearing by device would throw away the good one to punish the bad one.
 */
async function invalidateTokens(tokens: readonly string[]): Promise<number> {
  const dead = [...new Set(tokens.filter(Boolean))];
  if (!dead.length) return 0;

  const cleared = await db
    .update(mbosDevices)
    .set({ pushToken: null })
    .where(inArray(mbosDevices.pushToken, dead))
    .returning({ deviceId: mbosDevices.deviceId });

  return cleared.length;
}

/**
 * Old failures, swept.
 *
 * Successes are already gone, deleted the moment their receipt confirmed them.
 * This is only the record of what did NOT arrive, kept long enough to be read
 * and no longer.
 */
export async function prunePushFailures(): Promise<number> {
  const days = (await getConfig())["mbos.push.failureRetentionDays"];
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const gone = await db
    .delete(mbosPushReceipts)
    .where(and(eq(mbosPushReceipts.status, "failed"), lt(mbosPushReceipts.sentAt, cutoff)))
    .returning({ id: mbosPushReceipts.id });
  return gone.length;
}

/**
 * Recent failures, newest first, for the console.
 *
 * The question this answers is "why did nobody get the message", and the
 * answer is almost always one of three: no token at all, a token Expo has
 * retired, or a project id that does not match the one the handset asked with.
 */
export async function recentPushFailures(limit = 50) {
  return db
    .select({
      id: mbosPushReceipts.id,
      userId: mbosPushReceipts.userId,
      deviceId: mbosPushReceipts.deviceId,
      errorCode: mbosPushReceipts.errorCode,
      errorDetail: mbosPushReceipts.errorDetail,
      sentAt: mbosPushReceipts.sentAt,
    })
    .from(mbosPushReceipts)
    .where(eq(mbosPushReceipts.status, "failed"))
    .orderBy(desc(mbosPushReceipts.sentAt))
    .limit(limit);
}

/**
 * The hour of the day in the zone the business runs in.
 *
 * `getHours()` answers in the zone of whichever machine is asking, and the
 * server is not in Asia/Kolkata — the same bug AGENTS.md keeps a grep test
 * for. It would put quiet hours five and a half hours out, which is precisely
 * the window that matters.
 */
function localHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: APP_TIMEZONE,
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
}
