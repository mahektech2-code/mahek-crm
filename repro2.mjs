process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://mahek:DA5wxqXgmfJzJQl0ZYsVxgElwy2GmepK@127.0.0.1:5433/mahekone";
const { readingsForPeriod } = await import("./src/lib/services/performance-service.ts");
const { today } = await import("./src/lib/recompute.ts");
const { focusLines } = await import("./src/lib/engines/performance.ts");
try {
  const day = await today();
  const period = day.slice(0, 7);
  for (const uid of ["usr_295b3c7a-417", "usr_13a5c041-ee2", "usr_d2e9b258-633", "usr_31c7f8fa-6ab"]) {
    const [reading] = await readingsForPeriod(period, day, { userIds: [uid] });
    console.log(uid, "hasTarget:", reading?.hasTarget, "mix.categories:", reading?.mix?.categories?.length);
    if (reading) {
      const focus = focusLines(reading.score, reading.mix, day);
      console.log("  focus lines ok:", focus.length);
    }
  }
  console.log("ALL OK");
} catch (e) {
  console.error("CRASHED:", e);
} finally {
  process.exit(0);
}
