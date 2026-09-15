import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Application from 'expo-application';
import { getKv, setKv } from '../db';
import { oemOf, type Oem } from '../engines/oem-keepalive';

/**
 * OPENING THE SWITCHES THAT KEEP THE TRACKER ALIVE.
 *
 * The impure half of `engines/oem-keepalive.ts`. That file decides WHICH
 * steps a handset needs and what to say about them; this one fires the
 * intents, and it is deliberately the only place in the app that knows an
 * OEM package name.
 *
 * NOTHING HERE CAN BE TRUSTED TO EXIST. Every component named below is an
 * OEM's private activity, unversioned, renamed between releases and absent
 * entirely on some builds of the same brand. So every launch is a LADDER:
 * the exact screen, then the standard Android one, then the app's own
 * settings page, which exists on every Android ever made. A throw at one rung
 * falls to the next, and the words the engine prints are what carry him the
 * last step — because an app cannot tap Autostart for somebody.
 *
 * NOTHING HERE EVER THROWS AT THE CALLER. This is offered from a screen a
 * salesman opened to fix a problem; a crash there is the one outcome worse
 * than the tracker being asleep.
 */

/** Where the "we have walked him through this" mark lives. */
const ASKED_KEY = 'keepalive.askedAt';

/** The manufacturer, as this app's engine buckets it. */
export function thisOem(): Oem {
  return oemOf(Device.manufacturer);
}

/** When the setup was last put in front of him, or null. */
export async function lastAskedAt(): Promise<number | null> {
  const raw = await getKv(ASKED_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function markAsked(at = Date.now()): Promise<void> {
  await setKv(ASKED_KEY, String(at));
}

async function launch(action: string, params: Record<string, unknown> = {}): Promise<boolean> {
  try {
    await IntentLauncher.startActivityAsync(action, params);
    return true;
  } catch {
    return false;
  }
}

/**
 * The battery exemption — the one step Android itself will grant.
 *
 * `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is a one-tap system dialog and needs
 * the permission of the same name, which `app.json` declares. It is
 * restricted on Google Play; this app is sideloaded and has never been on
 * Play, so that policy does not reach it — worth writing down, because it is
 * the reason most Android advice says not to use this intent.
 *
 * The fallback is the SETTINGS LIST rather than nothing: it takes three taps
 * instead of one and it is always there.
 */
export async function requestBatteryExemption(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const pkg = Application.applicationId ?? 'in.mahek.mbos';
  await markAsked();

  if (await launch('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', { data: `package:${pkg}` })) {
    return true;
  }
  if (await launch('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS')) return true;
  return openAppSettings();
}

/**
 * The OEM's own autostart list.
 *
 * Every one of these is a private activity and every one of them has moved at
 * least once. They are tried in order and the standard app-settings page
 * catches whatever is left — see the ladder in this file's header.
 */
const AUTOSTART_COMPONENTS: Record<Oem, { packageName: string; className: string }[]> = {
  xiaomi: [
    { packageName: 'com.miui.securitycenter', className: 'com.miui.permcenter.autostart.AutoStartManagementActivity' },
  ],
  oppo: [
    { packageName: 'com.coloros.safecenter', className: 'com.coloros.safecenter.permission.startup.StartupAppListActivity' },
    { packageName: 'com.coloros.safecenter', className: 'com.coloros.safecenter.startupapp.StartupAppListActivity' },
    { packageName: 'com.oppo.safe', className: 'com.oppo.safe.permission.startup.StartupAppListActivity' },
  ],
  realme: [
    { packageName: 'com.coloros.safecenter', className: 'com.coloros.safecenter.permission.startup.StartupAppListActivity' },
    { packageName: 'com.coloros.safecenter', className: 'com.coloros.safecenter.startupapp.StartupAppListActivity' },
  ],
  oneplus: [
    { packageName: 'com.oneplus.security', className: 'com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity' },
  ],
  vivo: [
    { packageName: 'com.vivo.permissionmanager', className: 'com.vivo.permissionmanager.activity.BgStartUpManagerActivity' },
    { packageName: 'com.iqoo.secure', className: 'com.iqoo.secure.ui.phoneoptimize.BgStartUpManager' },
  ],
  samsung: [
    { packageName: 'com.samsung.android.lool', className: 'com.samsung.android.sm.battery.ui.BatteryActivity' },
  ],
  other: [],
};

export async function openAutostartSettings(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  await markAsked();
  for (const component of AUTOSTART_COMPONENTS[thisOem()]) {
    /* `MAIN` with an explicit component is how a private activity is opened;
       the action alone reaches nothing, because none of these is registered
       against a public one. */
    if (await launch('android.intent.action.MAIN', component)) return true;
  }
  return openAppSettings();
}

/**
 * The floor, and the only screen guaranteed to exist.
 *
 * Battery and background permissions are both reachable from here on every
 * Android, which is what makes it a safe last rung rather than a dead end.
 */
export async function openAppSettings(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const pkg = Application.applicationId ?? 'in.mahek.mbos';
  return launch('android.settings.APPLICATION_DETAILS_SETTINGS', { data: `package:${pkg}` });
}
