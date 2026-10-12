/**
 * The two phone apps MahekOne hands out, each on a page of its own:
 * /download/mbos and /download/factory. A link sent to one team lands on that
 * team's app and nothing else; /download is only the fork between the two.
 *
 * The APKs are plain files under /downloads on the droplet (the Caddyfile's
 * /downloads handle_path), at fixed names, so a release replaces the file and
 * this page's link never changes. They are never built into the app image: a
 * 90+ MB binary there would bloat every layer. The release workflows
 * (.github/workflows/mbos-apk.yml and factory-apk.yml) put a small
 * `<name>.json` beside each APK carrying the version, which the page reads.
 */

export type DownloadAppId = "mbos" | "factory";

export type DownloadApp = {
  id: DownloadAppId;
  name: string;
  /** Who it is for, in two words, for the fork on /download. */
  team: string;
  /** One line under the name. */
  tagline: string;
  /** The headline on the brand panel. */
  headline: string;
  /** What the app does, a few lines a person can scan. */
  features: string[];
  /** Who should install it. */
  who: string;
  /** How you get in, once it is installed. */
  signIn: { title: string; body: string }[];
  /** Who gives you access when sign-in refuses you. */
  access: string;
  /** What to expect the first time it opens. */
  firstRun: string;
  apk: string;
  /**
   * The same app built for 32-bit Android — the cheap "Android Go" phones the
   * main APK will not install on ("App not installed"). Only MBOS has one.
   */
  apk32?: string;
  manifest: string;
  /** Said under the button: the warning every sideloaded APK raises. */
  note: string;
};

const PLAY_STORE_NOTE =
  "Your phone will say the app is from outside the Play Store. That is expected for a company app — allow it once and install.";

export const DOWNLOAD_APPS: Record<DownloadAppId, DownloadApp> = {
  mbos: {
    id: "mbos",
    name: "MBOS",
    team: "Field sales",
    tagline: "The field sales app",
    headline: "Your day in the field, recorded where it happens",
    features: [
      "Punch in, follow your journey and check in at each shop",
      "Take orders and collect payments at the counter",
      "Raise leads, samples and complaints on the spot",
      "Works with no signal — everything sends when you are back online",
    ],
    who: "Field salesmen, and the sales managers who work beats with them.",
    signIn: [
      {
        title: "Your mobile number",
        body: "The work number on your MahekOne account, or the personal mobile HR has for you.",
      },
      {
        title: "Your MahekOne password",
        body: "The same password as the website. Or sign in with a one-time code sent to your phone instead.",
      },
    ],
    access:
      "If it says you have no access, ask your manager to give you the Salesman App on MahekOne. Your manager also has to set the area you work, or your customer list stays empty.",
    firstRun:
      "The first time it opens it asks for location (choose “Allow all the time”), camera, microphone and notifications, and to turn off battery saving for MBOS. Say yes to each — your day cannot be recorded without them.",
    apk: "/downloads/mbos.apk",
    apk32: "/downloads/mbos-32bit.apk",
    manifest: "/downloads/mbos.json",
    note: `${PLAY_STORE_NOTE} Already installed? Download again to update — nothing to uninstall, nothing lost.`,
  },
  factory: {
    id: "factory",
    name: "Mahek Factory",
    team: "Factory floor",
    tagline: "The factory floor app",
    headline: "Scan the job, do the work, send the count",
    features: [
      "Scan a job or a lot label and see exactly what to do",
      "Mixing, filling, packing and loading, step by step",
      "Record what was made and why a machine stopped",
      "Keeps working when the Wi-Fi drops — work waits and sends itself",
    ],
    who: "The mixing, filling, packing and dispatch teams, their supervisors, and the Production Head.",
    signIn: [
      {
        title: "Your mobile number",
        body: "The number your supervisor gave the office for you.",
      },
      {
        title: "Your 4-digit PIN",
        body: "You set it the first time you sign in. Forgot it? Tap “Forgot PIN?”, enter the SMS code and choose a new one.",
      },
    ],
    access:
      "If it says you have no access, ask your supervisor or the Production Head. The office has to add you to the Factory app and put you in your department first.",
    firstRun:
      "The first time it opens it asks for the camera, to scan labels. Allow it.",
    apk: "/downloads/factory.apk",
    manifest: "/downloads/factory.json",
    note: `${PLAY_STORE_NOTE} Already installed? Download again to update — work waiting to send is kept.`,
  },
};

export const DOWNLOAD_APP_IDS = Object.keys(DOWNLOAD_APPS) as DownloadAppId[];

/** Old links carried `?team=sales` or `?team=erp`; this is where each went. */
export const LEGACY_TEAMS: Record<string, DownloadAppId> = {
  sales: "mbos",
  erp: "factory",
  factory: "factory",
  mbos: "mbos",
};

export const downloadHref = (id: DownloadAppId) => `/download/${id}`;
