import "server-only";

/**
 * A push notification, sent through Expo's own service.
 *
 * Not APNs or FCM directly — Expo's push service sits in front of both, and
 * a token from `getExpoPushTokenAsync()` on the handset already carries
 * enough for Expo to route it to the right platform. That is what makes this
 * one HTTP call rather than two credentialed integrations: nothing here
 * needs an Apple key or a Firebase project to exist.
 *
 * Best-effort, deliberately. A push failing must never fail the write it
 * rides on — the in-app notification row is the record; the push is a
 * courtesy on top of it, same shape as the visit-voice transcript.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** A push token that is not shaped like one is not sent — Expo's own tokens
 *  are `ExponentPushToken[...]`, and anything else would just be refused. */
function looksLikeExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[.+\]$/.test(token);
}

export async function sendExpoPush(
  tokens: readonly (string | null | undefined)[],
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const valid = [...new Set(tokens.filter((t): t is string => !!t && looksLikeExpoPushToken(t)))];
  if (!valid.length) return;

  try {
    await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(
        valid.map((to) => ({ to, title, body, data, sound: "default", priority: "high" })),
      ),
    });
  } catch {
    /* No signal, Expo's service down, whatever — the in-app notification
       already landed and is what the handset reads on its next sync. */
  }
}
