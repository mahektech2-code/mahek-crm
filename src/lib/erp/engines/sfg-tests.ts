/* ---------------------------------------------------------------------------
 * The checks an SFG lot's QC decision records, from the Testing list.
 *
 * Two shapes. The factory phone asks Pass / Fail per test (below, first).
 * The ERP's approve and reject prompts ask for EVIDENCE instead — the same
 * photographs and readings Purchase → Lot testing records — and none of it
 * is required (further down).
 *
 * The Testing list (ERP → Settings → Reference lists) is the company's own
 * list of tests, and its ACTIVE values are what QC is asked about: one Pass /
 * Fail answer per test, beside the note. Adding a test to the list puts it on
 * the next decision; switching one off takes it away — nothing here names a
 * test.
 *
 * The rule:
 *  - APPROVING needs every test answered, and every answer Pass. A lot that
 *    failed a test is rejected, not approved, and the refusal says which.
 *  - REJECTING records whatever was answered — a lot can fail on its first
 *    test and nobody runs the rest — and asks for nothing more.
 *
 * The answers are stored with the verdict keyed by the test's NAME, so a test
 * renamed or retired later still reads back as what was checked that day.
 *
 * PURE, so the prompt the screen draws and the rule the server enforces are
 * one function each, tested without a database.
 * ------------------------------------------------------------------------- */

export const TEST_RESULTS = ["Pass", "Fail"] as const;
export type TestResult = (typeof TEST_RESULTS)[number];
export type TestResults = Record<string, TestResult>;

/** The prompt field for one test. The key carries the test's name. */
export const testKey = (test: string) => `test:${test}`;

/** One Pass / Fail field per active test, required only when approving. */
export function qcTestFields(tests: string[], approving: boolean) {
  return tests.map((test) => ({
    k: testKey(test),
    l: test,
    t: "select" as const,
    opts: [...TEST_RESULTS],
    req: approving,
  }));
}

export type QcTestReading =
  | { ok: true; results: TestResults }
  | { ok: false; field: string; message: string };

/**
 * The answers a prompt sent, read against the tests asked about. Only a test
 * on the list counts — a value for anything else is ignored, so a crafted
 * post cannot record a check nobody was asked to make.
 */
export function readQcTests(tests: string[], values: Record<string, string | undefined>, approving: boolean): QcTestReading {
  const results: TestResults = {};
  for (const test of tests) {
    const raw = (values[testKey(test)] ?? "").trim();
    if (!raw) continue;
    if (raw !== "Pass" && raw !== "Fail") return { ok: false, field: testKey(test), message: `Choose Pass or Fail for ${test}` };
    results[test] = raw;
  }
  if (!approving) return { ok: true, results };
  const missing = tests.find((t) => !results[t]);
  if (missing) return { ok: false, field: testKey(missing), message: `Record the ${missing} result before approving` };
  const failed = tests.filter((t) => results[t] === "Fail");
  if (failed.length)
    return {
      ok: false,
      field: testKey(failed[0]),
      message: `${failed.join(", ")} failed — a lot that fails a test is rejected, not approved`,
    };
  return { ok: true, results };
}

/** The recorded checks in one line, for the record dialog. */
export function testResultsLine(results: TestResults | null | undefined): string | null {
  const entries = Object.entries(results ?? {});
  if (!entries.length) return null;
  return entries.map(([test, r]) => `${test}: ${r}`).join(" · ");
}

/** Every test answered Pass — what a seeded or scripted approval sends. */
export function allPassValues(tests: string[]): Record<string, string> {
  return Object.fromEntries(tests.map((t) => [testKey(t), "Pass"]));
}

/* ---------------------------------------------------------------------------
 * EVIDENCE — what a QC decision in the ERP records, the same as a purchase
 * test (Purchase → Lot testing): a photograph per test, the smell, the pH and
 * density readings, and a video. One list, read by both, so a test's evidence
 * cannot be asked for two different ways.
 *
 * On a purchase test the evidence a test needs is REQUIRED — the verifier
 * cannot pass what they cannot see. On an SFG lot's QC decision NOTHING is:
 * the approver records what was checked and the decision stands on their
 * word, so the prompt asks for none of it and says nothing about which is
 * optional either (`untagged`).
 * ------------------------------------------------------------------------- */

export type EvidenceField = {
  test: string;
  k: string;
  l: string;
  t: "photo" | "num" | "select";
  opts?: string[];
  min?: number;
  max?: number;
  hint?: string;
};

export const SMELLS = ["Good", "Moderate", "Bad"] as const;

/** Every known test's evidence, in the order the forms ask for it. */
export const EVIDENCE_FIELDS: EvidenceField[] = [
  { test: "PH", k: "ph", l: "pH photo", t: "photo" },
  { test: "PH", k: "phValue", l: "pH value", t: "num", hint: "Read from the pH photo when AI is on — confirm it." },
  { test: "Smell", k: "smell", l: "Smell", t: "select", opts: [...SMELLS] },
  { test: "Color", k: "color", l: "Colour photo", t: "photo" },
  { test: "Oil Paint", k: "oil", l: "Oil-paint photo", t: "photo" },
  { test: "Fast Paints", k: "fast", l: "Fast-paint photo", t: "photo" },
  { test: "Nc Paints", k: "nc", l: "NC-paint photo", t: "photo" },
  { test: "Primer", k: "primer", l: "Primer photo", t: "photo" },
  { test: "Density", k: "density", l: "Density value", t: "num", min: 0.5, max: 1.5 },
  { test: "Density", k: "densityPhoto", l: "Density photo", t: "photo" },
  { test: "Tharmakol Pass", k: "thermocol", l: "Thermocol-pass photo", t: "photo" },
];

/** A test the Testing list names and this list does not: a photograph of it. */
const otherPhoto = (test: string): EvidenceField => ({ test, k: `photo:${test}`, l: `${test} photo`, t: "photo" });

/** The evidence fields for the tests asked about, in the Testing list's order. */
export function evidenceFieldsFor(tests: string[]): EvidenceField[] {
  return tests.flatMap((test) => {
    const known = EVIDENCE_FIELDS.filter((f) => f.test === test);
    return known.length ? known : [otherPhoto(test)];
  });
}

/** A photo's name on its tile: "Oil-paint photo" is "Oil paint". */
const tileName = (l: string) => l.replace(/ photo$/i, "").replace(/-/g, " ");

/**
 * The SFG QC prompt's evidence fields: none required, none labelled optional.
 * The readings share a row, then every photograph — and the video — as a tile.
 */
export function qcEvidenceFields(tests: string[]) {
  const fields = evidenceFieldsFor(tests);
  const readings = fields
    .filter((f) => f.t !== "photo")
    .map((f) => ({
      ...f,
      hint: undefined,
      l: f.k === "phValue" ? "pH" : f.l.replace(/ value$/i, ""),
      ...(f.min != null && f.max != null ? { hint: `${f.min} – ${f.max}` } : {}),
      sec: "Readings",
      inline: true as const,
      untagged: true as const,
    }));
  const photos = fields
    .filter((f) => f.t === "photo")
    .map((f) => ({ ...f, l: tileName(f.l), sec: "Photos", tile: true as const, untagged: true as const }));
  return [...readings, ...photos, { k: "video", l: "Test video", t: "video" as const, sec: "Photos", tile: true as const, untagged: true as const }];
}

export type QcEvidence = {
  smell?: string;
  phValue?: number;
  density?: number;
  /** test name → attachment id. */
  photos: Record<string, string>;
  video?: string;
};

export type QcEvidenceReading = { ok: true; evidence: QcEvidence } | { ok: false; field: string; message: string };

/**
 * What a prompt sent, read against the tests asked about. Blank is fine
 * everywhere; what IS given has to make sense — a smell from the list, a
 * number that is a number, a density in its range. A value for a test not on
 * the list is ignored.
 */
export function readQcEvidence(tests: string[], values: Record<string, string | undefined>): QcEvidenceReading {
  const evidence: QcEvidence = { photos: {} };
  for (const f of evidenceFieldsFor(tests)) {
    const raw = (values[f.k] ?? "").trim();
    if (!raw) continue;
    if (f.t === "photo") evidence.photos[f.test] = raw;
    else if (f.t === "select") {
      if (!f.opts?.includes(raw)) return { ok: false, field: f.k, message: `Choose ${f.opts?.join(", ")} for ${f.l.toLowerCase()}` };
      evidence.smell = raw;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, field: f.k, message: `${f.l} must be a number` };
      if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) return { ok: false, field: f.k, message: `${f.l} must be between ${f.min} and ${f.max}` };
      if (f.k === "phValue") evidence.phValue = n;
      else evidence.density = n;
    }
  }
  const video = (values.video ?? "").trim();
  if (video) evidence.video = video;
  return { ok: true, evidence };
}

/** Every file an evidence record names, to bind to the decision. */
export function evidenceFileIds(e: QcEvidence | null | undefined): string[] {
  if (!e) return [];
  return [...Object.values(e.photos ?? {}), ...(e.video ? [e.video] : [])];
}

/** Anything recorded at all — an empty record draws nothing. */
export function hasEvidence(e: QcEvidence | null | undefined): boolean {
  return !!e && (e.smell != null || e.phValue != null || e.density != null || evidenceFileIds(e).length > 0);
}
