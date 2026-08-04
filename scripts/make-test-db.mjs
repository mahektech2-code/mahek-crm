/**
 * Creates (or recreates) the integration-test database and applies migrations.
 * Kept separate from the developer database so a test run can never wipe the
 * data somebody is looking at.
 */
import postgres from "postgres";
import { execFileSync } from "node:child_process";

const dev = process.env.DATABASE_URL;
if (!dev) throw new Error("DATABASE_URL is not set.");
const testUrl = dev.replace(/\/[^/?]+(\?|$)/, "/mahekone_test$1");
const adminUrl = dev.replace(/\/[^/?]+(\?|$)/, "/postgres$1");

const sql = postgres(adminUrl, { max: 1 });
await sql`drop database if exists mahekone_test`;
await sql`create database mahekone_test`;
await sql.end();

execFileSync("npx", ["drizzle-kit", "migrate"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testUrl },
});

console.log(`\nmahekone_test ready`);
