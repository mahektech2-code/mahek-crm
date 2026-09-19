/* ---------------------------------------------------------------------------
 * WHICH OLA MAPS KEY TO SPEND, AND WHEN A SPENT ONE COMES BACK.
 *
 * MahekOne may hold up to five Ola Maps accounts' keys. It does not spread
 * load across them: it spends the FIRST one until Ola says that account has
 * run out, then the second, and so on. Round-robin was the obvious shape and
 * is the wrong one for two reasons. It keeps every account but one at zero
 * usage, so an exhaustion is unambiguous and attributable to a single account
 * rather than arriving on all five within a day of each other — and constant
 * load spread across several accounts of one organisation is exactly the
 * pattern a provider acts on. Failover is insurance; it is not a way to buy
 * five hundred thousand requests a month.
 *
 * EXHAUSTION IS OBSERVED, NEVER COUNTED. Nothing here tries to keep a running
 * total of requests spent and infer that a key must be finished. A counter
 * that drifts high abandons a key with quota left on it; one that drifts low
 * goes on calling with a key that is already dead, and every screen that
 * depends on a map quietly stops working while the counter insists everything
 * is fine. The only authority on whether an account has run out is Ola's own
 * answer, which is what `classifyOlaAnswer` reads.
 *
 * AND A RETIRED KEY COMES BACK, because a quota is monthly. A pool that only
 * ever shrinks is a pool that is empty in five months, with nothing on any
 * screen saying why. Two things bring one back: a cooldown, which re-tries a
 * key on the chance the refusal was a burst rate limit rather than a month
 * genuinely spent, and the month itself — a refusal recorded in an earlier
 * month says nothing about this one, so it is simply ignored rather than
 * needing a job to fire on exactly the right night.
 *
 * Pure, like every engine here: it takes what is held, what is known about
 * each, the moment, and the configured cooldown, and performs no I/O. That
 * matters more than usual for this one. On the shipping configuration there
 * is ONE key, so none of this runs — the failover path will sit unexercised
 * until the day a key runs out, which is the worst possible moment to find a
 * bug in it. These tests are the whole warranty on that path.
 * ------------------------------------------------------------------------- */

/** What Ola's answer says about the key that was spent on it. */
export type OlaVerdict =
  /** Not a refusal of the key. The caller decides whether the body is useful. */
  | "ok"
  /** This account has run out. Retire the key and move to the next. */
  | "exhausted"
  /** Something went wrong that says nothing about the key. Change nothing. */
  | "failed";

export type OlaAnswer = {
  /** The HTTP status. 0 for a network error or a timeout — no answer at all. */
  httpStatus: number;
  /**
   * Ola's own `status` field where the body carried one. Some of its endpoints
   * answer 200 with a failure named in the body rather than in the status
   * line, so a reading that looked only at the status code could miss a
   * refusal sitting in plain sight.
   */
  bodyStatus?: string | null;
  /** The body as text, where there is one, for the wording of a 4xx refusal. */
  bodyText?: string | null;
};

/**
 * The wording a quota refusal uses, as opposed to any other kind.
 *
 * This is a list of words rather than an exact match on a documented error
 * code because Ola publishes no such code, and a refusal that is a sentence
 * rather than an identifier is a refusal whose exact spelling will change.
 * Every word here is one that appears in a quota or rate refusal and in
 * nothing else — "invalid", "unauthorized" and "forbidden" are deliberately
 * absent, because those are a key that is wrong rather than a key that is
 * finished, and retiring on them would take a perfectly good account out of
 * the pool on the strength of a typo somebody made in the Admin Console.
 */
const QUOTA_WORDS = /(quota|rate.?limit|ratelimit|limit exceeded|usage limit|exceeded|too many requests|throttl)/i;

/**
 * What an answer from Ola says about the key it was made with.
 *
 * ONLY A QUOTA OR RATE REFUSAL RETIRES A KEY, and the distinction is the whole
 * of this function. Snap-to-Road answers 400 to a batch of more than fifty
 * points — a fault in the request and nothing to do with the account — and
 * this codebase has already shipped that bug once. A timeout is a slow
 * network. A 500 is Ola's own bad afternoon. A 401 is a key somebody typed
 * wrong. None of those is an account that has run out, and treating any of
 * them as one would burn through five accounts in an afternoon of bad
 * weather and leave the map with nothing left to draw with.
 */
export function classifyOlaAnswer(answer: OlaAnswer): OlaVerdict {
  const { httpStatus } = answer;

  /* The one unambiguous answer. 429 means this account has been told to stop,
     whether for the month or for the minute, and the cooldown is what tells
     the two apart afterwards without this function having to guess now. */
  if (httpStatus === 429) return "exhausted";

  const words = `${answer.bodyStatus ?? ""} ${answer.bodyText ?? ""}`;

  if (httpStatus >= 200 && httpStatus < 300) {
    /* A 200 whose body reports the refusal. Read from the body's own status
       field rather than from its whole text: a successful snap of a road
       called "Exceeded Lane" is not a quota refusal, and matching prose in a
       payload that succeeded is how a good key gets retired. */
    return answer.bodyStatus && QUOTA_WORDS.test(answer.bodyStatus) ? "exhausted" : "ok";
  }

  /* A 403 is the shape a spent monthly quota most often arrives in, and it is
     also the shape of a key restricted to the wrong domain. The body is what
     separates them, so a 403 that does not SAY it is about a limit is left
     alone — the key stays in the pool and the call simply failed. */
  if (httpStatus === 403 && QUOTA_WORDS.test(words)) return "exhausted";

  return "failed";
}

/** What is known about one key: nothing, or the last time Ola refused it. */
export type KeySpend = {
  /** When the refusal came in. The cooldown runs from here. */
  spentAt: Date;
  /**
   * The month that refusal belongs to, as `YYYY-MM` in the working timezone.
   *
   * Stored rather than derived from `spentAt` here, because deriving it would
   * mean this engine naming a timezone — and a bare month read off a stored
   * instant is the same bug as a bare cast to a date, one calendar unit up. A
   * refusal at half past midnight IST on the first belongs to the new month
   * and to the old one in GMT.
   */
  month: string;
};

/**
 * Whether a key may be spent now.
 *
 * Three ways to be available and they are not the same statement. Never
 * refused. Refused in a month that has since ended, which is a quota that has
 * reset. Or refused in this month, long enough ago that the cooldown has run
 * out and it is worth one request to find out whether that refusal was the
 * month or merely a busy minute.
 *
 * The third costs one failed request per cooldown period on a key that really
 * is finished for the month, and that is the price of the first one: there is
 * no way to be told a quota has been topped up except by asking.
 */
export function keyIsAvailable(
  spend: KeySpend | null,
  now: Date,
  month: string,
  cooldownHours: number,
): boolean {
  if (!spend) return true;
  /* An earlier month's refusal is a quota that has since reset. A month
     STRICTLY earlier, so a refusal stamped in the future — a clock that
     jumped and came back — falls through to the cooldown rather than reading
     as ancient history. */
  if (spend.month < month) return true;
  return now.getTime() - spend.spentAt.getTime() >= cooldownHours * 60 * 60 * 1000;
}

/**
 * The key to spend, or null when every one held has been refused.
 *
 * In declared order, always. The first key is the one that carries the load
 * and the rest are insurance, so "which key" has a stable answer that somebody
 * reading a usage dashboard at Ola can recognise.
 */
export function chooseOlaKey<T extends string>(
  held: readonly T[],
  spends: ReadonlyMap<string, KeySpend | null>,
  now: Date,
  month: string,
  cooldownHours: number,
): T | null {
  for (const name of held) {
    if (keyIsAvailable(spends.get(name) ?? null, now, month, cooldownHours)) return name;
  }
  return null;
}

/** What a key is doing, for the one screen that shows the pool. */
export type KeyState =
  /** The one being spent right now. */
  | "live"
  /** Available, and behind the live one in the order. Nothing is wrong with it. */
  | "ready"
  /** Refused for quota, waiting out its cooldown before it is tried again. */
  | "resting";

export type KeyReport = {
  name: string;
  state: KeyState;
  /** When a resting key will next be tried. Null for the other two states. */
  retryAt: Date | null;
  /** When it was refused, for a screen that says how long ago. */
  spentAt: Date | null;
};

/**
 * The whole pool as a screen should read it.
 *
 * Derived from the same two functions the caller selects with, rather than
 * from a second reading of the same facts — a console that disagreed with the
 * request it is describing is worse than no console, which is the rule the
 * Admin Console already carries about answering from the database.
 */
export function olaPoolReport<T extends string>(
  held: readonly T[],
  spends: ReadonlyMap<string, KeySpend | null>,
  now: Date,
  month: string,
  cooldownHours: number,
): KeyReport[] {
  const live = chooseOlaKey(held, spends, now, month, cooldownHours);
  return held.map((name) => {
    const spend = spends.get(name) ?? null;
    const available = keyIsAvailable(spend, now, month, cooldownHours);
    return {
      name,
      state: name === live ? "live" : available ? "ready" : "resting",
      retryAt:
        available || !spend
          ? null
          : new Date(spend.spentAt.getTime() + cooldownHours * 60 * 60 * 1000),
      spentAt: spend?.spentAt ?? null,
    };
  });
}
