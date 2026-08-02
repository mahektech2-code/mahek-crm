#!/usr/bin/env node
/**
 * Gets a developer from "cloned the repo" to "app runs" without them needing
 * credentials to anybody's cloud account.
 *
 *   npm run db:setup
 *
 * Creates .env.local if missing, makes the role and database if they are not
 * there, applies migrations, and seeds demo data. Safe to run repeatedly.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { platform } from "node:os";

const LOCAL_URL = "postgresql://mahek:mahek@127.0.0.1:5432/mahekone";

const say = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);

function die(message, hint) {
  console.error(`\n\x1b[31m✗ ${message}\x1b[0m`);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------ 1. env file */

say("1. Environment");
if (!existsSync(".env.local")) {
  copyFileSync(".env.example", ".env.local");
  ok("created .env.local from .env.example");
} else {
  ok(".env.local already exists — leaving it alone");
}

const env = readFileSync(".env.local", "utf8");
const url = /^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m.exec(env)?.[1];
if (!url) die("No DATABASE_URL in .env.local", "Copy .env.example over it and try again.");

const isLocal = /localhost|127\.0\.0\.1/.test(url);
if (!isLocal) {
  warn("DATABASE_URL is not local — this script only sets up local Postgres.");
  warn("Seeding a shared database would wipe it, so stopping here.");
  process.exit(0);
}
ok(`using ${url.replace(/:[^:@]+@/, ":****@")}`);

/* ------------------------------------------------- 2. find the psql binary */

say("2. Postgres");
function psqlPath() {
  try {
    return execSync("command -v psql", { encoding: "utf8" }).trim();
  } catch {
    /* not on PATH — look where Homebrew puts it */
  }
  for (const v of ["17", "16", "15", "14"]) {
    for (const prefix of ["/opt/homebrew", "/usr/local"]) {
      const p = `${prefix}/opt/postgresql@${v}/bin/psql`;
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const psql = psqlPath();
if (!psql) {
  die(
    "Postgres is not installed",
    platform() === "darwin"
      ? "  macOS:\n    brew install postgresql@16\n    brew services start postgresql@16\n\n  Or with Docker:\n    docker run -d --name mahek-db -p 5432:5432 \\\n      -e POSTGRES_USER=mahek -e POSTGRES_PASSWORD=mahek \\\n      -e POSTGRES_DB=mahekone postgres:16"
      : "  Ubuntu/Debian:\n    sudo apt install postgresql\n    sudo service postgresql start\n\n  Or with Docker:\n    docker run -d --name mahek-db -p 5432:5432 \\\n      -e POSTGRES_USER=mahek -e POSTGRES_PASSWORD=mahek \\\n      -e POSTGRES_DB=mahekone postgres:16",
  );
}
ok(`found ${psql}`);

const q = (db, sql) =>
  execFileSync(psql, ["-d", db, "-tAc", sql], { encoding: "utf8" }).trim();

let serverUp = false;
try {
  q("postgres", "select 1");
  serverUp = true;
} catch {
  /* handled below */
}
if (!serverUp) {
  die(
    "Postgres is installed but not accepting connections on port 5432",
    platform() === "darwin"
      ? "  brew services start postgresql@16"
      : "  sudo service postgresql start",
  );
}
ok("server is up on 5432");

/* --------------------------------------------- 3. role and database */

say("3. Role and database");
try {
  if (q("postgres", "select 1 from pg_roles where rolname='mahek'") !== "1") {
    q("postgres", "create role mahek with login password 'mahek' createdb");
    ok("created role mahek");
  } else ok("role mahek already there");

  if (q("postgres", "select 1 from pg_database where datname='mahekone'") !== "1") {
    q("postgres", "create database mahekone owner mahek");
    ok("created database mahekone");
  } else ok("database mahekone already there");
} catch (error) {
  die(
    "Could not create the role or database",
    `  ${String(error.message).split("\n")[0]}\n\n  You may need a superuser, e.g.:\n    psql -U postgres -c "create role mahek with login password 'mahek' createdb"`,
  );
}

/* ----------------------------------------------------- 4. schema and data */

say("4. Schema");
execSync("npx drizzle-kit migrate", { stdio: "inherit" });
ok("migrations applied");

say("5. Demo data");
execSync("npm run db:seed", { stdio: "inherit" });

console.log("\n\x1b[32m\x1b[1mReady.\x1b[0m  Start the app with:  npm run dev\n");
