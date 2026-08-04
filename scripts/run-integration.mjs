/**
 * Runs the journey tests against mahekone_test, never against the database the
 * developer is looking at. Node's test runner is invoked directly so there is
 * no test framework to install.
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
    ["tsx", "--conditions=react-server", "--test", "src/lib/journeys.test.ts"],
    { stdio: "inherit", env: { ...process.env, NODE_ENV: "test", DATABASE_URL: testUrl } },
  );
} catch {
  process.exit(1);
}
