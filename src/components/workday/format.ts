import { clock } from "@/lib/format";
import { APP_TIMEZONE } from "@/lib/business-date";

/* The workday's own spellings, shared by the chip, the lock and the card. */

/** 9:28 am */
export const at = (ms: number | null | undefined) => (ms ? clock(new Date(ms)) : "—");

/** 3:42 — hours and minutes. */
export function hmOf(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** 3:42:07 */
export function hmsOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 12:40 — minutes and seconds, for a break or a countdown. */
export function msOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "3 h 42 m" */
export function longDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} m` : `${m} m`;
}

export const OFF_DAY_WORDS: Record<string, string> = {
  week_off: "your week off",
  holiday: "a holiday",
  leave: "a day of leave",
};

export const VERDICT_WORDS: Record<string, { label: string; tone: "success" | "warn" | "danger" | "brand" | "muted" }> = {
  present: { label: "Present", tone: "success" },
  half_day: { label: "Half day", tone: "warn" },
  absent: { label: "Absent", tone: "danger" },
  extra: { label: "Extra work", tone: "brand" },
  working: { label: "Working", tone: "muted" },
};

/** Where the browser is, read once when a button is pressed. */
export function locate(): Promise<{ lat: number | null; lng: number | null; accuracy: number | null } | "denied"> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve({ lat: null, lng: null, accuracy: null });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => resolve(e.code === e.PERMISSION_DENIED ? "denied" : { lat: null, lng: null, accuracy: null }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

export function greeting(ms: number, name: string): string {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, hour: "numeric", hour12: false }).format(new Date(ms)),
  );
  return `Good ${h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"}, ${name.split(" ")[0]}`;
}
