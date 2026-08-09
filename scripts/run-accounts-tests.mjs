/**
 * The Accounts suite on its own, for when that is the app being worked on.
 * `npm run test:integration` runs it alongside the journeys; this is the
 * shorter loop. Same rule: mahekone_test, never the developer's database.
 */
import { execFileSync } from "node:child_process";

process.env.NODE_ENV = "test";

const dev = process.env.DATABASE_URL;
if (!dev) {
  console.error("DATABASE_URL is not set — copy .env.example to .env.local first.");
  process.exit(1);
}
const testUrl = dev.replace(/\/[^/?]+(\?|$)/, "/mahekone_test$1");

try {
  execFileSync(
    "npx",
    ["tsx", "--conditions=react-server", "--test", "src/lib/accounts.test.ts"],
    { stdio: "inherit", env: { ...process.env, NODE_ENV: "test", DATABASE_URL: testUrl } },
  );
} catch {
  process.exit(1);
}
