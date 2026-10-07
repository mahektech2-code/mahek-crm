import "server-only";
import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { isStepCount, streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { sql as pg } from "@/db";
import type { ReservedSql } from "postgres";
import { requireCapability } from "@/lib/access-control";
import { listUserApps, listUserModules } from "@/lib/access";
import { APP_TIMEZONE, calendarDate } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { readSecret } from "@/lib/secrets";
import { managerScope } from "@/lib/services/sales-service";
import { isPermanentRefusal } from "@/lib/voice-readiness";
import { TABLES, allowedTables, buildViews, type BuiltView } from "@/lib/team-ask/catalog";
import { guardSql } from "@/lib/team-ask/sql-guard";
import { TtlCache, normaliseQuestion, normaliseSql } from "@/lib/team-ask/cache";

/* ---------------------------------------------------------------------------
 * "Ask about the team", answered from the database.
 *
 * IT USED TO BE HANDED A SUMMARY, and that is why it could not answer. The
 * first version gave the model one pre-written brief — this month's figures
 * and today's attendance — and forbade it anything else, so "when did Mahesh
 * take leave this year", "which shops did Priya visit on Tuesday" and "how
 * many salesmen do I have in Nagpur" all met "I don't have that". A manager
 * asks about the whole of the team's record, not about the one page somebody
 * guessed they would ask about.
 *
 * So the model writes its own reads now, through ONE tool, `run_sql`, as many
 * times as a question needs. What makes that safe is not the prompt:
 *
 *  1. EVERY QUESTION GETS ITS OWN TRANSACTION, holding temporary views named
 *     after the real tables and built by `team-ask/catalog.ts` for THIS person
 *     — only the tables their Sales Dashboard screens show (the Access screen's
 *     own answer), only the rows `managerScope()` lets them see, and never a
 *     credential or an identity number.
 *  2. `search_path` IS `pg_temp` ALONE, so those views are the only relations
 *     an unqualified name can reach, and `sql-guard.ts` refuses a qualified
 *     one, a `pg_*` function and anything that runs a query from a string.
 *  3. THE TRANSACTION IS READ ONLY and is ROLLED BACK at the end, so nothing
 *     can be written and the views vanish with it. Each query also runs inside
 *     a savepoint under a statement timeout, so a bad or slow query costs the
 *     model one retry rather than the whole answer.
 *
 * The session's zone is `APP_TIMEZONE`, so `current_date` and a timestamp
 * cast to a date mean the working day in India — the rule this codebase keeps
 * everywhere else, applied to SQL nobody here wrote.
 *
 * WHAT IT CANNOT DO is act. There is no write, no approval and no nudge.
 * ------------------------------------------------------------------------- */

export type AskTurn = { role: "user" | "assistant"; text: string };

export type AskEvent =
  | { type: "step"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; queries: number; dbQueries: number; cached: boolean; ms: number }
  | { type: "error"; message: string };

const MAX_ROWS = 200;
const MAX_RESULT_CHARS = 40_000;

/* ------------------------------------------------------------ the schema */

type Shape = { columns: Map<string, string[]>; enums: Map<string, string[]>; at: number };
let shapeCache: Shape | null = null;

/**
 * The real columns of every table the catalog names, and the values of every
 * enum column, read once per process every ten minutes. The column list is
 * read from the database rather than typed beside the catalog so a column
 * added by a migration reaches the panel without anybody remembering it.
 */
async function shape(): Promise<Shape> {
  if (shapeCache && Date.now() - shapeCache.at < 600_000) return shapeCache;
  const names = TABLES.map((t) => t.table);
  const rows = await pg<{ table_name: string; column_name: string; udt_name: string; data_type: string }[]>`
    select table_name, column_name, udt_name, data_type
      from information_schema.columns
     where table_schema = 'public' and table_name in ${pg(names)}
     order by table_name, ordinal_position
  `;
  const enumRows = await pg<{ typname: string; label: string }[]>`
    select t.typname, e.enumlabel as label
      from pg_type t join pg_enum e on e.enumtypid = t.oid
     order by t.typname, e.enumsortorder
  `;
  const byType = new Map<string, string[]>();
  for (const r of enumRows) byType.set(r.typname, [...(byType.get(r.typname) ?? []), r.label]);
  const columns = new Map<string, string[]>();
  const enums = new Map<string, string[]>();
  for (const r of rows) {
    columns.set(r.table_name, [...(columns.get(r.table_name) ?? []), r.column_name]);
    if (r.data_type === "USER-DEFINED" && byType.has(r.udt_name)) {
      enums.set(`${r.table_name}.${r.column_name}`, byType.get(r.udt_name)!);
    }
  }
  shapeCache = { columns, enums, at: Date.now() };
  return shapeCache;
}

function describe(views: BuiltView[], enums: Map<string, string[]>): string {
  return views
    .map((v) => {
      const cols = v.columns
        .map((c) => {
          const values = enums.get(`${v.table}.${c}`);
          return values ? `${c} [${values.join("|")}]` : c;
        })
        .join(", ");
      return `${v.table} — ${v.about}\n  columns: ${cols}`;
    })
    .join("\n");
}

/* ------------------------------------------------------------ the results */

/** A value as the model should read it: instants in IST, dates as dates. */
function plain(value: unknown, typeOid: number | undefined): unknown {
  if (value instanceof Date) {
    /* A DATE column: the driver parses it as UTC midnight, so read it back in UTC. */
    if (typeOid === 1082) return calendarDate(value, "UTC");
    return (
      new Intl.DateTimeFormat("en-CA", {
        timeZone: APP_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .format(value)
        .replace(",", "") + " IST"
    );
  }
  return value;
}

function serialise(rows: Record<string, unknown>[] & { columns?: Array<{ name: string; type: number }> }) {
  const types = new Map((rows.columns ?? []).map((c) => [c.name, c.type]));
  const kept = rows.slice(0, MAX_ROWS).map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k] = plain(v, types.get(k));
    return out;
  });
  let json = JSON.stringify(kept);
  let truncated = rows.length > MAX_ROWS;
  if (json.length > MAX_RESULT_CHARS) {
    json = json.slice(0, MAX_RESULT_CHARS);
    truncated = true;
  }
  return { rowCount: rows.length, truncated, rows: json };
}

/* -------------------------------------------------------------- the prompt */

function systemPrompt(input: {
  name: string;
  userId: string;
  day: string;
  scopeLine: string;
  schema: string;
  missing: string[];
}): string {
  return [
    "You answer a sales manager's questions about their field team at Mahek Marketing India (thinner and paint products, sold to shops across India).",
    "You have a read-only Postgres database through the run_sql tool. Answer ONLY from what your queries return — never invent, estimate or guess a name, figure or date. If the data cannot answer, say so plainly.",
    "",
    "HOW TO WORK",
    "- Go straight to the query; do not ask the manager to clarify unless the question is truly ambiguous. Prefer one well-built query with joins and aggregates over many small ones; run more only when needed.",
    "- Find people by name with ILIKE on users.name (and employees.name). A field salesman is a user with an app_access row where app = 'field'.",
    "- The session time zone is Asia/Kolkata: current_date is today in India, and some_timestamp::date gives the Indian date. Timestamps in results are already shown in IST.",
    "- Money columns ending _paise, and orders.total_amount / bills.amount / payment_receipts.amount / customers.outstanding, are in PAISE: divide by 100 for rupees. Show rupees with Indian grouping, e.g. ₹1,25,000.",
    "- Volumes in ml: divide by 1000 for litres. *_bp columns are basis points: divide by 100 for percent.",
    "- Always aggregate in SQL (count, sum) rather than counting rows yourself, and LIMIT long lists. Never select every column of a big table.",
    "- Use only the tables and columns listed below; schema-qualified names, comments and pg_* functions are refused.",
    "",
    "HOW TO ANSWER",
    "- Lead with the answer. Be short: a sentence or two, then a compact list only when it helps. Use names, not ids.",
    "- Plain text only: no markdown headings, bold, code or tables. For a list, one item per line starting with '- '.",
    "- Never show SQL, table names or ids to the manager.",
    "- Answer in the language the question was asked in.",
    "- If something is not available because of this person's access (listed below), say which screen access they would need.",
    "",
    "TABLES YOU CAN READ (all already narrowed to what this manager may see)",
    input.schema,
    ...(input.missing.length
      ? ["", "NOT AVAILABLE to this manager (their access does not include the screen):", ...input.missing.map((m) => `- ${m}`)]
      : []),
    "",
    /* THE PARTS THAT CHANGE GO LAST. OpenAI caches a prompt by its prefix, so
       the rules and the schema — identical for everybody who sees the same
       rows, every question of the day — come first and are read from its
       cache; only the date and the name below are new each time. */
    input.scopeLine,
    `The manager asking is ${input.name} (user id ${input.userId}). Today is ${input.day}.`,
  ].join("\n");
}

const MODULE_LABEL: Record<string, string> = {
  "sales.leave": "Leave",
  "sales.attendance": "Attendance",
  "sales.salary": "Salary",
  "sales.live": "Live map",
  "sales.journeys": "Journeys & visits",
  "sales.orders": "Orders",
  "sales.payments": "Payments",
  "sales.invoices": "Invoices",
  "sales.expenses": "Expenses",
  "sales.tasks": "Tasks",
  "sales.performance": "Performance",
  "sales.targets": "Sales Targets",
  "sales.field-reports": "Field reports",
  "sales.activity-history": "Activity history",
  "sales.approvals": "Approvals",
  "sales.samples": "Samples",
  "sales.leads": "Leads",
};


/* --------------------------------------------------------------- the memory */

/** Everything about one person that does not change from question to question. */
type AskContext = {
  userId: string;
  name: string;
  /** The views that express what they may read, in build order. */
  statements: string[];
  /** A hash of those statements: equal only for people who see the same rows. */
  visibility: string;
  /** The prompt, less the question. */
  system: string;
};

const contexts = new TtlCache<AskContext>(500);
const results = new TtlCache<ReturnType<typeof serialise>>(2_000);
const answers = new TtlCache<{ text: string; queries: number }>(1_000);

/**
 * What this person may read, resolved once and then remembered.
 *
 * Resolving it is the scope (territories, the people in them), the grants and
 * the module rows — several round trips that every question would otherwise
 * repeat. It is remembered for `salesAsk.contextCacheSeconds`, so a change on
 * the Access screen or the Territory screen reaches the panel within that
 * window rather than on the next keystroke; that is the price of not paying
 * those round trips on every question, and it is a setting.
 */
async function contextFor(
  user: { id: string; name: string },
  ttlSeconds: number,
): Promise<AskContext> {
  const cached = contexts.get(user.id);
  if (cached) return cached;

  const [apps, scope, day, { columns, enums }] = await Promise.all([
    listUserApps(user.id),
    managerScope(),
    today(),
    shape(),
  ]);
  /* No module rows means every module — but only for somebody actually
     GRANTED the Sales Dashboard. `listUserModules` alone would answer with
     the whole app for somebody who holds none of it. */
  const modules = new Set(
    apps.includes("sales") ? (await listUserModules(user.id, "sales")).map((m) => m.key) : [],
  );

  const { statements, views } = buildViews({
    salesmanIds: scope.salesmanIds,
    selfId: user.id,
    own: Boolean(scope.own),
    modules,
    columns,
  });

  const allowed = new Set(allowedTables(modules).map((t) => t.table));
  const missing = TABLES.filter((t) => !allowed.has(t.table)).map(
    (t) => `${t.table} — needs ${t.modules.map((m) => MODULE_LABEL[m] ?? m).join(" or ")}`,
  );
  const scopeLine = scope.national
    ? "They see the whole company: every salesman and every customer."
    : scope.own
      ? "They see only their own book."
      : `They oversee ${scope.regions.length ? scope.regions.join(", ") : "a region"}: ${scope.salesmanIds?.length ?? 0} salesmen and the customers those salesmen hold. Nobody else is in the tables.`;

  const ctx: AskContext = {
    userId: user.id,
    name: user.name,
    statements,
    visibility: createHash("sha256").update(statements.join(";\n")).digest("hex"),
    system: systemPrompt({
      name: user.name,
      userId: user.id,
      day,
      scopeLine,
      schema: describe(views, enums),
      missing,
    }),
  };
  contexts.set(user.id, ctx, ttlSeconds * 1000);
  return ctx;
}

/* -------------------------------------------------------------- the session */

/**
 * The database side of ONE question, opened only if a query actually misses
 * the cache.
 *
 * A question whose every query was asked a moment ago — the same chip pressed
 * by two managers, the same question asked twice — never takes a connection
 * at all. The first miss reserves one, opens the transaction and builds the
 * views; later misses in the same question reuse it; `close` rolls it all
 * back and hands the connection to the pool.
 */
class Session {
  private conn: ReservedSql | null = null;
  private opening: Promise<ReservedSql> | null = null;
  dbQueries = 0;

  constructor(
    private readonly ctx: AskContext,
    private readonly queryTimeoutSeconds: number,
  ) {}

  private async open(): Promise<ReservedSql> {
    const conn = await pg.reserve();
    this.conn = conn;
    await conn.unsafe("begin");
    for (const s of this.ctx.statements) await conn.unsafe(s);
    await conn.unsafe("set local search_path = pg_temp");
    await conn.unsafe(`set local timezone = '${APP_TIMEZONE}'`);
    await conn.unsafe(`set local statement_timeout = '${Math.max(1, Math.floor(this.queryTimeoutSeconds))}s'`);
    await conn.unsafe("set transaction read only");
    return conn;
  }

  async run(text: string): Promise<Record<string, unknown>[]> {
    this.opening ??= this.open();
    const conn = await this.opening;
    this.dbQueries += 1;
    await conn.unsafe("savepoint q");
    try {
      const rows = await conn.unsafe(text, [], { prepare: false });
      await conn.unsafe("release savepoint q");
      return rows as unknown as Record<string, unknown>[];
    } catch (e) {
      await conn.unsafe("rollback to savepoint q");
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.opening) await this.opening.catch(() => undefined);
    const conn = this.conn;
    this.conn = null;
    if (!conn) return;
    try {
      await conn.unsafe("rollback");
    } catch {
      /* nothing was written; the connection is released either way */
    } finally {
      conn.release();
    }
  }
}

/* ------------------------------------------------------------- the answer */

/**
 * Resolve and remember what this person may read, before they have typed.
 *
 * The drawer calls this as it opens, so the first question starts with its
 * context already built. Cheap to call twice: the second is a cache hit.
 */
export async function warmTeamAsk(): Promise<void> {
  try {
    const ctx = await requireCapability("team.report");
    const config = await getConfig();
    if (!config["salesAsk.enabled"]) return;
    await contextFor(ctx.user, config["salesAsk.contextCacheSeconds"]);
  } catch {
    /* warming is a courtesy; the question will say what went wrong */
  }
}

/**
 * Answer one question, sending progress and the answer's text as it arrives.
 *
 * `emit` is called with steps ("Leave Mahesh took this year"), text deltas,
 * and a final `done` or `error`. Never throws.
 */
export async function askTeamStream(
  question: string,
  history: AskTurn[],
  emit: (e: AskEvent) => void,
): Promise<void> {
  const started = Date.now();
  let session: Session | null = null;
  try {
    const scope = await requireCapability("team.report");
    const config = await getConfig();
    if (!config["salesAsk.enabled"]) {
      emit({ type: "error", message: "Ask about the team is switched off in Admin Console → Settings → Sales Dashboard." });
      return;
    }
    const key = await readSecret("openai.apiKey");
    if (!key) {
      emit({
        type: "error",
        message: "No OpenAI account is connected yet. Add an OpenAI key in Admin Console → Integrations and this will start working.",
      });
      return;
    }

    const ctx = await contextFor(scope.user, config["salesAsk.contextCacheSeconds"]);

    /* A FRESH QUESTION ASKED A MOMENT AGO IS ANSWERED FROM MEMORY. Only a
       fresh one: "and last month?" means something different after every
       conversation, so a follow-up always goes to the model. */
    const answerKey = history.length ? null : `${ctx.visibility}|${normaliseQuestion(question)}`;
    const remembered = answerKey ? answers.get(answerKey) : undefined;
    if (remembered) {
      emit({ type: "delta", text: remembered.text });
      emit({ type: "done", queries: 0, dbQueries: 0, cached: true, ms: Date.now() - started });
      return;
    }

    session = new Session(ctx, config["salesAsk.queryTimeoutSeconds"]);
    const live = session;
    const resultTtl = config["salesAsk.resultCacheSeconds"] * 1000;
    let queries = 0;
    let text = "";

    const messages: ModelMessage[] = [
      ...history.slice(-8).map((t) => ({ role: t.role, content: t.text.slice(0, 4000) }) as ModelMessage),
      { role: "user", content: question },
    ];

    const result = streamText({
      model: createOpenAI({ apiKey: key })(config["salesAsk.model"]),
      system: ctx.system,
      messages,
      tools: {
        run_sql: tool({
          description:
            "Run ONE read-only PostgreSQL SELECT (or WITH … SELECT) against the tables listed in the instructions, and get the rows back as JSON (at most 200 rows). Use unqualified table names.",
          inputSchema: z.object({
            purpose: z
              .string()
              .describe("Five to eight words saying what this query finds, e.g. 'Leave Mahesh took this year'."),
            sql: z.string().describe("The query."),
          }),
          execute: async ({ purpose, sql: text }) => {
            queries += 1;
            emit({ type: "step", text: purpose });
            const guard = guardSql(text);
            if (!guard.ok) return { error: guard.reason };
            /* THE SAME READ UNDER THE SAME VISIBILITY IS READ ONCE. The key
               carries the hash of the views, so it can only ever be served
               to somebody who would have got exactly these rows anyway. */
            const cacheKey = `${ctx.visibility}|${normaliseSql(guard.sql)}`;
            const hit = results.get(cacheKey);
            if (hit) return hit;
            try {
              const out = serialise(await live.run(guard.sql));
              results.set(cacheKey, out, resultTtl);
              return out;
            } catch (e) {
              return { error: e instanceof Error ? e.message : String(e) };
            }
          },
        }),
      },
      stopWhen: isStepCount(Math.max(2, config["salesAsk.maxQueries"] + 1)),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(Math.max(10, config["salesAsk.timeoutSeconds"]) * 1000),
      providerOptions: {
        openai: {
          reasoningEffort: config["salesAsk.reasoningEffort"] as "minimal" | "low" | "medium" | "high",
          parallelToolCalls: false,
          // Everybody who sees the same rows shares one prompt prefix.
          promptCacheKey: `team-ask-${ctx.visibility.slice(0, 32)}`,
        },
      },
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta" && part.text) {
        text += part.text;
        emit({ type: "delta", text: part.text });
      } else if (part.type === "error") {
        throw part.error;
      }
    }

    if (!text.trim()) {
      emit({ type: "delta", text: "I could not put an answer together from the data for that. Try asking it another way." });
    } else if (answerKey) {
      answers.set(answerKey, { text, queries }, config["salesAsk.answerCacheSeconds"] * 1000);
    }
    emit({ type: "done", queries, dbQueries: live.dbQueries, cached: false, ms: Date.now() - started });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("Ask about the team failed:", detail);
    emit({
      type: "error",
      message: isPermanentRefusal(detail)
        ? "OpenAI refused the request — the connected account may be out of credit, the key may be invalid, or the model name in settings may be wrong. Check Admin Console → Integrations."
        : /timeout|aborted/i.test(detail)
          ? "That took too long to answer. Try a narrower question."
          : /capability|not allowed|forbidden|sign in/i.test(detail)
            ? "Your access does not include asking about the team."
            : "Could not answer just now. Try again in a moment.",
    });
  } finally {
    await session?.close();
  }
}
