# Mahek MBOS — field sales

The salesman's app. React Native on Expo, one codebase for iOS and Android,
talking to MahekOne.

```bash
cd mbos-app
npm install
npm run ios          # simulator
npm run android      # device or emulator
npm run typecheck
npm test             # engines + sync ordering, no device needed
```

Built on **Expo SDK 54**, so it runs in the Expo Go on the app stores today.
Scan the QR, or open `exp://<your-lan-ip>:8081`.

Point it at MahekOne with `EXPO_PUBLIC_API_BASE` (defaults to
`http://localhost:3000`).

---

## The one architectural fact

**MBOS is an offline-first application that happens to sync. It is not an
online application with offline fallback.**

A salesman in a paint market has no usable signal for hours. Everything below
follows from that, and none of it is retrofittable:

- **The UI reads SQLite and never awaits the network.** A saved visit is saved.
- **Identifiers are minted on the device**, before anything reaches a server.
  That is what lets an offline visit own an offline order that owns an offline
  payment, all referencing each other correctly while none of them exists
  anywhere else.
- **The outbox is dependency-ordered**, not creation-ordered. A payment cannot
  overtake the order it was collected against.
- **Sync is idempotent.** A retried request whose response we never saw — which
  on 2G is most of them — never duplicates a real order.
- **A rejected record is retained and surfaced, never discarded.** The salesman
  stood in the shop and said the order was placed.

`PROTOCOL.md` is the contract between this app and MahekOne. Neither side may
change a shape without changing that document first.

## Layout

```
app/                    one screen per file, expo-router, flat
src/
  db/                   the LOCAL store — schema.ts, index.ts (migrations,
                        client ids, transactions)
  sync/
    ordering.ts         which items may go out, and in what order — PURE
    ordering.test.ts    12 tests, incl. the visit→order→payment case
    queue.ts            the outbox: enqueue, backoff, block, retry
    engine.ts           one pass = push + pull in one round trip
    api.ts              the only place a request leaves this app
    pull.ts             applying what came down; never touches owned data
    media.ts            photos and audio, queued SEPARATELY from records
  data/                 the write path and every read. Screens use only this.
  engines/              PURE business rules — geo, route, credit, health,
                        schemes, cash, attendance, leave, order. No I/O.
  native/               GPS, camera, microphone
  components/           Icon, primitives, overlays, shell
  theme/tokens.ts       the design's palette and type scale, verbatim
CONTRACT.md             rules for anyone adding a screen
PROTOCOL.md             the sync contract
DECISIONS.md            the ten open questions from §11, and how each was read
```

## Rules this codebase holds to

**Every write goes: validate → client id → local store → enqueue → return.**
Step five is the one that matters. `src/data/write.ts` is the only door.

**A visit can always be saved.** The checklist says what is missing and why the
rule exists; the dashed button below it saves anyway, unverified, with a
required reason that reaches the manager. Refusing the save teaches people to
stop logging visits, and then the office knows nothing rather than something
imperfect.

**Credit-blocked is the only outright block in the app.** Over the limit, over
the approval threshold, outside the geofence, no GPS fix, too far from the
shop — all of those flag or route to approval. None of them stops the work.

**Attendance check-in is never blocked**, only flagged. A salesman who cannot
mark attendance cannot work.

**Every threshold reads from configuration.** Nothing business-critical is a
literal. `src/data/config.ts` holds fallbacks for a handset that has never
bootstrapped, and says plainly that they are not policy.

**Money is paise. Dates are Asia/Kolkata.** `toISOString().slice(0,10)` answers
in UTC and is never used for a business date.

**Audio is never deleted before its transcription is confirmed stored** — not
merely because the upload succeeded. It is the only copy of what the customer
actually said.

**`weight(400|500|600)`, never `fontWeight`.** React Native does not synthesise
weights on Android.

## What is real

Phases 0–2 of the brief, and the frame of everything after.

- Local store, client ids, dependency-ordered outbox with backoff and blocking,
  media queue, restart recovery
- Real auth against MahekOne — the five checks in order, device binding, and a
  bounded offline login window
- Real GPS with accuracy, camera, microphone, compression
- Visit capture, orders with credit and schemes, payments with cash-in-hand and
  SLA, attendance, tasks, leave, expenses, samples
- The rejection review screen at `/rejections`
- Server: `/api/mbos/auth/login` · `/refresh` · `/bootstrap` · `/sync` · `/media`
- Scheduled work in MahekOne's own job registry (`mbos-nightly`, `mbos-hourly`)

## What is not

Named plainly rather than implied:

| | Status |
|---|---|
| Push notifications | In-app only. No device tokens, no APNs/FCM. |
| Reports and exports | Screens exist; no server-side report or PDF/Excel. |
| Offline documents | Listed, not downloadable. |
| Salary, performance | Read fixtures — no payroll or ranking source exists. |
| Conflict resolution | Implemented for customer edits only, the one mutable record the handset touches. |

**WhatsApp is copy-to-send, and that is the design.** The Business API is not
live, so nothing here sends on the company's behalf. `src/lib/messaging.ts`
prepares the message exactly and hands it to the salesman's own WhatsApp, where
he presses send — which is why a message is only ever recorded as sent when a
human confirms it, and sits as `copied` until then. Marking it sent because we
opened WhatsApp would be a guess wearing the clothes of a fact.

## Running it against MahekOne

The MBOS migration **has been applied** to the local Postgres — all 24 `mbos_*`
tables and the `customers` extensions exist, and sign-in has been verified
end-to-end returning a real book and the real catalogue.

```bash
# from the repo root
npm run db:migrate
npm run dev                    # MahekOne on :3000
```

`MBOS_JWT_SECRET` must be set or `/api/mbos/auth/login` refuses with a 503 that
says so — deliberately, rather than falling back to a default secret.

Point the handset at the machine's LAN address, not localhost:

```
mbos-app/.env →  EXPO_PUBLIC_API_BASE=http://<your-lan-ip>:3000
```

**One device per person.** A second handset is refused until the first is
released — that is brief §2.2 working, not a bug. To clear it in development:
`delete from mbos_devices;`

The integration tests still need a test database:

```bash
npm run test:db && npm run test:integration
```
