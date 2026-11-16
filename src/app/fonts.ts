import { Geist, Google_Sans_Flex, IBM_Plex_Mono, Noto_Sans_Devanagari, Source_Serif_4 } from "next/font/google";

/**
 * EVERY TYPEFACE MAHEKONE USES, SERVED BY MAHEKONE.
 *
 * They used to be `<link>`s to fonts.googleapis.com — one in the root layout and
 * one more in each app's layout. A stylesheet in the head holds the page until
 * it arrives, and that one could not even be asked for until the browser had
 * looked up and opened a connection to Google, then a second one to
 * fonts.gstatic.com for the font files it named. On the first page of the day,
 * on an office connection, that was a few hundred milliseconds of blank screen
 * before MahekOne's own response mattered at all, and the stylesheet itself is
 * only cached by Google for a day.
 *
 * `next/font` downloads the same files from Google AT BUILD TIME and serves them
 * from `/_next/static/media/`: same origin as the page, fingerprinted, cached for
 * a year (Caddyfile, `@immutable`), and kept offline by the factory phone's
 * service worker along with every other static file. The CSS is inlined into
 * the page, so nothing waits on another server. It also adds a size-matched
 * system fallback, so text does not jump when the real font lands.
 *
 * Each face is a CSS VARIABLE on `<html>` (root layout), and every stylesheet
 * names the variable rather than the family — `next/font` gives each family a
 * generated name, so the literal "Google Sans Flex" no longer matches anything.
 * Write `var(--font-google-sans)` (or `--font-geist`, `--font-plex-mono`,
 * `--font-source-serif`, `--font-noto-devanagari`), never the family's name.
 *
 * ONLY THE TWO TEXT FACES ARE PRELOADED. Google Sans Flex is the default face
 * and Geist the v4 apps'; preloading the mono, the serif and Devanagari on every
 * page would download files most pages never draw. Those three still load the
 * moment something on the page uses them.
 *
 * The build needs to reach fonts.googleapis.com. GitHub's runners can; a build
 * somewhere that cannot fails at this file and says so.
 */

/** The default face: every screen outside the v4 look, and the factory phone. */
export const googleSans = Google_Sans_Flex({
  subsets: ["latin", "latin-ext"],
  axes: ["opsz"],
  display: "swap",
  variable: "--font-google-sans",
  /* Next has no metrics for this face yet, so it cannot size a fallback to
     match and says so on every build. The system faces stand in instead, as
     they did when the font came from Google. */
  adjustFontFallback: false,
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
});

/** The v4 look (styles/v4-theme.css): ERP, CRM, Sales, HRMS, Tasks, Locker, Studio. */
export const geist = Geist({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-geist",
});

/** Figures, codes and lot numbers. 600 is the factory's lot codes. */
export const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  display: "swap",
  preload: false,
  variable: "--font-plex-mono",
});

/** Quoted evidence (`--font-evidence` in globals.css). */
export const sourceSerif = Source_Serif_4({
  subsets: ["latin", "latin-ext"],
  axes: ["opsz"],
  weight: "variable",
  display: "swap",
  preload: false,
  variable: "--font-source-serif",
});

/** Hindi and Marathi on the factory phone. */
export const notoDevanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari", "latin"],
  display: "swap",
  preload: false,
  variable: "--font-noto-devanagari",
});

/** The class that puts every variable above on `<html>`. */
export const fontVariables = [googleSans, geist, plexMono, sourceSerif, notoDevanagari]
  .map((f) => f.variable)
  .join(" ");
