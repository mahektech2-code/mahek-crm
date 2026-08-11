/* ---------------------------------------------------------------------------
 * The half-hourly trigger, living beside the sheet it reads.
 *
 * WHY NOT GITHUB ACTIONS: `schedule:` is best-effort, and on a PRIVATE repo
 * belonging to a free account it is the lowest priority tier there is. GitHub
 * does not queue a tick it cannot serve — it drops it. Measured on this repo,
 * an every-thirty-minutes cron delivered three runs in eleven hours: gaps of
 * 2h01, 4h48 and 4h07 against a promised thirty, roughly one tick in ten.
 * Nothing was failing; the runs that landed were green and took two minutes.
 * The workflow is kept as the manual "sync now" button and as a safety net,
 * but it cannot be what keeps the CRM current.
 *
 * WHY HERE: an Apps Script time-driven trigger is free, is not best-effort,
 * and belongs to the workbook the team is already typing into — the schedule
 * lives with the thing it reads rather than in a third account somebody has
 * to remember exists. It also survives the repo: renaming a branch, moving
 * the deployment or exhausting Actions minutes does not stop it.
 *
 * WHY ONE SCRIPT AND NOT FIVE CRON ENTRIES: the modes are ordered. The read
 * passes land rows in the staging tables and `project` turns what has landed
 * into customers, orders and bills, so projecting first publishes the previous
 * cycle's data and calls it fresh. Five independent schedulers cannot promise
 * that order; one caller doing them in sequence can.
 *
 * ---------------------------------------------------------------------------
 * SETTING IT UP — once, about five minutes
 *
 *   1. Open the order workbook → Extensions → Apps Script.
 *   2. Paste this file over Code.gs. Save.
 *   3. Project Settings → Script Properties → add three:
 *
 *        SYNC_URL           https://<your-deployment>/api/sheets/sync
 *        CRON_SECRET        the same value the deployment holds
 *        SYNC_OWNER_EMAIL   who imported customers answer to
 *
 *      The same three the GitHub workflow takes. CRON_SECRET is a script
 *      property rather than a literal in this file so that sharing the script
 *      with somebody does not hand them the key to the order book.
 *   4. Run `install` once. Google will ask for permission to fetch external
 *      URLs — that is this script calling your deployment, and nothing else.
 *   5. Run `syncNow` once to confirm it works, then read the log.
 *
 * `install` is idempotent: it clears its own triggers before making a new one,
 * so running it twice leaves one trigger rather than two.
 * ------------------------------------------------------------------------- */

/** Read passes, in order. Each lands rows in the staging tables. */
var READ_MODES = ['append', 'taken', 'payments', 'parties'];

/** Minutes between runs. Apps Script accepts 1, 5, 10, 15 or 30 — nothing else. */
var EVERY_MINUTES = 30;

/*
 * Apps Script kills an execution at six minutes on a consumer account (thirty
 * on Workspace), and a kill lands mid-chain with no log line saying so. So no
 * new mode is STARTED past this point — the ones already done keep their work,
 * and the rest wait for the next tick half an hour later rather than the run
 * being cut somewhere nobody can see. Every mode is idempotent and every read
 * is hash-compared, so a deferred pass costs a read and no writes.
 */
var BUDGET_MS = 4.5 * 60 * 1000;

/** The trigger's entry point. Also safe to run by hand. */
function syncCycle() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SYNC_URL');
  var secret = props.getProperty('CRON_SECRET');
  var owner = props.getProperty('SYNC_OWNER_EMAIL');

  if (!url || !secret) {
    // Thrown rather than logged: a failed execution mails the owner, and a
    // scheduler that has quietly done nothing for a week is the failure this
    // whole file exists to stop happening again.
    throw new Error('SYNC_URL or CRON_SECRET is not set. See Project Settings → Script Properties.');
  }

  var started = Date.now();
  var ran = [];
  var deferred = [];

  for (var i = 0; i < READ_MODES.length; i++) {
    if (Date.now() - started > BUDGET_MS) {
      deferred = READ_MODES.slice(i);
      break;
    }
    sync_(url, secret, READ_MODES[i]);
    ran.push(READ_MODES[i]);
  }

  /*
   * The projection needs an owner: nothing in the sheet says who works an
   * account, and a customer in nobody's book appears on no list for anybody.
   * Skipped rather than guessed if it is unset — and skipped too if the reads
   * ran out of budget, because projecting a half-landed cycle publishes it as
   * though it were whole.
   */
  if (deferred.length) {
    deferred.push('project');
  } else if (!owner) {
    Logger.log('WARNING: SYNC_OWNER_EMAIL unset, so nothing was projected. Staged rows are waiting.');
  } else if (Date.now() - started > BUDGET_MS) {
    deferred.push('project');
  } else {
    sync_(url, secret, 'project&owner=' + encodeURIComponent(owner));
    ran.push('project');
  }

  Logger.log('ran: ' + (ran.join(', ') || 'nothing')
    + (deferred.length ? ' | deferred to the next tick: ' + deferred.join(', ') : ''));
}

/** One mode. Throws on a real failure; returns quietly on 409. */
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
     * lost. So this is logged and the cycle carries on rather than throwing:
     * treating a slow-but-successful sync as a failure would mail somebody
     * every time an unusually large batch landed. The job row on the server
     * carries the real outcome, and the next tick's 409 guard stops a second
     * pass climbing on top of one still running.
     */
    Logger.log(mode + ': no answer within the fetch timeout — the server is still running it. ' + e);
    return;
  }

  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code === 200) {
    Logger.log(mode + ': ok ' + body);
    return;
  }
  if (code === 409) {
    // Already running. Two overlapping calls are the ordinary result of a slow
    // run and a fixed interval; the right response is to leave the first alone.
    Logger.log(mode + ': skipped, a run was already in progress');
    return;
  }
  throw new Error(mode + ' failed with HTTP ' + code + ': ' + body);
}

/** Create the schedule. Idempotent — clears its own triggers first. */
function install() {
  uninstall();
  ScriptApp.newTrigger('syncCycle').timeBased().everyMinutes(EVERY_MINUTES).create();
  Logger.log('installed: syncCycle every ' + EVERY_MINUTES + ' minutes');
}

/** Remove the schedule. Leaves any other trigger in the project alone. */
function uninstall() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncCycle') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('removed ' + removed + ' trigger(s)');
}

/** Run the whole cycle now, by hand, and read the log. */
function syncNow() {
  syncCycle();
}
