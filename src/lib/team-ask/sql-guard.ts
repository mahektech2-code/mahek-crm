/* ---------------------------------------------------------------------------
 * What a question's SQL may look like before it reaches Postgres.
 *
 * The Ask panel lets a language model write its own SELECT, and this is the
 * first of three walls around it. The other two are structural and do most of
 * the work — the query runs in a READ ONLY transaction (nothing can be
 * written), and `search_path` is set to `pg_temp` alone, where the only
 * relations are the scoped views `team-ask-service.ts` built for this person
 * (nothing outside their access can be named). What those two cannot stop is a
 * query that SPELLS its way round them, and that is what this file refuses:
 *
 *  - a schema-qualified name (`public.app_secrets`) reaches past the views;
 *  - `pg_*` functions read server files and catalogs, or end other sessions —
 *    read-only does not stop `pg_read_file` or `pg_terminate_backend`;
 *  - `query_to_xml('…')`, `ts_stat('…')` and friends execute a STRING, which
 *    no check on this text could ever see inside;
 *  - `lo_*`, `dblink`, `set_config`, `COPY … TO PROGRAM`.
 *
 * Comments are refused rather than stripped: `public/**\/.x` is the shape a
 * stripped comment hides, and a model has no need to comment its own query.
 * PURE, so the rule is tested without a database.
 * ------------------------------------------------------------------------- */

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

const FORBIDDEN: Array<[RegExp, string]> = [
  [/--|\/\*/, "Comments are not allowed in the query."],
  [/\bU&/i, "Unicode-escaped identifiers are not allowed."],
  [/\b[eE]'/, "Escape-string literals (E'…') are not allowed; use ordinary quotes."],
  [/"?\b(public|information_schema|drizzle)\b"?\s*\./i, "Do not qualify table names with a schema — use the table names as given."],
  [/\bpg_\w*/i, "System catalogs and pg_* functions are not available."],
  [/\blo_\w+/i, "Large-object functions are not available."],
  [/\bdblink\w*/i, "dblink is not available."],
  [/\w*_to_xml\w*|\bxml\w*\s*\(|\bts_stat\b|\bquery_to\w*/i, "Functions that run a query from a string are not available."],
  [/\b(set_config|current_setting|txid_\w+|nextval|setval|currval)\b/i, "That function is not available."],
  [/\b(copy|insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|execute|prepare|deallocate|listen|notify|vacuum|analyze|lock|call|do|set|reset|discard|refresh|import|load|security|comment)\b\s/i, "Only a read (SELECT) is allowed."],
  [/\bfor\s+(update|share|no\s+key|key)\b/i, "Row locks are not allowed."],
  [/\binto\b\s+\w/i, "SELECT INTO is not allowed."],
];

/**
 * One read, or a refusal that says what to change.
 *
 * The keyword list is deliberately broad — it would refuse a column literally
 * named `set` or `do`, and none of the views carries one. A false refusal costs
 * the model one retry; a false pass is what the other two walls are for.
 */
export function guardSql(raw: string): GuardResult {
  let sql = raw.trim();
  // One trailing semicolon is the ordinary way to end a statement; strip it.
  sql = sql.replace(/;\s*$/, "").trim();
  if (!sql) return { ok: false, reason: "The query is empty." };
  if (sql.length > 8000) return { ok: false, reason: "The query is too long. Ask for less at once." };
  if (sql.includes(";")) return { ok: false, reason: "Send exactly one statement, with no semicolons inside it." };
  if (!/^(select|with)\b/i.test(sql)) return { ok: false, reason: "The query must start with SELECT or WITH." };

  // Checked against the text with string literals blanked, so a customer
  // called "Public Paints" or a note containing "delete" is not refused —
  // and so a keyword cannot hide inside a literal either way.
  const code = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "''");
  for (const [re, reason] of FORBIDDEN) {
    if (re.test(code)) return { ok: false, reason };
  }
  return { ok: true, sql };
}
