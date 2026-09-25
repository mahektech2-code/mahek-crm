import {
  addDays,
  isoWeekday,
  isWorkingDay,
  nextWorkingDay,
  onOrAfterWorkingDay,
  previousWorkingDay,
  type WorkingDayConfig,
} from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * "CALL AFTER 15 DAYS" BECOMES A DATE HERE, AND NOWHERE ELSE.
 *
 * A language model is good at hearing that somebody said "pandrah din baad"
 * and bad at knowing what day it is, how many days September has, or that
 * Sunday is not a working day at Mahek. So the split is deliberate: the model
 * reports the CUE — what kind of date was spoken, with the words it came
 * from — and this file does the arithmetic against the business date and the
 * configured working week. A date the model computed itself would be a date
 * nobody could check; a cue plus a rule is a date anybody can.
 *
 * It also parses the words itself (`parseDateCues`), which is the second
 * opinion: the model's cue and this file's reading of the SAME phrase are
 * compared, and where they land on different days the card asks rather than
 * picks. That is the client's rule — "if AI is not sure, ask; do not guess" —
 * applied to the one field where a wrong guess is a customer rung on the wrong
 * day.
 *
 * AMBIGUITY IS AN ANSWER. "Next Friday" said on a Thursday is tomorrow to half
 * the office and a week tomorrow to the other half, and no amount of context
 * settles it. `resolveDateCue` returns both, and the screen offers both.
 *
 * PURE — no clock, no I/O. The business date is an argument, like every other
 * engine here.
 * ------------------------------------------------------------------------- */

export type DateCue =
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "day_after_tomorrow" }
  | { kind: "in_days"; n: number }
  | { kind: "in_weeks"; n: number }
  | { kind: "in_months"; n: number }
  /** ISO weekday, Monday 1 … Sunday 7. `next` is "next Monday"; `this` is
   *  "Monday", "this Monday", "coming Monday" — the first one ahead. */
  | { kind: "weekday"; weekday: number; which: "this" | "next" }
  | { kind: "next_week" }
  | { kind: "month_end" }
  | { kind: "next_month" }
  /** "the 20th", "20 tarikh" — with the month where one was named. */
  | { kind: "day_of_month"; day: number; month: number | null }
  | { kind: "absolute"; date: string }
  | { kind: "unclear" };

export type ResolvedDate = {
  /** Null where the cue named no day at all — the card asks for one. */
  date: string | null;
  /** The other day the same words could mean. Present only when they differ. */
  alternative: string | null;
  /** The day the words named, where it was not a working day and moved. */
  movedFrom: string | null;
  /** Earlier than today — the customer cannot have meant that, or we misheard. */
  past: boolean;
  /** One sentence, shown under the date: how it was worked out. */
  explanation: string;
};

const WEEKDAYS = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const SHORT_DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Mon 5 Oct". Formatted here rather than through Intl, which has a zone. */
export function dayLabel(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${SHORT_DAYS[isoWeekday(iso)]} ${d} ${MONTHS[m]}`;
}

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The same day-of-month `n` months on, clamped: 31 Jan + 1 month is 28 Feb. */
function addMonthsClamped(date: string, n: number): string {
  const [y, m, d] = parts(date);
  const index = y * 12 + (m - 1) + n;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  return iso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

function isValidIso(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = parts(date);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** The first `weekday` strictly after `today`. */
function comingWeekday(today: string, weekday: number): string {
  const gap = (weekday - isoWeekday(today) + 7) % 7 || 7;
  return addDays(today, gap);
}

/** `weekday` in the ISO week after the one `today` is in. */
function weekdayOfNextWeek(today: string, weekday: number): string {
  const mondayNext = addDays(today, 8 - isoWeekday(today));
  return addDays(mondayNext, weekday - 1);
}

/**
 * The day a cue names, and how it was reached.
 *
 * WORKING DAYS: a date that lands on a day nobody works moves FORWARD to the
 * next one, except month end, which moves BACK — "by month end" is a deadline,
 * and the day after a deadline is the day it was missed.
 */
export function resolveDateCue(
  cue: DateCue,
  today: string,
  working: WorkingDayConfig,
): ResolvedDate {
  const settle = (
    raw: string,
    explanation: string,
    alternative: string | null = null,
  ) => {
    const date = onOrAfterWorkingDay(raw, working);
    const alt = alternative ? onOrAfterWorkingDay(alternative, working) : null;
    const movedFrom = date === raw ? null : raw;
    return {
      date,
      alternative: alt && alt !== date ? alt : null,
      movedFrom,
      past: date < today,
      explanation: movedFrom
        ? `${explanation} ${dayLabel(raw)} is not a working day, so ${dayLabel(date)}.`
        : explanation,
    };
  };

  switch (cue.kind) {
    case "today":
      return settle(today, "Today.");
    case "tomorrow":
      return settle(addDays(today, 1), "Tomorrow.");
    case "day_after_tomorrow":
      return settle(addDays(today, 2), "The day after tomorrow.");
    case "in_days": {
      const n = Math.max(0, Math.round(cue.n));
      const raw = addDays(today, n);
      return settle(
        raw,
        `${n} day${n === 1 ? "" : "s"} from ${dayLabel(today)} is ${dayLabel(raw)}.`,
      );
    }
    case "in_weeks": {
      const n = Math.max(0, Math.round(cue.n));
      const raw = addDays(today, n * 7);
      return settle(
        raw,
        `${n} week${n === 1 ? "" : "s"} from ${dayLabel(today)} is ${dayLabel(raw)}.`,
      );
    }
    case "in_months": {
      const n = Math.max(0, Math.round(cue.n));
      const raw = addMonthsClamped(today, n);
      return settle(
        raw,
        `${n} month${n === 1 ? "" : "s"} from ${dayLabel(today)} is ${dayLabel(raw)}.`,
      );
    }
    case "weekday": {
      const wd = Math.round(cue.weekday);
      if (wd < 1 || wd > 7)
        return unclear("A day of the week was mentioned but not which one.");
      const coming = comingWeekday(today, wd);
      const ofNextWeek = weekdayOfNextWeek(today, wd);
      if (cue.which === "this") {
        return settle(coming, `The coming ${WEEKDAYS[wd]}.`);
      }
      /* "Next Friday" — both readings are in use in the office. When they
         agree there is nothing to ask; when they do not, both go on screen. */
      if (coming === ofNextWeek) return settle(coming, `Next ${WEEKDAYS[wd]}.`);
      return settle(
        coming,
        `"Next ${WEEKDAYS[wd]}" can mean ${dayLabel(coming)} or ${dayLabel(ofNextWeek)}.`,
        ofNextWeek,
      );
    }
    case "next_week": {
      const monday = weekdayOfNextWeek(today, 1);
      return settle(monday, `Next week starts ${dayLabel(monday)}.`);
    }
    case "month_end": {
      const [y, m] = parts(today);
      const last = iso(y, m, daysInMonth(y, m));
      const date = isWorkingDay(last, working)
        ? last
        : previousWorkingDay(last, working);
      return {
        date,
        alternative: null,
        movedFrom: date === last ? null : last,
        past: date < today,
        explanation:
          date === last
            ? `Month end is ${dayLabel(last)}.`
            : `Month end is ${dayLabel(last)}, not a working day, so the last working day before it: ${dayLabel(date)}.`,
      };
    }
    case "next_month": {
      const [y, m] = parts(today);
      const first = m === 12 ? iso(y + 1, 1, 1) : iso(y, m + 1, 1);
      return settle(first, `Next month starts ${dayLabel(first)}.`);
    }
    case "day_of_month": {
      const [y, m, d] = parts(today);
      const day = Math.round(cue.day);
      if (day < 1 || day > 31)
        return unclear("A date was mentioned but the day did not make sense.");
      if (cue.month !== null) {
        const month = Math.round(cue.month);
        if (month < 1 || month > 12)
          return unclear("A date was mentioned but not the month.");
        /* A named month that has already gone this year is next year's. */
        let year = y;
        let candidate = iso(
          year,
          month,
          Math.min(day, daysInMonth(year, month)),
        );
        if (candidate < today) {
          year += 1;
          candidate = iso(year, month, Math.min(day, daysInMonth(year, month)));
        }
        return settle(candidate, `${dayLabel(candidate)}.`);
      }
      /* "The 20th" on the 24th is next month's 20th — nobody promises a date
         that has already gone. On the day itself it means today. */
      const [cy, cm] = day >= d ? [y, m] : nextMonthOf(y, m);
      const candidate = iso(cy, cm, Math.min(day, daysInMonth(cy, cm)));
      return settle(candidate, `The ${ordinal(day)}: ${dayLabel(candidate)}.`);
    }
    case "absolute": {
      if (!isValidIso(cue.date))
        return unclear("A date was mentioned that could not be read.");
      return settle(cue.date, `${dayLabel(cue.date)}.`);
    }
    case "unclear":
      return unclear("A time was mentioned but not a day — ask which day.");
  }
}

function nextMonthOf(y: number, m: number): [number, number] {
  return m === 12 ? [y + 1, 1] : [y, m + 1];
}

function ordinal(n: number): string {
  const s =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

function unclear(explanation: string): ResolvedDate {
  return {
    date: null,
    alternative: null,
    movedFrom: null,
    past: false,
    explanation,
  };
}

/** The first working day `n` working days after `today` — the no-answer retry. */
export function workingDaysAhead(
  today: string,
  n: number,
  working: WorkingDayConfig,
): string {
  let cursor = today;
  for (let i = 0; i < Math.max(1, n); i++)
    cursor = nextWorkingDay(cursor, working);
  return cursor;
}

/* ------------------------------------------------------------------ parse */

/*
 * THE WORDS, IN THE THREE WAYS THEY ARRIVE. A telecaller's note is English,
 * the transcript is Hindi or Marathi in Devanagari, and half of what is typed
 * is Hindi in Latin letters — "15 din baad call karna". All three are read.
 */

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  a: 1,
  an: 1,
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  chaar: 4,
  paanch: 5,
  panch: 5,
  chhe: 6,
  che: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  das: 10,
  pandrah: 15,
  pandra: 15,
  bees: 20,
  tees: 30,
  एक: 1,
  दो: 2,
  तीन: 3,
  चार: 4,
  पांच: 5,
  पाँच: 5,
  छह: 6,
  सात: 7,
  आठ: 8,
  दस: 10,
  पंद्रह: 15,
  बीस: 20,
  तीस: 30,
};

const WEEKDAY_WORDS: Array<[RegExp, number]> = [
  [/^(mon(day)?|somvar|somwar|सोमवार)$/, 1],
  [/^(tue(s(day)?)?|mangalvar|mangalwar|मंगलवार)$/, 2],
  [/^(wed(nesday)?|budhvar|budhwar|बुधवार)$/, 3],
  [
    /^(thu(r(s(day)?)?)?|guruvar|guruwar|brihaspativar|गुरुवार|बृहस्पतिवार)$/,
    4,
  ],
  [/^(fri(day)?|shukravar|shukrawar|शुक्रवार)$/, 5],
  [/^(sat(urday)?|shanivar|shaniwar|शनिवार)$/, 6],
  [/^(sun(day)?|ravivar|raviwar|itwar|रविवार)$/, 7],
];

const MONTH_WORDS: Array<[RegExp, number]> = [
  [/^jan(uary)?$/, 1],
  [/^feb(ruary)?$/, 2],
  [/^mar(ch)?$/, 3],
  [/^apr(il)?$/, 4],
  [/^may$/, 5],
  [/^june?$/, 6],
  [/^july?$/, 7],
  [/^aug(ust)?$/, 8],
  [/^sep(t(ember)?)?$/, 9],
  [/^oct(ober)?$/, 10],
  [/^nov(ember)?$/, 11],
  [/^dec(ember)?$/, 12],
];

function numberOf(word: string): number | null {
  if (/^\d{1,3}$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

function weekdayOf(word: string): number | null {
  for (const [re, n] of WEEKDAY_WORDS) if (re.test(word)) return n;
  return null;
}

function monthOf(word: string): number | null {
  for (const [re, n] of MONTH_WORDS) if (re.test(word)) return n;
  return null;
}

export type ParsedCue = { cue: DateCue; phrase: string };

/**
 * Every date-like phrase in a piece of text, in the order it appears.
 *
 * Deliberately conservative: a phrase it cannot read is simply not returned,
 * and silence here never outvotes the model — it only ever raises a question
 * when both read the same words and disagree.
 */
export function parseDateCues(text: string): ParsedCue[] {
  const found: Array<ParsedCue & { at: number }> = [];
  const lower = text.toLowerCase();
  const push = (at: number, phrase: string, cue: DateCue) =>
    found.push({ at, phrase, cue });

  const unit = (u: string): "d" | "w" | "m" | null => {
    if (/^(days?|din|dino|dinon|दिन|दिनों)$/.test(u)) return "d";
    if (/^(weeks?|hafte|hafta|hafton|हफ्ते|हफ़्ते|हफ्ता|सप्ताह)$/.test(u))
      return "w";
    if (/^(months?|mahine|mahina|mahino|महीने|महीना)$/.test(u)) return "m";
    return null;
  };
  const cueFor = (n: number, u: "d" | "w" | "m"): DateCue =>
    u === "d"
      ? { kind: "in_days", n }
      : u === "w"
        ? { kind: "in_weeks", n }
        : { kind: "in_months", n };

  const W = "([\\p{L}\\p{M}\\d]+)";

  /* "after 15 days", "in two weeks", "within 10 days" */
  for (const m of lower.matchAll(
    new RegExp(`\\b(?:after|in|within)\\s+${W}\\s+${W}`, "gu"),
  )) {
    const n = numberOf(m[1]);
    const u = unit(m[2]);
    if (n !== null && u) push(m.index!, m[0], cueFor(n, u));
  }
  /* "15 din baad", "do hafte me", "15 दिन बाद" */
  for (const m of lower.matchAll(
    new RegExp(
      `${W}\\s+${W}\\s+(baad|bad|me|mein|mai|बाद|में)(?![\\p{L}])`,
      "gu",
    ),
  )) {
    const n = numberOf(m[1]);
    const u = unit(m[2]);
    if (n !== null && u) push(m.index!, m[0], cueFor(n, u));
  }
  /* "15 days later" */
  for (const m of lower.matchAll(
    new RegExp(`${W}\\s+${W}\\s+later\\b`, "gu"),
  )) {
    const n = numberOf(m[1]);
    const u = unit(m[2]);
    if (n !== null && u) push(m.index!, m[0], cueFor(n, u));
  }

  /* weekdays: "next monday", "agle somvar", "this friday", "monday ko" */
  for (const m of lower.matchAll(
    new RegExp(
      `(?:(next|agle|agla|coming|this|is)\\s+)?${W}(?:\\s+(ko|को))?`,
      "gu",
    ),
  )) {
    const wd = weekdayOf(m[2]);
    if (!wd) continue;
    /* A bare "do" or "sat" is not a weekday; only the unambiguous spellings
       stand alone, the short ones need a word in front. */
    const bareOk = m[2].length > 3 || Boolean(m[1]) || Boolean(m[3]);
    if (!bareOk) continue;
    const which =
      m[1] === "next" || m[1] === "agle" || m[1] === "agla" ? "next" : "this";
    push(m.index!, m[0].trim(), { kind: "weekday", weekday: wd, which });
  }

  const simple: Array<[RegExp, DateCue]> = [
    [
      /\b(day after tomorrow|parso|parson|parsoon)\b|परसों/gu,
      { kind: "day_after_tomorrow" },
    ],
    [/\btomorrow\b|\bkal\b|कल/gu, { kind: "tomorrow" }],
    [/\btoday\b|\baaj\b|आज/gu, { kind: "today" }],
    [
      /\bnext week\b|\bagle (hafte|week)\b|अगले (हफ्ते|हफ़्ते|सप्ताह)/gu,
      { kind: "next_week" },
    ],
    [
      /\b(month end|end of (the )?month|mahine ke (end|aakhir|akhir)|month ke end)\b|महीने के (अंत|आखिर)/gu,
      { kind: "month_end" },
    ],
    [/\bnext month\b|\bagle mahine\b|अगले महीने/gu, { kind: "next_month" }],
  ];
  for (const [re, cue] of simple) {
    for (const m of lower.matchAll(re)) {
      /* "day after tomorrow" also contains "tomorrow" — the longer phrase wins. */
      if (
        cue.kind === "tomorrow" &&
        found.some(
          (f) =>
            f.cue.kind === "day_after_tomorrow" &&
            f.at <= m.index! &&
            m.index! < f.at + f.phrase.length,
        )
      )
        continue;
      push(m.index!, m[0], cue);
    }
  }

  /* "20 tarikh", "on the 20th", "20th october", "5 oct" */
  for (const m of lower.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(tarikh|tareekh|तारीख)/gu,
  )) {
    push(m.index!, m[0], {
      kind: "day_of_month",
      day: Number(m[1]),
      month: null,
    });
  }
  for (const m of lower.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/gu,
  )) {
    const month = monthOf(m[2]);
    if (month)
      push(m.index!, m[0], { kind: "day_of_month", day: Number(m[1]), month });
  }
  /* "on the 19th", and the office's own "on 19th" */
  for (const m of lower.matchAll(
    /\bon (?:the )?(\d{1,2})(?:st|nd|rd|th)\b/gu,
  )) {
    push(m.index!, m[0], {
      kind: "day_of_month",
      day: Number(m[1]),
      month: null,
    });
  }
  /* 18-8-2026, 18/08/26 — day first, as India writes it. */
  for (const m of lower.matchAll(
    /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/gu,
  )) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      push(m.index!, m[0], { kind: "absolute", date: iso(y, mo, d) });
    }
  }

  return found
    .sort((a, b) => a.at - b.at)
    .map(({ cue, phrase }) => ({ cue, phrase }));
}

/**
 * The second opinion on one phrase: does this file's reading of the words the
 * model quoted land on the same day as the model's own cue?
 *
 * `null` where this file cannot read the phrase at all — silence is not a
 * disagreement. Otherwise the day this file makes of it, for the caller to
 * compare.
 */
export function crossCheckPhrase(
  phrase: string,
  today: string,
  working: WorkingDayConfig,
): string | null {
  const [first] = parseDateCues(phrase);
  if (!first) return null;
  return resolveDateCue(first.cue, today, working).date;
}
