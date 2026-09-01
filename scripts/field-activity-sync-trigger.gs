/* ---------------------------------------------------------------------------
 * The Activity tab's own trigger, living beside the workbook it reads.
 *
 * This is a DIFFERENT spreadsheet from the order book ("Mahek EMP 2.0 -
 * Performance", not the order workbook), so it cannot share
 * `sheet-sync-trigger.gs` — an Apps Script trigger belongs to the document
 * it is bound to. Same reasoning as that file for why this lives here and
 * not in GitHub Actions: a `schedule:` on a private repo's free-tier Actions
 * is best-effort and drops most of its ticks, where a time-driven trigger on
 * the workbook itself is not.
 *
 * TWO CADENCES, not one, because the tab is tens of thousands of rows and a
 * full hash-compare of all of them costs API quota an append pass (only
 * rows past the highest one already seen) never spends:
 *
 *   syncCycle       every 30 minutes — append, then project what matched
 *   reconcileCycle  once a day — the full compare, catching an edited or
 *                   withdrawn row an append pass cannot see, then project
 *
 * ---------------------------------------------------------------------------
 * SETTING IT UP — once, about five minutes
 *
 *   1. Open the "Mahek EMP 2.0 - Performance" workbook → Extensions → Apps
 *      Script.
 *   2. Paste this file over Code.gs. Save.
 *   3. Project Settings → Script Properties → add two:
 *
 *        SYNC_URL      https://<your-deployment>/api/sheets/sync
 *        CRON_SECRET   the same value the deployment holds
 *
 *      No SYNC_OWNER_EMAIL here — unlike the order sheet, nothing this reads
 *      is projected into a customer or order somebody has to own; a matched
 *      row already names the salesman and the customer it resolved to.
 *   4. Run `install` once. Google will ask for permission to fetch external
 *      URLs — that is this script calling your deployment, and nothing else.
 *   5. Run `syncNow` once to confirm it works, then read the log.
 *
 * `install` is idempotent: it clears its own triggers before making new
 * ones, so running it twice leaves one of each rather than two.
 * ------------------------------------------------------------------------- */

/** Minutes between append runs. Apps Script accepts 1, 5, 10, 15 or 30. */
var EVERY_MINUTES = 30;

/** Hour of day (0-23, script's own timezone) the full reconcile runs. */
var RECONCILE_HOUR = 2;

/** The append trigger's entry point. Also safe to run by hand. */
function syncCycle() {
  runCycle_('field-activity');
}

/** The reconcile trigger's entry point. Also safe to run by hand. */
function reconcileCycle() {
  runCycle_('field-activity-reconcile');
}

function runCycle_(readMode) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SYNC_URL');
  var secret = props.getProperty('CRON_SECRET');

  if (!url || !secret) {
    // Thrown rather than logged: a failed execution mails the owner, and a
    // scheduler that has quietly done nothing for a week is the failure this
    // whole file exists to stop happening again.
    throw new Error('SYNC_URL or CRON_SECRET is not set. See Project Settings → Script Properties.');
  }

  var readOk = sync_(url, secret, readMode);
  // Projecting after a skipped or failed read would believe last cycle's
  // staged rows onto the timeline a second time; the natural-key
  // onConflictDoNothing on timeline_events makes that harmless, but there is
  // nothing to gain by doing it, so only project behind a read that ran.
  if (readOk) sync_(url, secret, 'field-activity-project');
}

/** One mode. Returns true on success; logs and returns false otherwise. */
function sync_(url, secret, mode) {
  var response;
  try {
    response = UrlFetchApp.fetch(url + '?mode=' + mode, {
      headers: { Authorization: 'Bearer ' + secret },
      muteHttpExceptions: true,
    });
  } catch (e) {
    /*
     * UrlFetchApp gives up waiting at about sixty seconds and there is no way
     * to raise it. That does NOT cancel the job — the request reached the
     * deployment and the server runs it to completion; only the answer is
     * lost. So this is logged rather than thrown: treating a slow-but-
     * successful sync as a failure would mail somebody every time an
     * unusually large batch landed.
     */
    Logger.log(mode + ': no answer within the fetch timeout — the server is still running it. ' + e);
    return false;
  }

  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code === 200) {
    Logger.log(mode + ': ok ' + body);
    return true;
  }
  if (code === 409) {
    // Already running. Two overlapping calls are the ordinary result of a
    // slow run and a fixed interval; the right response is to leave the
    // first one alone.
    Logger.log(mode + ': skipped, a run was already in progress');
    return false;
  }
  throw new Error(mode + ' failed with HTTP ' + code + ': ' + body);
}

/** Create both schedules. Idempotent — clears its own triggers first. */
function install() {
  uninstall();
  ScriptApp.newTrigger('syncCycle').timeBased().everyMinutes(EVERY_MINUTES).create();
  ScriptApp.newTrigger('reconcileCycle').timeBased().everyDays(1).atHour(RECONCILE_HOUR).create();
  Logger.log('installed: syncCycle every ' + EVERY_MINUTES + ' minutes, reconcileCycle daily at ' + RECONCILE_HOUR + ':00');
}

/** Remove both schedules. Leaves any other trigger in the project alone. */
function uninstall() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (fn === 'syncCycle' || fn === 'reconcileCycle') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('removed ' + removed + ' trigger(s)');
}

/** Run the append cycle now, by hand, and read the log. */
function syncNow() {
  syncCycle();
}
