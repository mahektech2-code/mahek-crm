/**
 * WHAT A PERSON IS ALLOWED TO READ WHEN A SAVE FAILS.
 *
 * Almost every action under `lib/actions` returns a sentence somebody wrote for
 * the person on the other end — "Say why this is worth pursuing", "A refusal
 * needs a reason". `fromThrown` is the one exception: an exception nobody
 * anticipated comes back as its own `message`, which for a database failure is
 * the whole query, its parameters and sometimes a stack line. That is a thing
 * to log and never a thing to print in a dialog in front of a manager, so it is
 * caught on the way to the screen and replaced with a sentence that says what
 * is true — the save did not happen — and what to do about it.
 *
 * It is PURE and client-safe: the provider that shows the message is a client
 * component, and the test that pins the patterns should not need a database.
 * A pattern that lets a raw error through is the failure; one that swallows an
 * authored sentence is merely less helpful, which is why the list is of what a
 * driver or the engine says and never of what an author would.
 */

export const GENERIC_FAILURE =
  "Something went wrong on the server and nothing was saved. Reload the page and try again — if it keeps happening, tell your administrator.";

/** What the postgres driver, Drizzle, Node and the framework say — never what a person wrote. */
const RAW_PATTERNS: RegExp[] = [
  /failed query/i,
  /\bparams\s*:/i,
  /\b(select|insert\s+into|update|delete\s+from)\b[\s\S]{0,400}\b(from|set|values|where)\b/i,
  /relation "[^"]+" does not exist/i,
  /column "[^"]+" (of relation "[^"]+" )?does not exist/i,
  /violates (foreign key|unique|not-null|check) constraint/i,
  /duplicate key value/i,
  /syntax error at or near/i,
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b/,
  /connection (terminated|timeout|refused)/i,
  /\bat\s+[\w$.<>]+\s+\((?:file:\/\/)?[^)]+:\d+:\d+\)/,
  /\bTypeError\b|\bReferenceError\b|\bSyntaxError\b/,
  /\[object Object\]/,
  /next_redirect|NEXT_REDIRECT/i,
];

export function safeMessage(message: string | null | undefined): string {
  const text = (message ?? "").trim();
  if (!text) return GENERIC_FAILURE;
  if (RAW_PATTERNS.some((re) => re.test(text))) return GENERIC_FAILURE;
  /* A sentence a person wrote is short. A long one is a dump. */
  if (text.length > 600) return GENERIC_FAILURE;
  return text;
}

/** A network failure, as the browser reports it — the request never reached the server. */
export const NETWORK_FAILURE =
  "Could not reach MahekOne. Check your connection and try again — nothing was saved.";
