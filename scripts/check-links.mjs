#!/usr/bin/env node
/**
 * Crawls the running app as a signed-in user and asserts that every internal
 * link resolves. Catches the class of bug where a route moves and a link is
 * left pointing at the old URL — which no type check or lint rule will see.
 *
 *   npm run check:links
 */
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const WHO = process.argv[2] ?? "vikram@mahek.in";

const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const [user] = await sql`select id, name from users where email = ${WHO}`;
if (!user) {
  console.error(`No user ${WHO} — run npm run db:seed first.`);
  process.exit(1);
}
const sid = randomUUID();
await sql`insert into sessions (id, user_id, expires_at)
          values (${sid}, ${user.id}, now() + interval '1 hour')`;

const cookie = `mahekone_session=${sid}`;
const seen = new Map(); // url -> status
const linkedFrom = new Map(); // url -> page that linked to it
const queue = ["/apps"];

/** Only follow same-origin, non-asset links. */
function normalise(href, from) {
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) return null;
  let u;
  try {
    u = new URL(href, BASE);
  } catch {
    return null;
  }
  if (u.origin !== new URL(BASE).origin) return null;
  if (/\.(png|jpe?g|svg|ico|css|js|woff2?)$/i.test(u.pathname)) return null;
  if (u.pathname.startsWith("/_next") || u.pathname.startsWith("/api")) return null;
  const path = u.pathname + u.search;
  if (!linkedFrom.has(path)) linkedFrom.set(path, from);
  return path;
}

console.log(`Crawling ${BASE} as ${user.name}\n`);

while (queue.length) {
  const path = queue.shift();
  if (seen.has(path)) continue;

  const res = await fetch(BASE + path, {
    headers: { cookie },
    redirect: "manual",
  });
  seen.set(path, res.status);

  // Redirects are legitimate here — access control sends people to /apps.
  if (res.status >= 300 && res.status < 400) continue;
  if (res.status !== 200) continue;

  const html = await res.text();
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const next = normalise(m[1], path);
    if (next && !seen.has(next)) queue.push(next);
  }
}

await sql`delete from sessions where id = ${sid}`;
await sql.end();

const broken = [...seen.entries()].filter(([, s]) => s === 404 || s >= 500);
const ok = [...seen.entries()].filter(([, s]) => s === 200);
const redirects = [...seen.entries()].filter(([, s]) => s >= 300 && s < 400);

for (const [path, status] of [...seen.entries()].sort()) {
  const mark = status === 200 ? "\x1b[32m✓\x1b[0m" : status < 400 ? "\x1b[33m→\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${mark} ${status}  ${path}`);
}

console.log(
  `\n${ok.length} ok · ${redirects.length} redirect · \x1b[${broken.length ? 31 : 32}m${broken.length} broken\x1b[0m`,
);

if (broken.length) {
  console.log("\nBroken links:");
  for (const [path, status] of broken) {
    console.log(`  ${status}  ${path}\n        linked from ${linkedFrom.get(path) ?? "(entry point)"}`);
  }
  process.exit(1);
}
