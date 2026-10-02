import "server-only";
import { EventEmitter } from "node:events";
import { sql } from "@/db";

/* ---------------------------------------------------------------------------
 * WHATSAPP, LIVE: something changed in a conversation, and every open screen
 * that may see it is told at once.
 *
 * Postgres LISTEN/NOTIFY rather than an in-memory emitter alone, because the
 * write and the screen are routinely in different places: the webhook that
 * stores a customer's message, the action that sends a reply and the stream
 * holding a telecaller's open chat are three requests, and the day this runs
 * as more than one process an in-memory bus would tell only the screens that
 * happened to share a process with the write. NOTIFY reaches every process,
 * and each process fans it out to its own open streams through ONE listening
 * connection — not one per screen, on a box with one vCPU.
 *
 * The payload says WHICH conversation and nothing else. Never the words: a
 * notification is visible to every listener before anybody's scope has been
 * asked, so the stream decides who may hear about it and the screen then
 * reads the thread through the same scoped read as everything else.
 * ------------------------------------------------------------------------- */

export const WA_CHANNEL = "wa_chat";

export type WaLiveEvent = {
  /** Null for a number that matches no customer. */
  customerId: string | null;
  /** The other party's number, last ten digits — how an unknown thread is keyed. */
  number: string | null;
};

/** The thread a conversation is filed under: the customer, or `n:<number>` for nobody's. */
export function threadKeyOf(e: WaLiveEvent): string | null {
  if (e.customerId) return e.customerId;
  return e.number ? `n:${e.number}` : null;
}

/**
 * Tell every open screen that a conversation moved. Never throws and never
 * fails the write it follows: a message stored and not announced still shows
 * on the next read, and a webhook must not answer Wati with an error over a
 * courtesy.
 */
export async function announceWa(e: WaLiveEvent): Promise<void> {
  try {
    await sql.notify(WA_CHANNEL, JSON.stringify(e));
  } catch {
    /* See above. */
  }
}

const g = globalThis as unknown as { __waBus?: EventEmitter; __waListening?: Promise<unknown> };

/**
 * This process's fan-out. The first stream to ask starts the one LISTEN; if
 * that connection dies it is started again by the next stream that opens,
 * which is at most a few minutes away because every stream cycles itself.
 */
export function waBus(): EventEmitter {
  if (!g.__waBus) {
    g.__waBus = new EventEmitter();
    // Every open WhatsApp screen is one listener; the default of ten is a
    // warning about a leak that is not one.
    g.__waBus.setMaxListeners(500);
  }
  const bus = g.__waBus;
  if (!g.__waListening) {
    g.__waListening = sql
      .listen(
        WA_CHANNEL,
        (payload) => {
          try {
            bus.emit("event", JSON.parse(payload) as WaLiveEvent);
          } catch {
            /* A payload we did not write. */
          }
        },
        () => bus.emit("ready"),
      )
      .catch(() => {
        g.__waListening = undefined;
      });
  }
  return bus;
}
