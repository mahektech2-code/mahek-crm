/**
 * The level planner's deploy step, run by every deploy (`npm run deploy:db`):
 * raw-material re-order levels planned from history so each godown holds a
 * week and a half of stock. Once a day — a second deploy the same day finds
 * the levels already planned and changes nothing.
 *
 * It NEVER fails a deploy: a planner that cannot run (no history yet, the
 * model down) leaves yesterday's levels standing, which is what tomorrow's
 * nightly pass would find anyway.
 */
import { runLevelPlanner, plannerLine } from "../src/lib/erp/level-planner";

runLevelPlanner({})
  .then((r) => {
    console.log(`ERP levels: ${plannerLine(r)}.`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(`ERP levels: not planned this deploy — ${e instanceof Error ? e.message : e}`);
    process.exit(0);
  });
