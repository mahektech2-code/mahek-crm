import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE PREFS FILE IS NAMED IN TWO PLACES AND JOINED ONLY BY A SPELLING.
 *
 * `FixStore` writes the recorder's mirrored credential — the base URL, the
 * device id, and the access and refresh JWTs, in plain text — into an
 * app-private preferences file, because the service cannot read
 * `expo-secure-store`. `plugins/withCredentialBackupRules.js` keeps that file
 * out of Android's cloud backup and out of a device-to-device transfer by
 * naming it.
 *
 * GETTING THE NAME WRONG FAILS SILENTLY, which is the whole reason this test
 * exists. An `<exclude>` naming a file that does not exist excludes nothing;
 * aapt is happy, the build is valid, the plugin runs, and the token goes to
 * Google's backup anyway. Nothing anywhere would say so. It is the same shape
 * as `mbos-wire.test.ts` — two files a compiler cannot join, pinned by reading
 * both as text — and it is the only check available, because one of them is
 * Kotlin this machine cannot compile and the other is a string.
 */

const here = join(__dirname, '..', '..');
const fixStore = readFileSync(
  join(
    here,
    'modules/location-service/android/src/main/java/expo/modules/locationservice/FixStore.kt',
  ),
  'utf8',
);
const plugin = readFileSync(join(here, 'plugins/withCredentialBackupRules.js'), 'utf8');
const appJson = readFileSync(join(here, 'app.json'), 'utf8');

test('the backup exclusion names the preferences file the recorder actually writes', () => {
  const declared = /const val PREFS = "([^"]+)"/.exec(fixStore);
  assert.ok(declared, 'FixStore must still declare its preferences file name');
  /* Android writes `getSharedPreferences("X", …)` to `shared_prefs/X.xml`, and
     the exclusion has to name the file on disk rather than the key. */
  const onDisk = `${declared[1]}.xml`;

  const excluded = /const PREFS_FILE = '([^']+)'/.exec(plugin);
  assert.ok(excluded, 'the plugin must still name a preferences file');
  assert.equal(excluded[1], onDisk);
});

test('both mechanisms are covered, and the device transfer is not forgotten', () => {
  /* `fullBackupContent` is what Android 11 and below read; `dataExtractionRules`
     is what 12 and above read, and it reads BOTH of its sections. A rule
     written only under `<cloud-backup>` leaves a device-to-device transfer
     copying everything — and that is the copy that lands on a second working
     phone. */
  assert.match(plugin, /android:fullBackupContent/);
  assert.match(plugin, /android:dataExtractionRules/);
  assert.match(plugin, /<cloud-backup>/);
  assert.match(plugin, /<device-transfer>/);
});

test('the plugin is registered, or it does nothing at all', () => {
  /* `android/` is gitignored and rebuilt by `expo prebuild` on every release,
     so a plugin that is not in this list is a file nothing ever runs. */
  assert.match(appJson, /\.\/plugins\/withCredentialBackupRules\.js/);
});

test('nothing here turns backup off for the whole app', () => {
  /* Whether a salesman's replacement phone gets his unsent day back is a
     decision about the product with a real cost either way, and it is not this
     plugin's to make as a side effect of a credential concern. If Mahek does
     want it, `android.allowBackup: false` in app.json is the one line — and
     this test is what should be read and deleted when somebody adds it. */
  /* The plugin ARGUES about `allowBackup` at length and must not SET it, so
     what is checked is an ASSIGNMENT onto the manifest's application element
     rather than the word — which appears in the argument and should. */
  assert.ok(!/\$\[['"]android:allowBackup/.test(plugin));
  assert.ok(!/"allowBackup"/.test(appJson));
});
