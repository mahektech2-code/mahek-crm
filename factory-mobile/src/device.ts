import { Dimensions, PixelRatio, Platform } from "react-native";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import NetInfo from "@react-native-community/netinfo";
import { Camera } from "expo-camera";
import type { FactoryDeviceReport } from "@/lib/factory/types";
import { APP_BUILD } from "./api";
import { kvGet, kvSet, type QItem } from "./model";

/**
 * WHAT THIS PHONE SAYS ABOUT ITSELF, for the Admin Console's Factory handsets
 * page: the APK and over-the-air update it runs, the handset, its network,
 * the work still waiting here and whether the camera is allowed.
 *
 * Everything is read from modules every APK since 2.1.1 already carries, so
 * this reaches phones over the air. NOTHING HERE THROWS: a reading that fails
 * is left out, and the report goes with what could be read.
 */

const DEVICE_KEY = "device.id";

/** Minted once and kept for the life of the install — the row this phone is on the console. */
export function deviceId(): string {
  const had = kvGet(DEVICE_KEY);
  if (had) return had;
  const id = "FD-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  kvSet(DEVICE_KEY, id);
  return id;
}

const safe = <T,>(f: () => T): T | null => {
  try {
    return f() ?? null;
  } catch {
    return null;
  }
};

export async function deviceReport(queue: QItem[], lang: string | null): Promise<FactoryDeviceReport> {
  const c = (Platform.constants ?? {}) as { Brand?: string; Manufacturer?: string; Model?: string; Release?: string };
  const [net, cam] = await Promise.all([
    NetInfo.fetch().catch(() => null),
    Camera.getCameraPermissionsAsync().catch(() => null),
  ]);
  const waiting = queue.filter((q) => q.status === "pending");
  const oldest = waiting.map((q) => q.at).filter(Boolean).sort()[0] ?? null;
  const win = safe(() => Dimensions.get("window"));
  const created = safe(() => Updates.createdAt);
  return {
    deviceId: deviceId(),
    sentAt: new Date().toISOString(),
    appVersion: Constants.expoConfig?.version ?? null,
    appBuild: APP_BUILD,
    updateId: safe(() => Updates.updateId),
    updateCreatedAt: created ? created.toISOString() : null,
    runtime: safe(() => Updates.runtimeVersion),
    channel: safe(() => Updates.channel),
    embedded: safe(() => Updates.isEmbeddedLaunch),
    os: Platform.OS,
    osVersion: c.Release ?? String(Platform.Version ?? ""),
    apiLevel: Platform.OS === "android" && typeof Platform.Version === "number" ? Platform.Version : null,
    brand: c.Brand ?? null,
    manufacturer: c.Manufacturer ?? null,
    model: c.Model ?? null,
    network: net ? String(net.type) + ((net.details as { cellularGeneration?: string } | null)?.cellularGeneration ? " " + (net.details as { cellularGeneration?: string }).cellularGeneration : "") : null,
    internet: net ? net.isInternetReachable ?? net.isConnected ?? null : null,
    queuePending: waiting.length,
    queueHeld: queue.filter((q) => q.status === "held" || q.status === "failed").length,
    queueOldestAt: oldest,
    camera: cam ? String(cam.status) : null,
    screen: win ? `${Math.round(win.width)}x${Math.round(win.height)}` : null,
    fontScale: safe(() => PixelRatio.getFontScale()),
    lang,
  };
}
