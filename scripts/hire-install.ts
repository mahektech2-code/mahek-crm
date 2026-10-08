/**
 * Hire's install step, run by every deploy (`npm run deploy:db`):
 * the seeded role blueprints that are missing, and Hire for every platform
 * administrator who lacks it. Idempotent — a second run changes nothing.
 */
import { installHire } from "../src/lib/hire/install";

installHire()
  .then((r) => {
    console.log(`Hire: ${r.blueprints.length ? `blueprints added — ${r.blueprints.join(", ")}` : "blueprints already in place"}; ${r.admins.length ? `Hire granted to ${r.admins.join(", ")}` : "every platform administrator already holds Hire"}.`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
