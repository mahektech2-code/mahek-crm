# Handset release, motion, haptics, sounds, push banner

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE HANDSET IS RELEASED BY A WORKFLOW, and never from somebody's laptop.**
`.github/workflows/mbos-apk.yml` builds it, verifies the signature against the
committed keystore with `apksigner`, and publishes to R2 under a versioned name
and to the droplet as the one stable `/downloads/mbos.apk`. It is
`workflow_dispatch` — `gh workflow run "MBOS APK" --ref main -f
api_base=https://one.mahekindia.com -f publish=true` — because sideloading has
no staged rollout and no rollback, so a release is a decision somebody makes.
`api_base` is baked into the bundle and cannot be changed afterwards. It
builds TWO APKs — `mbos.apk` (64-bit ARM) and `mbos-32bit.apk` (32-bit, for
the "Android Go" phones that refused the first with "App not installed") — and
`engines/app-update.ts` hands each phone the one its Android runs.

A release built by hand and copied up skips the signature check, the versioned
archive and any record of what shipped, and puts the app back on whichever
machine happens to have a JDK. That has happened, on 2026-09-08, because the
release path was written down nowhere anybody looks — which is why it is
written here. Local `gradlew assembleRelease` is for trying a change on your own
phone and nothing else. See DEPLOY.md, "Releasing the handset app".

**THE HANDSET MOVES, BUZZES AND CHIMES THROUGH THREE FILES, and no screen
reaches past them.** `components/ui/motion.tsx` is every animation —
`Stagger`, `Presence`, `Swap`, `Pop`, `CountUp`, `FillBar`, `DrawnTick`,
`PressableScale`, `SwipeRow`, `useShake`, `animateLayout` — and its rule is the
one it has always stated: motion says something about how two states relate,
or it is not there. `engines/feedback.ts` decides whether an event buzzes or
chimes, pure and tested; `components/ui/feedback.ts` is the only code that
touches the motor or the speaker. A screen calls `feedback('success')` and
names a KIND — six of them — never a pattern or a file, because a buzz only
means something if the same thing always feels the same. `route-motion.test.ts`
fails the build on `expo-haptics` or an audio player imported anywhere else,
and on a screen in `app/` with no entry in `ROUTE_MOTION`.

**No Reanimated, deliberately.** It went with worklets and gesture-handler to
make the APK lean (0ae86207), and nothing here needs it: transforms and opacity
run on the native driver, and the few things that cannot — a bar's width, a
number counting, an SVG stroke — are short and one-off. The sheets drag and the
rows swipe on plain `PanResponder`.

**The toast is where most outcomes are FELT.** Every save that confirms itself
does it through `notify()`, so one line in `Toast` gives forty screens the same
success buzz and every refusal the same "no", without any of them learning a
motor exists. A screen that already toasts does not also call `feedback` for
the same event.

**Sounds are OFF until the salesman turns them on, and silent unless the ringer
is on normal.** He is standing in somebody else's shop; a phone that chimes at
every order is not a default anybody should have to find a switch to undo. UI
sounds play on the MEDIA stream, which Android's silent and vibrate modes do not
govern, so `ringerMode` in the phone-setup module is asked before every chime —
and `unknown`, which is every build before 1.16.0, is read as silent. The WAVs
are synthesised by `scripts/make-sounds.mjs`, so there is no licence to track.

**`expo-haptics` is imported LAZILY,** for the reason `native/capture.ts` gives
about the document picker: main's JavaScript goes over the air to older APKs,
and a package that calls `requireNativeModule` at import would stop every
screen that buzzes from opening on a build without it. Older builds simply do
not buzz; they have no VIBRATE permission for a fallback either.

**A PUSH THAT LANDS WHILE THE APP IS OPEN IS DRAWN BY THE APP.** `PushBanner`
replaces the system heads-up — which covered the bell it was about and played
the stock tone a foot from somebody's face — with a card in the app's own
colours, toned by the notification's kind, opened through the same `openFrom` a
tapped notification uses so the two cannot disagree about where a push goes. It
also SYNCS on arrival, so the bell's count rises while the banner is still on
screen. The notification handler suppresses the system banner only while ours
is mounted, so a push nothing drew is never a push that silently vanished.

**Two channels have sounds of their own, and both ends are gated on the build.**
`decisions-v1` is approvals and refusals, `updates-v1` everything else, and the
server chooses between them in `channelFor`. An Android channel's sound is
fixed the moment the channel exists, so the handset creates these only on an
APK that carries the sound files — created on an older one by an over-the-air
bundle, they would be silent and STAY silent after the upgrade. The server
sends to them only from `SOUND_CHANNELS_FROM` (1.16.0), reading
`mbos_devices.app_version`; anything older, or unreported, keeps `default`. A
test reads the handset's `push.ts` and fails if either side's spelling of a
channel drifts, because a misspelt channel does not fail — it falls back to
Expo's generic one and just loses its sound.

**A TAP WAITS FOR THE RECORD, BRIEFLY.** `openFrom` asks for one sync pass and
waits on it up to four seconds before routing, so a push tapped the moment it
lands opens on the decision rather than the old state; then it marks the
notification read, here and at the office (`notification_read`). Every pull
that lands bumps `pullSeq` in the store (`whenPulled` in `sync/engine.ts`), and
Tasks and Notifications re-read on it, so a record that arrives after the screen
opened still appears. A refused ORDER rings once: the office's push
(`raiseRejectionTask`) is the bell, and `onRejection` no longer raises a local
one for orders.

**A SIGN-OUT WITH NO SIGNAL STILL LETS GO OF THE PUSH TOKEN.** `clearPushToken`
keeps the token aside when its request fails, and the next app open with nobody
signed in sends it to `DELETE /api/mbos/push-token` (device AND token must
match, no session). A different person signing in on the phone starts with no
token server-side regardless (`mbosLogin`'s upsert).

**Route points survive a sign-out for the same person.** The native buffer is
moved into `positions` at sign-out rather than deleted, the confirm counts
them, and a different person signing in empties them with the rest of the last
person's day (`forgetLastPerson`).
