/*
 * Builds src/lib/geography/india-towns.ts from the all-India city/town CSV.
 *   npx tsx scripts/build-india-towns.ts <all_india_towns_final_with_codes.csv>
 * Nothing is guessed: a district the app master does not name, and is not in
 * ALIASES below, stops the build. Rows with no district are kept as unresolved.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { readIndiaUlbCsv, parseCsv } from "../src/lib/geography/lgd-india-ulb";
import { INDIA_GEOGRAPHY } from "../src/lib/geography/india-districts";
import { canonicalState } from "../src/lib/india-states";
import { placeKey } from "../src/lib/place-parse";

/** state|file spelling|master spelling — renames and spellings of ONE district only. */
const ALIASES = new Map(
  `
Andaman and Nicobar Islands|South Andamans|South Andaman
Andhra Pradesh|Sri Potti Sriramulu Nellore|Nellore
Arunachal Pradesh|Dibang Valley|Upper Dibang Valley
Assam|Kamrup Metro|Kamrup Metropolitan
Assam|Marigaon|Morigaon
Assam|Sribhumi|Karimganj
Bihar|Kaimur (Bhabua)|Kaimur
Bihar|Pashchim Champaran|West Champaran
Bihar|Purbi Champaran|East Champaran
Chhattisgarh|Balodabazar-Bhatapara|Baloda Bazar
Chhattisgarh|Dakshin Bastar Dantewada|Dantewada
Chhattisgarh|Gariyaband|Gariaband
Chhattisgarh|Kabeerdham|Kabirdham
Chhattisgarh|Manendragarh-Chirmiri-Bharatpur(M C B)|Manendragarh-Chirmiri-Bharatpur
Chhattisgarh|Mohla-Manpur-Ambagarh Chouki|Mohla-Manpur-Ambagarh Chowki
Chhattisgarh|Uttar Bastar Kanker|Kanker
Gujarat|Arvalli|Aravalli
Gujarat|Chhotaudepur|Chhota Udaipur
Gujarat|Dangs|Dang
Gujarat|Kachchh|Kutch
Gujarat|Mahesana|Mehsana
Gujarat|Panch Mahals|Panchmahal
Jammu and Kashmir|Bandipora|Bandipore
Jharkhand|East Singhbum|East Singhbhum
Jharkhand|Hazaribagh|Hazaribag
Jharkhand|Sahebganj|Sahibganj
Jharkhand|Saraikela Kharsawan|Seraikela-Kharsawan
Karnataka|Bagalkote|Bagalkot
Karnataka|Bengaluru Rural|Bangalore Rural
Karnataka|Bengaluru Urban|Bangalore Urban
Karnataka|Chikkaballapura|Chikkaballapur
Karnataka|Chikkamagaluru|Chikmagalur
Karnataka|Gadag|Gadaga
Karnataka|Mysuru|Mysore
Karnataka|Shivamogga|Shimoga
Karnataka|Vijayapura|Bijapur
Ladakh|Leh Ladakh|Leh
Madhya Pradesh|Khandwa (East Nimar)|Khandwa
Madhya Pradesh|Khargone (West Nimar)|Khargone
Madhya Pradesh|Narmadapuram|Hoshangabad
Madhya Pradesh|Narsimhapur|Narsinghpur
Maharashtra|Ahilyanagar|Ahmednagar
Maharashtra|Chhatrapati Sambhajinagar|Aurangabad
Maharashtra|Dharashiv|Osmanabad
Maharashtra|Mumbai|Mumbai City
Mizoram|Siaha|Saiha
Nagaland|Chumoukedima|Chümoukedima
Nagaland|Tseminyu|Tseminyü
Odisha|Anugola|Angul
Odisha|Baleshwar|Balasore
Odisha|Baragada|Bargarh
Odisha|Debagada|Debagarh
Odisha|Jagatsinghapur|Jagatsinghpur
Odisha|Kandhamala|Kandhamal
Odisha|Kataka|Cuttack
Odisha|Kendrapada|Kendrapara
Odisha|Nayagada|Nayagarh
Odisha|Sundaragada|Sundargarh
Punjab|Ferozepur|Firozpur
Punjab|S.A.S Nagar|Sahibzada Ajit Singh Nagar
Rajasthan|Ganganagar|Sri Ganganagar
Tamil Nadu|Kancheepuram|Kanchipuram
Tamil Nadu|Kanniyakumari|Kanyakumari
Tamil Nadu|The Nilgiris|Nilgiris
Tamil Nadu|Thiruvallur|Tiruvallur
Tamil Nadu|Thiruvarur|Tiruvarur
Tamil Nadu|Thoothukkudi|Thoothukudi
Tamil Nadu|Tirupathur|Tirupattur
Telangana|Hanumakonda|Hanamkonda
Telangana|Jagitial|Jagtial
Telangana|Jangoan|Jangaon
Telangana|Jayashankar Bhupalapally|Jayashankar Bhupalpally
Telangana|Mahabubnagar|Mahbubnagar
Uttar Pradesh|Baghpat|Bagpat
Uttar Pradesh|Kheri|Lakhimpur Kheri
Uttar Pradesh|Mahrajganj|Maharajganj
Uttar Pradesh|Shrawasti|Shravasti
`
    .trim()
    .split("\n")
    .map((l) => {
      const [s, f, m] = l.split("|");
      return [`${s}|${f}`, m] as const;
    }),
);

/*
 * CORRECTIONS laid over the source file, which is never edited. Each says why.
 * No LGD code is invented: an added body carries none. The unified Municipal
 * Corporation of Delhi is deliberately NOT added — which districts its zones
 * fall in has not been verified.
 */
const DELHI_MERGE =
  "unified into the Municipal Corporation of Delhi on 22 May 2022 (Delhi Municipal Corporation (Amendment) Act, 2022)";
const REMOVE = new Map([
  ["276400", `East Delhi Municipal Corporation — ${DELHI_MERGE}`],
  ["276401", `North Delhi Municipal Corporation — ${DELHI_MERGE}`],
  ["276402", `South Delhi Municipal Corporation — ${DELHI_MERGE}`],
]);
const ADD = [
  {
    state: "Delhi",
    district: "New Delhi",
    name: "Delhi Cantonment Board",
    type: "Cantonment Board",
    reason:
      "not in the source file; Delhi Gazette 223/SDM-II(HQ)/Land/2025/610 of 3 Sep 2026 lists the Delhi Cantt sub-division under New Delhi district",
  },
];
const removed: { state: string; district: string; name: string; code: string; reason: string }[] = [];

const csv = readFileSync(process.argv[2], "utf8");
const read = readIndiaUlbCsv(csv);
const rows = parseCsv(csv);
const head = rows[0];
const col = (r: string[], n: string) => (r[head.indexOf(n)] ?? "").trim();

type Town = [string, string, string, string];
const out: Record<string, Record<string, Town[]>> = {};
const unresolved: { state: string; name: string; code: string }[] = [];
const codes = new Set<string>();
const dupNames: string[] = [];
const problems = new Set<string>();

for (const r of rows.slice(1)) {
  const s = canonicalState(col(r, "State/UT").replace(/^The /i, ""));
  const master = INDIA_GEOGRAPHY.find((x) => x.name === s);
  if (!master) { problems.add(`unknown state ${s}`); continue; }
  const name = col(r, "City/Town"), code = col(r, "LGD code"), district = col(r, "District");
  codes.add(code);
  if (district === "DISTRICT UNKNOWN") { unresolved.push({ state: s, name, code }); continue; }
  const target = ALIASES.get(`${s}|${district}`) ?? master.districts.find((d) => placeKey(d.name) === placeKey(district))?.name;
  if (!target || !master.districts.some((d) => d.name === target)) { problems.add(`unmatched district ${s} / ${district}`); continue; }
  const why = REMOVE.get(code);
  if (why) {
    removed.push({ state: s, district: target, name, code, reason: why });
    continue;
  }
  const list = ((out[s] ??= {})[target] ??= []);
  if (list.some((t) => t[1] === code)) { problems.add(`code ${code} twice in ${target}`); continue; }
  if (list.some((t) => placeKey(t[0]) === placeKey(name))) dupNames.push(`${s} / ${target} / ${name} (${code})`);
  list.push([name, code, col(r, "Type (as in LGD file)"), col(r, "Review flag")]);
}
for (const a of ADD) {
  const list = ((out[a.state] ??= {})[a.district] ??= []);
  if (list.some((t) => placeKey(t[0]) === placeKey(a.name))) problems.add(`${a.name} is already in the source file — drop the addition`);
  list.push([a.name, "", a.type, "added by correction"]);
}
if (problems.size) { console.error([...problems].join("\n")); process.exit(1); }
for (const d of Object.values(out)) for (const l of Object.values(d)) l.sort((a, b) => a[0].localeCompare(b[0]));

const body = Object.keys(out)
  .sort()
  .map((s) => `  ${JSON.stringify(s)}: {\n${Object.keys(out[s]).sort().map((d) => `    ${JSON.stringify(d)}: ${JSON.stringify(out[s][d])},`).join("\n")}\n  },`)
  .join("\n");

writeFileSync(
  "src/lib/geography/india-towns.ts",
  `/* GENERATED by scripts/build-india-towns.ts — do not edit by hand.
 * Source: Local Government Directory (https://lgdirectory.gov.in), Ministry of
 * Panchayati Raj, Government of India, via all_india_towns_final_with_codes.csv.
 * Its Copyright Policy (lgdirectory.gov.in/copyRightPolicy.do, read Nov 2026)
 * allows reproduction free of charge if accurate, not derogatory or misleading,
 * and the source is prominently acknowledged. It does not mention commercial
 * use; senior/legal confirmation of that is PENDING.
 * CORRECTIONS (see TOWN_CORRECTIONS) are ours, not LGD's.
 * Each town is [name, LGD code or "" where none is known, type, flag or ""].
 * The one list "Where they work" offers. PURE, no I/O. */
export type IndiaTown = readonly [name: string, lgdCode: string, type: string, flag: string];

export const INDIA_TOWNS: Readonly<Record<string, Readonly<Record<string, readonly (readonly string[])[]>>>> = {
${body}
};

/** Towns the file gives no district for. Listed under none, never guessed into one. */
export const UNRESOLVED_TOWNS: readonly { state: string; name: string; code: string }[] = ${JSON.stringify(unresolved, null, 1)};

/** What this list changes from the source file, and why. */
export const TOWN_CORRECTIONS = ${JSON.stringify({ removed, added: ADD }, null, 1)} as const;

export function townsOf(state: string, district: string): readonly IndiaTown[] {
  return (INDIA_TOWNS[state]?.[district] ?? []) as unknown as readonly IndiaTown[];
}
`,
);

const all = Object.values(out).flatMap((d) => Object.values(d).flat());
const kept = new Set([...all.map((t) => t[1]), ...unresolved.map((u) => u.code)].filter(Boolean));
const states = new Set([...Object.keys(out), ...unresolved.map((u) => u.state)]);
const types: Record<string, number> = {};
for (const t of new Map(all.map((t) => [t[1], t])).values()) types[t[2]] = (types[t[2]] ?? 0) + 1;
console.log(
  JSON.stringify({
    csvRows: rows.length - 1,
    distinctCodes: codes.size,
    keptCodes: kept.size,
    listings: all.length,
    removedListings: removed.length,
    added: ADD.length,
    unresolved: unresolved.length,
    states: states.size,
    missingStates: INDIA_GEOGRAPHY.filter((s) => !states.has(s.name)).map((s) => s.name),
    districtsWithTowns: Object.values(out).reduce((n, d) => n + Object.keys(d).length, 0),
    masterDistricts: INDIA_GEOGRAPHY.reduce((n, s) => n + s.districts.length, 0),
    badCodes: [...codes].filter((c) => !/^\d+$/.test(c)).length,
    noType: all.filter((t) => !t[2]).length,
    flags: read.flags.length,
    types,
    sameNameSameDistrict: dupNames,
  }),
);
