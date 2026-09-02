import React from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import { router } from 'expo-router';
import { color as C, HIT, radius, shadow, type, weight } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Card, Choice } from '../src/components/ui/primitives';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useCustomer, useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { isoDate, pretty } from '../src/lib/format';
import { elapsedLabel, FOLLOW_ON, visitChecks, visitVerdict } from '../src/lib/visit';
import { COMPLAINT_CATEGORIES, OUTCOMES } from '../src/data/fixtures';
import { getConfig } from '../src/data/config';
import { previousVisitNote, saveVisit, type PreviousNote } from '../src/data/visits';
import { logComplaint, requestSample } from '../src/data/requests';
import { starterProducts } from '../src/data/customers';
import { todayStops } from '../src/data/journey';
import { visitLocationVerdict } from '../src/engines/geo';
import { fixOf, getFix, type Fix } from '../src/native/location';
import { queueRecording, takePhoto, useVoiceRecorder } from '../src/native/capture';

/**
 * Capturing a visit.
 *
 * The rule that shapes this screen: the save is never refused outright. The
 * checklist says what is missing and why the rule exists, and the dashed
 * button under it saves anyway — unverified, with a reason, and the manager
 * told. A salesman who cannot log a visit stops logging visits, and then the
 * office knows nothing at all.
 *
 * The GPS follows the same rule one level down. A fix is EVIDENCE, never a
 * gate: no fix, a fix accurate to half a kilometre, or a shop whose recorded
 * coordinates are simply wrong all let the visit through and are recorded as
 * what they are.
 */

type Product = { id: string; name: string; packSize: string | null };

export default function Visit() {
  const c = useCustomer();
  const boot = useBoot();
  const gps = useStore((s) => s.gps);
  const shots = useStore((s) => s.shots);
  const rec = useStore((s) => s.rec);
  const note = useStore((s) => s.note);
  const outcome = useStore((s) => s.outcome);
  const nextDate = useStore((s) => s.nextDate);
  const visitStart = useStore((s) => s.visitStart);
  const visitDone = useStore((s) => s.visitDone);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const markVisitDone = useStore((s) => s.markVisitDone);
  const askConfirm = useStore((s) => s.askConfirm);

  const [form, setForm] = React.useState<'complaint' | 'sample' | null>(null);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [formErr, setFormErr] = React.useState<string | null>(null);
  const [calOpen, setCalOpen] = React.useState<'next' | 'trial' | null>(null);

  /* Everything captured here that is not yet a visit: the fix, the recording,
     the records punched from inside it. `saveVisit` binds the lot in one
     transaction — a half-saved visit describes something that never happened. */
  const [fix, setFix] = React.useState<Fix | null>(null);
  const [fixReason, setFixReason] = React.useState<string | null>(null);
  const [voiceNoteId, setVoiceNoteId] = React.useState<string | null>(null);
  const [linked, setLinked] = React.useState<{ complaintId?: string; sampleId?: string }>({});
  const [products, setProducts] = React.useState<Product[]>([]);
  const [stopId, setStopId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [lastTime, setLastTime] = React.useState<PreviousNote | null>(null);

  /* Thresholds, never constants: the dwell floor and the distance that counts
     as a mismatch are both a manager's to move. */
  const [minDwell, setMinDwell] = React.useState(120);
  const [maxMetres, setMaxMetres] = React.useState(150);

  const recorder = useVoiceRecorder();

  /**
   * The dwell clock has to tick, because one of the save conditions is time.
   * It is held in state and advanced by the interval rather than read during
   * render — a render that reads the clock gives a different answer every time
   * React happens to re-run it, and here that answer decides whether the save
   * button is live.
   */
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const custId = c?.id ?? null;

  React.useEffect(() => {
    let live = true;
    void Promise.all([
      getConfig<number>('mbos.visits.minimumDwellSeconds', 120),
      getConfig<number>('mbos.location.visitMismatchM', 150),
      starterProducts(5),
      todayStops(),
    ]).then(([dwell, metres, skus, stops]) => {
      if (!live) return;
      setMinDwell(dwell);
      setMaxMetres(metres);
      setProducts(skus);
      /* A stop on today's plan makes this a planned visit and gets marked
         visited when the save lands. */
      setStopId(stops.find((s) => s.customerId === custId && s.status === 'planned')?.id ?? null);
    });
    return () => {
      live = false;
    };
  }, [custId]);

  /* What he said last time, read back before this call rather than found
     afterwards on the timeline. See `data/visits.ts`. */
  React.useEffect(() => {
    let live = true;
    if (!custId) return;
    void previousVisitNote(custId).then((row) => {
      if (live) setLastTime(row);
    });
    return () => {
      live = false;
    };
  }, [custId]);

  /* The suggested return day comes from the customer's own measured cycle, so
     a shop that reorders every three weeks is not offered the same date as one
     that reorders every three months. He can change it; they often say. */
  React.useEffect(() => {
    if (nextDate || !c) return;
    const gap = c.cycleDays ?? c.visitFrequencyDays ?? 7;
    set({ nextDate: isoDate(new Date(Date.now() + gap * 86_400_000)) });
  }, [nextDate, c, set]);

  /* One attempt at a fix on arrival, ten seconds at most. The salesman is
     standing in a shop with the owner waiting; a spinner is not an option. */
  React.useEffect(() => {
    let live = true;
    if (gps !== 'acquiring') return;
    void (async () => {
      const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
      const result = await getFix({ accuracyThresholdM: threshold });
      if (!live) return;
      const got = fixOf(result);
      setFix(got);
      setFixReason(result.status === 'ok' ? null : result.reason);
      set({ gps: got ? 'locked' : 'off' });
    })();
    return () => {
      live = false;
    };
  }, [gps, set]);

  const startRecording = async () => {
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      set({ rec: 'rec' });
    } catch {
      notify('The microphone could not start. Type the note instead.');
    }
  };

  const stopRecording = async () => {
    set({ rec: 'busy' });
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        set({ rec: 'failed' });
        return;
      }
      /* Queued as it is. Re-encoding speech to save bytes loses the words, and
         the audio is the only copy of what the customer actually said. */
      const mediaId = await queueRecording(uri, 'visit', 'pending');
      setVoiceNoteId(mediaId);
      set({ rec: 'failed' });
    } catch {
      set({ rec: 'failed' });
    }
  };

  const shoot = async (which: 'shop' | 'cust') => {
    const shot = await takePhoto({
      parentType: 'visit',
      parentId: 'pending',
      kind: which === 'shop' ? 'shop_photo' : 'customer_photo',
    });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason);
      return;
    }
    set({ shots: { ...shots, [which]: shot.mediaId } });
  };

  const dwellSeconds = visitStart ? Math.max(0, Math.floor((now - visitStart) / 1000)) : 0;
  const gpsLocked = gps === 'locked';

  /* The disagreement between the phone and the book, as a disagreement — one
     of the two is wrong and nothing here claims to know which. */
  const verdictGeo = visitLocationVerdict(
    fix ? { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM } : null,
    c && c.gpsLat != null && c.gpsLng != null ? { lat: c.gpsLat, lng: c.gpsLng } : null,
    maxMetres,
  );
  const metresAway = verdictGeo.metresAway == null ? null : Math.round(verdictGeo.metresAway);

  const checks = visitChecks({
    gpsLocked,
    metresAway,
    dwellSeconds,
    minimumDwellSeconds: minDwell,
    maxMetresFromShop: maxMetres,
    hasShopPhoto: !!shots.shop,
    outcome,
    followOnCaptured: !!(outcome && visitDone[outcome]),
  });
  const verdict = visitVerdict(checks);
  const followOn = outcome ? FOLLOW_ON[outcome] : undefined;
  const doneLine = outcome ? visitDone[outcome] : undefined;

  async function saveAndGo(spent: string, unverifiedReason: string | null) {
    if (!c || saving) return;
    setSaving(true);
    const checkOut: Fix | null = fix ? { ...fix, at: now } : null;
    try {
      await saveVisit({
        customerId: c.id,
        customerName: c.name,
        userId: boot.session?.user.id ?? '',
        checkIn: fix,
        checkOut,
        outcome: outcome ?? 'visited',
        notes: note.trim() || null,
        transcript: null,
        transcriptIsAi: false,
        shopPhotoId: shots.shop ?? null,
        custPhotoId: shots.cust ?? null,
        voiceNoteId,
        nextFollowUpDate: nextDate || null,
        journeyStopId: stopId,
        wasPlanned: !!stopId,
        deviationReason: null,
        locationMismatch: verdictGeo.mismatch,
        metresFromShop: metresAway,
        verified: unverifiedReason == null,
        unverifiedReason,
        linkedComplaintId: linked.complaintId ?? null,
        linkedSampleId: linked.sampleId ?? null,
      });
      set({ visitSpent: spent });
      router.replace('/saved');
    } catch {
      setSaving(false);
      notify('The visit could not be saved on this phone. Nothing has been lost — try again.');
    }
  }

  return (
    <AppFrame
      title="Visit"
      activeTab="customers"
      onBack={() => router.back()}
      contentStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 }}
      footer={
        <View style={{ backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.hairline, paddingHorizontal: 16, paddingVertical: 12, boxShadow: shadow.saveBar }}>
          {!verdict.verified ? (
            <Text style={{ fontSize: 13, lineHeight: 18, color: C.warnInk, marginBottom: 8 }}>{verdict.firstFailure}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={type.label}>In the shop</Text>
              <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{elapsedLabel(dwellSeconds)}</Text>
            </View>
            <Pressable
              onPress={() => (verdict.verified ? saveAndGo(elapsedLabel(dwellSeconds), null) : notify(verdict.firstFailure))}
              accessibilityLabel={verdict.verified ? 'Save visit' : verdict.firstFailure}
              style={[
                { height: 52, paddingHorizontal: 24, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: verdict.verified ? C.primary : C.hairline },
                verdict.verified && { boxShadow: shadow.primary },
              ]}>
              <Text style={[{ fontSize: 16, color: verdict.verified ? '#FFFFFF' : C.faint }, weight(600)]}>Save visit</Text>
            </Pressable>
          </View>
        </View>
      }>
      {/* ---- what was said last time ----
          Shown before the call, not found after it on the timeline. "Will
          pay" typed in a hurry three weeks ago reads exactly like a
          sentence that never named a date — the whole reason a note is
          worth reading back rather than trusted from memory. */}
      {lastTime ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: C.hairline,
            backgroundColor: C.wash,
            borderRadius: radius.xl,
            paddingVertical: 12,
            paddingHorizontal: 16,
            marginBottom: 12,
          }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <Text style={type.label}>Last time — {pretty(isoDate(new Date(lastTime.checkInAt)))}</Text>
            {lastTime.outcome ? (
              <Text style={[type.caption, { color: C.body }]}>{lastTime.outcome}</Text>
            ) : null}
          </View>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.ink, marginTop: 4 }} numberOfLines={3}>
            {lastTime.note}
          </Text>
        </View>
      ) : null}

      {/* ---- where you are ---- */}
      <View
        style={{
          borderWidth: 1,
          borderColor: gpsLocked ? C.primaryEdge : gps === 'off' ? C.warnEdge : C.hairline,
          backgroundColor: gpsLocked ? C.primaryTint : gps === 'off' ? C.warnBg : C.surface,
          borderRadius: radius.xl,
          paddingVertical: 14,
          paddingHorizontal: 16,
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: gpsLocked ? C.success : gps === 'off' ? C.warn : C.faint,
            }}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
              {gpsLocked ? 'Checked in here' : gps === 'off' ? 'No GPS fix' : 'Finding you…'}
            </Text>
            <Text style={[type.caption, { color: C.body }]}>
              {gpsLocked
                ? fixReason ?? verdictGeo.sentence
                : gps === 'off'
                  ? fixReason ?? 'The visit will be saved and flagged for your manager to confirm.'
                  : 'This takes a second indoors.'}
            </Text>
          </View>
          {gps === 'off' ? (
            <Pressable
              onPress={() => notify('Saved without a location · flagged for your manager')}
              style={{ height: HIT, paddingHorizontal: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: C.faint, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={[{ fontSize: 15, color: C.body }, weight(500)]}>Carry on</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <Text style={[type.h2, { marginTop: 16 }]}>{c?.name ?? ''}</Text>
      <Text style={[type.caption, { marginTop: 2 }]}>
        {[c?.contactPerson, c?.city].filter(Boolean).join(' · ')}
      </Text>

      {/* ---- photos ---- */}
      <Card style={{ marginTop: 16 }}>
        <Text style={type.label}>Photos</Text>
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
          {[
            { k: 'shop' as const, ic: 'shop', on: 'Shop ✓', off: 'Shop photo' },
            { k: 'cust' as const, ic: 'person', on: 'Owner ✓', off: 'Owner (optional)' },
          ].map((b) => {
            const has = !!shots[b.k];
            return (
              <Pressable
                key={b.k}
                onPress={() => shoot(b.k)}
                style={{
                  flex: 1,
                  height: 86,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: has ? C.primary : C.border,
                  backgroundColor: has ? C.primaryTint : C.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                <Icon name={b.ic} size={24} color={has ? C.primaryDeep : C.body} strokeWidth={1.5} />
                <Text style={[{ fontSize: 14, marginTop: 6, color: has ? C.primaryDeep : C.body }, weight(500)]}>
                  {has ? b.on : b.off}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {shots.shop || shots.cust ? (
          <Text style={[type.caption, { marginTop: 10 }]}>Compressed and queued — they upload when you have signal.</Text>
        ) : null}
      </Card>

      {/* ---- what was said ---- */}
      <Card style={{ marginTop: 12 }}>
        <Text style={type.label}>What was said</Text>

        {rec === 'idle' ? (
          <Pressable
            onPress={startRecording}
            style={{ width: '100%', height: 64, marginTop: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: C.primary, backgroundColor: C.primaryTint, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <Icon name="mic" size={24} color={C.primaryDeep} strokeWidth={1.5} />
            <Text style={[{ fontSize: 15, color: C.primaryDeep }, weight(600)]}>Hold to talk</Text>
          </Pressable>
        ) : null}

        {rec === 'rec' ? (
          <View style={{ marginTop: 12, borderWidth: 1, borderColor: C.primary, backgroundColor: C.primaryTint, borderRadius: radius.sm, padding: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 4, height: 36 }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                <View key={i} style={{ width: 5, height: 12 + (i % 4) * 8, borderRadius: 3, backgroundColor: C.primary }} />
              ))}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12 }}>
              <Text style={[{ fontSize: 15, color: C.primaryDeep }, weight(500)]}>
                {'Recording · ' + elapsedLabel(Math.round(recorder.currentTime))}
              </Text>
              <Pressable
                onPress={stopRecording}
                style={{ height: HIT, paddingHorizontal: 16, borderRadius: radius.sm, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={[{ fontSize: 15, color: '#FFFFFF' }, weight(500)]}>Done</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {rec === 'busy' ? (
          <View style={{ marginTop: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.wash, borderRadius: radius.sm, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 18, height: 18, borderWidth: 2, borderColor: C.primaryEdge, borderTopColor: C.primary, borderRadius: 9 }} />
            <Text style={{ fontSize: 15, color: C.body }}>Turning that into text…</Text>
          </View>
        ) : null}

        {rec === 'failed' ? (
          <View style={{ marginTop: 12, borderWidth: 1, borderColor: C.warnEdge, backgroundColor: C.warnBg, borderRadius: radius.sm, padding: 14 }}>
            <Text style={{ fontSize: 13, lineHeight: 19, color: C.warnInk }}>
              No signal to transcribe. The recording is saved and will be turned into text when you are back on.
            </Text>
          </View>
        ) : null}

        {/* The note itself. The transcript is written server-side once the
            recording lands, so what he types here is his own and is never
            overwritten by it. */}
        {rec !== 'rec' && rec !== 'busy' ? (
          <View style={{ marginTop: 12 }}>
            {rec === 'done' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <View style={{ backgroundColor: C.infoBg, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={[{ fontSize: 12, color: C.info, textTransform: 'uppercase', letterSpacing: 0.36 }, weight(500)]}>
                    AI transcribed
                  </Text>
                </View>
                <Text style={type.caption}>Edit before saving</Text>
              </View>
            ) : null}
            <TextInput
              value={note}
              onChangeText={(v) => set({ note: v })}
              multiline
              style={{ width: '100%', minHeight: 96, padding: 12, borderWidth: 1, borderColor: C.border, borderRadius: radius.sm, fontSize: 14, lineHeight: 20, color: C.ink, backgroundColor: C.surface, textAlignVertical: 'top' }}
            />
          </View>
        ) : null}
      </Card>

      {/* ---- how it went ---- */}
      <View style={{ marginTop: 16 }}>
        <Text style={[type.label, { marginBottom: 10 }]}>How did it go</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {OUTCOMES.map((o) => {
            const on = outcome === o.k;
            return (
              <Pressable
                key={o.k}
                onPress={() => set({ outcome: o.k })}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={{
                  /* Two columns, and the odd seventh stays in its own cell —
                     a lone full-width chip reads as a different kind of choice. */
                  width: '48.5%',
                  minHeight: 58,
                  padding: 10,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: on ? C.primary : C.border,
                  backgroundColor: on ? C.primaryTint : C.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                <Text style={[{ fontSize: 15, lineHeight: 20, textAlign: 'center', color: on ? C.primaryDeep : C.ink }, weight(on ? 600 : 400)]}>
                  {o.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* ---- the follow-on the outcome implies ---- */}
      {followOn ? (
        <View style={{ backgroundColor: C.primaryTint, borderWidth: 1, borderColor: C.primaryEdge, borderRadius: radius.card, paddingVertical: 14, paddingHorizontal: 16, marginTop: 14 }}>
          {doneLine ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: C.successBg, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="task" size={13} color={C.success} strokeWidth={2.4} />
              </View>
              <Text style={[{ fontSize: 15, color: C.ink, flex: 1 }, weight(500)]}>{doneLine}</Text>
            </View>
          ) : (
            <View>
              <Text style={[type.body, { color: C.ink }]}>{followOn.line}</Text>
              <Pressable
                onPress={() => {
                  if (outcome === 'order') return router.push('/order?from=visit');
                  if (outcome === 'payment') return router.push('/pay?from=visit');
                  setDraft({});
                  setFormErr(null);
                  setForm(outcome === 'complaint' ? 'complaint' : 'sample');
                }}
                style={{ width: '100%', height: 52, marginTop: 12, borderRadius: radius.xl, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', boxShadow: shadow.primaryLift }}>
                <Text style={[{ fontSize: 16, color: '#FFFFFF' }, weight(600)]}>{followOn.cta}</Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : null}

      {/* ---- come back on ---- */}
      <Card style={{ marginTop: 12 }}>
        <Text style={[type.label, { marginBottom: 6 }]}>Come back on</Text>
        <Pressable
          onPress={() => setCalOpen('next')}
          style={{ width: '100%', height: 52, borderWidth: 1, borderColor: C.border, borderRadius: radius.sm, paddingHorizontal: 12, justifyContent: 'center', backgroundColor: C.surface }}>
          <Text style={{ fontSize: 15, color: C.ink }}>{pretty(nextDate)}</Text>
        </Pressable>
        <Text style={[type.caption, { marginTop: 8 }]}>
          {c?.cycleDays
            ? 'Suggested from their ' + c.cycleDays + '-day buying pattern. Change it if they said otherwise.'
            : 'Change it if they said otherwise.'}
        </Text>
      </Card>

      {/* ---- what is missing, and why the rule exists ---- */}
      <View
        style={{
          borderWidth: 1,
          borderColor: verdict.verified ? C.hairline : C.warnEdge,
          backgroundColor: verdict.verified ? C.surface : C.warnBg,
          borderRadius: radius.xl,
          paddingVertical: 14,
          paddingHorizontal: 16,
          marginTop: 16,
          boxShadow: shadow.soft,
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>{verdict.title}</Text>
          {verdict.verified ? <Text style={[{ fontSize: 13, color: C.success }, weight(500)]}>Ready</Text> : null}
        </View>

        <View style={{ marginTop: 6 }}>
          {checks.map((k, i) => (
            <View key={k.key} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: C.wash }}>
              <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: k.ok ? C.successBg : C.dangerBg }}>
                {k.ok ? (
                  <Icon name="task" size={12} color={C.success} strokeWidth={2.4} />
                ) : (
                  <Text style={[{ fontSize: 12, color: C.danger }, weight(600)]}>!</Text>
                )}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[{ fontSize: 14, color: k.ok ? C.ink : C.danger }, weight(k.ok ? 400 : 500)]}>{k.line}</Text>
                {!k.ok ? <Text style={[type.caption, { marginTop: 2 }]}>{k.why}</Text> : null}
              </View>
            </View>
          ))}
        </View>

        {/* The override is logged, not hidden. Nobody parks outside and fakes it. */}
        <Pressable
          onPress={() =>
            askConfirm({
              title: 'Save anyway?',
              body: verdict.overrideBody,
              reasonLabel: 'Why · required',
              confirmLabel: 'Save unverified',
              run: (reason) => {
                set({ overrodeReason: reason });
                void saveAndGo(elapsedLabel(dwellSeconds), reason);
              },
            })
          }
          style={{ width: '100%', minHeight: HIT, marginTop: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: C.faint, borderRadius: radius.md, paddingVertical: 8, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, textAlign: 'center' }}>
            Cannot meet these? Save it unverified — your manager sees the reason.
          </Text>
        </Pressable>
      </View>

      <View style={{ height: 96 }} />

      {/* ---- complaint, logged without leaving the visit ---- */}
      <BottomSheet open={form === 'complaint'} onClose={() => setForm(null)} scroll>
        <Text style={[type.h2, { letterSpacing: -0.285 }]}>Log a complaint</Text>
        <Text style={[type.small, { color: C.muted, marginTop: 2 }]}>{(c?.name ?? '') + ' · goes to the desk team today'}</Text>

        <Text style={[type.label, { marginTop: 16, marginBottom: 8 }]}>What is it about</Text>
        {COMPLAINT_CATEGORIES.map((x) => (
          <Choice
            key={x}
            label={x}
            selected={draft.cat === x}
            onPress={() => { setDraft({ ...draft, cat: x }); setFormErr(null); }}
            style={{ width: '100%', alignItems: 'flex-start', marginBottom: 8, paddingHorizontal: 14 }}
          />
        ))}
        {formErr === 'cat' ? <Text style={{ fontSize: 13, color: C.danger }}>Pick what it is about.</Text> : null}

        <Text style={[type.label, { marginTop: 14, marginBottom: 6 }]}>In their words</Text>
        <TextInput
          value={draft.what ?? ''}
          onChangeText={(v) => { setDraft({ ...draft, what: v }); setFormErr(null); }}
          multiline
          placeholder="Two drums arrived dented and he refused them"
          placeholderTextColor={C.faint}
          style={{ width: '100%', minHeight: 90, padding: 12, borderWidth: 1, borderColor: formErr === 'what' ? C.danger : C.border, borderRadius: radius.lg, fontSize: 15, color: C.ink, textAlignVertical: 'top' }}
        />
        {formErr === 'what' ? (
          <Text style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Write what the customer actually said.</Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <Pressable onPress={() => setForm(null)} style={{ flex: 1, height: 52, borderWidth: 1, borderColor: C.border, borderRadius: radius.xl, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[{ fontSize: 16, color: C.body }, weight(500)]}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={async () => {
              if (!draft.cat) return setFormErr('cat');
              if (!(draft.what ?? '').trim()) return setFormErr('what');
              if (!c) return;
              const id = await logComplaint({
                customerId: c.id,
                category: draft.cat,
                description: draft.what.trim(),
              });
              setLinked((l) => ({ ...l, complaintId: id }));
              markVisitDone('complaint', draft.cat + ' · with the desk team');
              setForm(null);
              setDraft({});
              notify('Complaint logged · the desk team sees it today');
            }}
            style={{ flex: 1, height: 52, borderRadius: radius.xl, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', boxShadow: shadow.primaryLift }}>
            <Text style={[{ fontSize: 16, color: '#FFFFFF' }, weight(600)]}>Log it</Text>
          </Pressable>
        </View>
      </BottomSheet>

      {/* ---- sample request ---- */}
      <BottomSheet open={form === 'sample'} onClose={() => setForm(null)} scroll>
        <Text style={[type.h2, { letterSpacing: -0.285 }]}>Request a sample</Text>
        <Text style={[type.small, { color: C.muted, marginTop: 2 }]}>{c?.name ?? ''}</Text>

        <Text style={[type.label, { marginTop: 16, marginBottom: 8 }]}>Which product</Text>
        {products.map((x) => (
          <Choice
            key={x.id}
            label={x.name}
            selected={draft.sku === x.id}
            onPress={() => { setDraft({ ...draft, sku: x.id, skuName: x.name }); setFormErr(null); }}
            style={{ width: '100%', alignItems: 'flex-start', marginBottom: 8, paddingHorizontal: 14 }}
          />
        ))}
        {formErr === 'sku' ? <Text style={{ fontSize: 13, color: C.danger }}>Pick the product he wants to try.</Text> : null}

        <Text style={[type.label, { marginTop: 14, marginBottom: 6 }]}>Why he wants it</Text>
        <TextInput
          value={draft.why ?? ''}
          onChangeText={(v) => { setDraft({ ...draft, why: v }); setFormErr(null); }}
          multiline
          placeholder="Comparing against what he buys from Asian"
          placeholderTextColor={C.faint}
          style={{ width: '100%', minHeight: 80, padding: 12, borderWidth: 1, borderColor: formErr === 'why' ? C.danger : C.border, borderRadius: radius.lg, fontSize: 15, color: C.ink, textAlignVertical: 'top' }}
        />
        {formErr === 'why' ? (
          <Text style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Your manager approves on this reason.</Text>
        ) : null}

        <Text style={[type.label, { marginTop: 14, marginBottom: 6 }]}>Come back on</Text>
        <Pressable
          onPress={() => setCalOpen('trial')}
          style={{ width: '100%', height: 52, borderWidth: 1, borderColor: C.border, borderRadius: radius.lg, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: C.surface }}>
          <Text style={{ fontSize: 16, color: C.ink }}>{pretty(draft.trial ?? defaultTrial())}</Text>
        </Pressable>

        <Text style={[type.caption, { marginTop: 10 }]}>
          Samples need your manager’s approval. The trial follow-up is set for you.
        </Text>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <Pressable onPress={() => setForm(null)} style={{ flex: 1, height: 52, borderWidth: 1, borderColor: C.border, borderRadius: radius.xl, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[{ fontSize: 16, color: C.body }, weight(500)]}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={async () => {
              if (!draft.sku) return setFormErr('sku');
              if (!(draft.why ?? '').trim()) return setFormErr('why');
              if (!c) return;
              const trial = draft.trial ?? defaultTrial();
              const id = await requestSample({
                customerId: c.id,
                productId: draft.sku,
                productName: draft.skuName ?? '',
                cans: 1,
                reason: draft.why.trim(),
                followUpDate: trial,
              });
              setLinked((l) => ({ ...l, sampleId: id }));
              markVisitDone('sample', (draft.skuName ?? '') + ' · sent for approval');
              setForm(null);
              notify('Sample requested · follow-up set for ' + pretty(trial));
              setDraft({});
            }}
            style={{ flex: 1, height: 52, borderRadius: radius.xl, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', boxShadow: shadow.primaryLift }}>
            <Text style={[{ fontSize: 16, color: '#FFFFFF' }, weight(600)]}>Request it</Text>
          </Pressable>
        </View>
      </BottomSheet>

      {/* ---- the date picker both of the above share ---- */}
      <BottomSheet open={!!calOpen} onClose={() => setCalOpen(null)}>
        <Text style={[{ fontSize: 17, color: C.ink, marginBottom: 10 }, weight(600)]}>
          {calOpen === 'trial' ? 'Trial follow-up' : 'Come back on'}
        </Text>
        <Calendar
          selected={calOpen === 'trial' ? draft.trial ?? defaultTrial() : nextDate}
          onPick={(iso) => {
            if (calOpen === 'trial') setDraft({ ...draft, trial: iso });
            else set({ nextDate: iso });
            setCalOpen(null);
          }}
        />
      </BottomSheet>
    </AppFrame>
  );
}

/** A week out — long enough to have tried it, short enough to still remember. */
function defaultTrial(): string {
  return isoDate(new Date(Date.now() + 7 * 86_400_000));
}
