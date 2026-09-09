import React from 'react';
import { View, Image } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Choice, DashedButton, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { color as C, radius, weight, type BadgeTone } from '../src/theme/tokens';
import {
  cancelSample,
  confirmReceived,
  feedbackFor,
  getSample,
  markDispatched,
  markTried,
  recordFeedback,
  whatIsOwed,
  type FunnelSample,
  type SampleFeedback,
} from '../src/data/lead-samples';
import { getCustomer } from '../src/data/customers';
import { getLead } from '../src/data/leads';
import { takePhoto } from '../src/native/capture';
import { FEEDBACK_FIELDS } from '../src/engines/funnel';
import { dmy, isoDate, plural, pretty } from '../src/lib/format';
import { useStore } from '../src/state/store';

/**
 * One sample, from the godown to what the customer thought of it.
 *
 * Three marks and a review, and they are four separate acts rather than one
 * "update" because §15 chases the gaps between them separately. The screen
 * only ever offers the ONE that is next: a sample still waiting on the office
 * cannot be marked delivered, and offering the button would teach somebody to
 * press it and then wonder why nothing happened.
 *
 * The review is seven answers and not a paragraph. Six of them are named, and
 * every one is a different conversation with a different person afterwards —
 * "dries slow" goes to the works and "dearer than Asian" goes to the office,
 * and a single free-text box holding both can be read back as neither.
 *
 * THERE IS ONE OF THIS SCREEN, and there were briefly two. A second build of
 * it read `data/requests.ts` and drew the same lifecycle in fewer marks —
 * dispatch, delivered, received, trial, a verdict. One route can only open one
 * screen, and this is the one the funnel needs: `sample_feedback` is what the
 * gate in front of Negotiation reads, and only this screen writes it, so
 * keeping the other would have left that rung shut with nothing able to open
 * it. Nothing is lost in the store — every column the other build wrote is
 * still on `samples`, still filled by the pull, and `confirmReceived` still
 * sends `receivedAt` up the wire under the name the office reads.
 */

function toneFor(state: string): BadgeTone {
  switch (state) {
    case 'Converted':
    case 'Reviewed': return 'success';
    case 'Awaiting feedback':
    case 'Tried': return 'amber';
    case 'Requested': return 'info';
    case 'Rejected': return 'danger';
    case 'Cancelled': return 'neutral';
    default: return 'teal';
  }
}

export default function SampleRecord() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? '';
  const back = useCameFrom('samples');
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);

  const [sample, setSample] = React.useState<FunnelSample | null>(null);
  const [review, setReview] = React.useState<SampleFeedback | null>(null);
  const [who, setWho] = React.useState<string>('');
  const [dispatchOpen, setDispatchOpen] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    if (!id) return;
    void Promise.all([getSample(id), feedbackFor(id)]).then(async ([s, f]) => {
      if (!live) return;
      setSample(s);
      setReview(f);
      if (s) {
        const c = await getCustomer(s.customerId);
        const name = c?.name ?? (await getLead(s.customerId).then((l) => (l ? l.company?.trim() || l.name : '')));
        if (live) setWho(name ?? '');
      }
    });
    return () => {
      live = false;
    };
  }, [id]);

  useFocusEffect(load);

  if (!sample) {
    return (
      <AppFrame title="Sample" activeTab={null} onBack={back.go} contentStyle={{ padding: 16 }}>
        <BackLink label={back.label} onPress={back.go} />
        <Card style={{ paddingVertical: 32 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            This sample is not on this phone
          </T>
        </Card>
      </AppFrame>
    );
  }

  const s = sample;
  const owed = whatIsOwed(s);
  const finished = s.state === 'Reviewed' || s.state === 'Converted' || s.state === 'Cancelled' || s.state === 'Rejected';

  return (
    <AppFrame title="Sample" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 19, lineHeight: 25, color: C.ink }, weight(600)]}>{who || 'Unknown shop'}</T>
            <T s="caption" style={{ marginTop: 2 }}>
              {[s.productName, s.cans ? plural(s.cans, 'can') : null].filter(Boolean).join(' · ')}
            </T>
          </View>
          <Badge tone={toneFor(s.state)}>{s.state}</Badge>
        </View>

        {owed ? (
          <T style={[{ fontSize: 15, lineHeight: 21, marginTop: 10, color: C.ink }, weight(500)]}>{owed}</T>
        ) : null}

        <Divider style={{ marginVertical: 12 }} />

        <View style={{ gap: 8 }}>
          <Line label="Asked for" value={pretty(isoDate(new Date(s.requestedAt)))} />
          {s.application ? <Line label="Used on" value={s.application} /> : null}
          {s.dispatchedAt ? <Line label="Sent" value={pretty(isoDate(new Date(s.dispatchedAt)))} /> : null}
          {s.courierDocket ? <Line label="Docket" value={[s.courierName, s.courierDocket].filter(Boolean).join(' · ')} /> : null}
          {s.expectedDeliveryDate ? <Line label="Due there" value={pretty(s.expectedDeliveryDate)} /> : null}
          {s.receivedConfirmedAt ? (
            <Line label="They have it" value={pretty(isoDate(new Date(s.receivedConfirmedAt)))} />
          ) : null}
          {s.cancelReason ? <Line label="Cancelled" value={s.cancelReason} /> : null}
        </View>
      </Card>

      {/* ------------------------------------------------ §15 the next mark */}
      {finished ? null : (
        <View style={{ marginTop: 20, gap: 10 }}>
          <SectionLabel style={{ marginBottom: 0 }}>What happens next</SectionLabel>

          {s.state === 'Requested' ? (
            <Card>
              <T style={{ fontSize: 15, lineHeight: 21, color: C.muted }}>
                The office has to approve it before anything goes out. Nothing for you to do here yet.
              </T>
            </Card>
          ) : null}

          {s.state === 'Approved' ? (
            <PrimaryButton label="It has gone out" onPress={() => setDispatchOpen(true)} />
          ) : null}

          {s.state === 'Dispatched' ? (
            <>
              <PrimaryButton
                label="They have it — confirm with a photo"
                onPress={async () => {
                  const shot = await takePhoto({ parentType: 'sample', parentId: s.id, kind: 'sample_proof' });
                  /* A refused camera or a cancelled picker is not a reason to
                     lose the fact: the delivery is confirmed either way and
                     only the photograph is poorer for it. Every attachment in
                     this app follows that rule. */
                  const r = await confirmReceived(s.id, shot.ok ? shot.mediaId : null);
                  if (!r.ok) return notify(r.message);
                  load();
                  notify(shot.ok ? 'Delivered, with a photo' : 'Delivered — no photo taken');
                }}
              />
              <SecondaryButton
                label="They have it — no photo"
                onPress={async () => {
                  const r = await confirmReceived(s.id, null);
                  if (!r.ok) return notify(r.message);
                  load();
                  notify('Delivered');
                }}
              />
            </>
          ) : null}

          {s.state === 'Awaiting feedback' ? (
            <>
              <PrimaryButton label="Write down what they thought" onPress={() => setReviewOpen(true)} />
              <SecondaryButton
                label="They have tried it — I will ask later"
                onPress={async () => {
                  const r = await markTried(s.id);
                  if (!r.ok) return notify(r.message);
                  load();
                  notify('Tried — the review is what is owed now');
                }}
              />
            </>
          ) : null}

          {s.state === 'Tried' ? (
            <PrimaryButton label="Write down what they thought" onPress={() => setReviewOpen(true)} />
          ) : null}

          <DashedButton
            label="Cancel this sample"
            onPress={() =>
              askConfirm({
                title: 'Cancel this sample?',
                body: 'The record stays with your reason on it. It stops being chased.',
                reasonLabel: 'Why · required',
                confirmLabel: 'Cancel it',
                run: (reason) => {
                  void cancelSample(s.id, reason).then((r) => {
                    if (!r.ok) return notify(r.message);
                    load();
                    notify('Cancelled');
                  });
                },
              })
            }
          />
        </View>
      )}

      {/* ------------------------------------------------- §16 the review */}
      {review ? (
        <View style={{ marginTop: 20 }}>
          <SectionLabel style={{ marginBottom: 10 }}>What they said</SectionLabel>
          <Card>
            <View style={{ gap: 10 }}>
              {FEEDBACK_FIELDS.map((f) => {
                const said = (review as unknown as Record<string, string | null>)[f.id];
                if (!said) return null;
                return (
                  <View key={f.id}>
                    <T s="caption">{f.label}</T>
                    <T style={{ fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 2 }}>{said}</T>
                  </View>
                );
              })}
            </View>
            <Divider style={{ marginVertical: 12 }} />
            <T style={[{ fontSize: 15, color: review.trialOutcome === 'approved' ? C.success : C.ink }, weight(600)]}>
              {review.trialOutcome === 'approved'
                ? 'They were happy with it'
                : review.trialOutcome === 'rejected'
                  ? 'They were not happy with it'
                  : 'No verdict yet'}
            </T>
            {review.photoId ? (
              <T s="caption" style={{ marginTop: 6 }}>A photograph was taken and is queued to upload.</T>
            ) : null}
            <SecondaryButton label="Change it" onPress={() => setReviewOpen(true)} style={{ marginTop: 12 }} />
          </Card>
        </View>
      ) : null}

      <SecondaryButton label="Back to samples" onPress={() => router.replace('/samples')} style={{ marginTop: 20 }} />

      <DispatchSheet
        key={dispatchOpen ? 'd-open' : 'd-shut'}
        open={dispatchOpen}
        onClose={() => setDispatchOpen(false)}
        onSave={async (d) => {
          const r = await markDispatched(s.id, d);
          if (!r.ok) return notify(r.message);
          setDispatchOpen(false);
          load();
          notify('Sent · ' + d.courierDocket);
        }}
      />

      <ReviewSheet
        key={reviewOpen ? 'r-open' : 'r-shut'}
        open={reviewOpen}
        existing={review}
        onClose={() => setReviewOpen(false)}
        onSave={async (fields, outcome, photoId) => {
          const r = await recordFeedback(s.id, { customerId: s.customerId, fields, trialOutcome: outcome, photoId });
          if (!r.ok) return notify(r.message);
          setReviewOpen(false);
          load();
          notify('Written down');
        }}
        onPhoto={async () => {
          const shot = await takePhoto({ parentType: 'sample', parentId: s.id, kind: 'sample_proof' });
          if (!shot.ok) {
            notify(shot.reason === 'cancelled' ? 'No photo taken' : shot.reason);
            return null;
          }
          return { mediaId: shot.mediaId, uri: shot.uri };
        }}
      />
    </AppFrame>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}>
      <T s="caption" style={{ width: 110 }}>{label}</T>
      <T style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink }}>{value}</T>
    </View>
  );
}

/**
 * §15 — the courier and the docket, which are how a sample is traced.
 *
 * Both required, because a dispatch nobody can trace is a sample that will be
 * argued about in a fortnight with nothing to look up. The expected date is
 * what was PROMISED; when it actually lands is a separate mark, made by
 * somebody who saw it there.
 */
function DispatchSheet({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (d: { courierName: string; courierDocket: string; expectedDeliveryDate: string }) => void;
}) {
  const [courier, setCourier] = React.useState('');
  const [docket, setDocket] = React.useState('');
  const [date, setDate] = React.useState<string | null>(null);
  const [cal, setCal] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>It has gone out</T>
      <T s="caption" style={{ marginTop: 2 }}>Who is carrying it, and under what number.</T>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Courier</SectionLabel>
        <Input value={courier} onChangeText={(v) => { setCourier(v); setErr(null); }} placeholder="Gati, VRL, our own vehicle" />
      </View>

      <View style={{ marginTop: 12 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Docket number</SectionLabel>
        <Input value={docket} onChangeText={(v) => { setDocket(v); setErr(null); }} placeholder="The number on the slip" />
      </View>

      <View style={{ marginTop: 12 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Should be there by</SectionLabel>
        <Choice
          label={date ? dmy(date) : 'Pick a day'}
          selected={Boolean(date)}
          onPress={() => setCal(!cal)}
          style={{ alignItems: 'flex-start', paddingHorizontal: 14, minHeight: 52 }}
        />
        {cal ? (
          <View style={{ marginTop: 10 }}>
            <Calendar selected={date ?? ''} onPick={(iso) => { setDate(iso); setCal(false); setErr(null); }} />
          </View>
        ) : null}
      </View>

      {err ? (
        <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }}>
          <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <SecondaryButton label="Cancel" onPress={onClose} style={{ flex: 1, borderRadius: radius.xl }} />
        <PrimaryButton
          label="Sent"
          onPress={() => {
            if (!courier.trim()) return setErr('Who is carrying it?');
            if (!docket.trim()) return setErr('The docket number — without it nobody can trace it.');
            if (!date) return setErr('When should it get there?');
            onSave({ courierName: courier.trim(), courierDocket: docket.trim(), expectedDeliveryDate: date });
          }}
          style={{ flex: 1, borderRadius: radius.xl }}
        />
      </View>
    </BottomSheet>
  );
}

/**
 * §16 — the seven-part review, and the verdict.
 *
 * The verdict is what the gate in front of Negotiation reads, so it is asked
 * here rather than inferred from the words: a review full of praise with the
 * trial still `pending` would leave the rung shut, and a review that read
 * badly and was marked approved would open it. Neither should be guessed from
 * prose.
 *
 * The photograph is a panel, a finish, a can on a shelf — evidence of the
 * trial rather than of the sample. It never blocks the save.
 */
function ReviewSheet({
  open,
  existing,
  onClose,
  onSave,
  onPhoto,
}: {
  open: boolean;
  existing: SampleFeedback | null;
  onClose: () => void;
  onSave: (
    fields: Record<string, string>,
    outcome: 'approved' | 'rejected' | 'pending',
    photoId: string | null,
  ) => void;
  onPhoto: () => Promise<{ mediaId: string; uri: string } | null>;
}) {
  const [fields, setFields] = React.useState<Record<string, string>>(() => {
    const from = (existing ?? {}) as unknown as Record<string, string | null>;
    const out: Record<string, string> = {};
    for (const f of FEEDBACK_FIELDS) out[f.id] = from[f.id] ?? '';
    return out;
  });
  const [outcome, setOutcome] = React.useState<'approved' | 'rejected' | 'pending'>(
    (existing?.trialOutcome as 'approved' | 'rejected' | 'pending') ?? 'pending',
  );
  const [photo, setPhoto] = React.useState<{ mediaId: string; uri: string } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>
        What did they think?
      </T>
      <T s="caption" style={{ marginTop: 2 }}>
        Their words, not a summary. Anything you leave empty stays empty.
      </T>

      {FEEDBACK_FIELDS.map((f) => (
        <View key={f.id} style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>{f.label}</SectionLabel>
          <Input
            value={fields[f.id] ?? ''}
            onChangeText={(v) => { setFields({ ...fields, [f.id]: v }); setErr(null); }}
            placeholder={f.id === 'otherComments' ? 'Anything else worth knowing' : ''}
            multiline={f.id === 'otherComments'}
          />
        </View>
      ))}

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>So — were they happy with it?</SectionLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Choice label="Yes" selected={outcome === 'approved'} onPress={() => setOutcome('approved')} style={{ paddingHorizontal: 16 }} />
          <Choice label="No" selected={outcome === 'rejected'} onPress={() => setOutcome('rejected')} style={{ paddingHorizontal: 16 }} />
          <Choice label="Not decided" selected={outcome === 'pending'} onPress={() => setOutcome('pending')} style={{ paddingHorizontal: 16 }} />
        </View>
        <T s="caption" style={{ marginTop: 6 }}>
          Negotiation does not open until this is a yes. That is the rule, not the screen being awkward.
        </T>
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>A photograph, if there is one</SectionLabel>
        {photo ? (
          <Image source={{ uri: photo.uri }} style={{ width: '100%', height: 160, borderRadius: radius.lg }} resizeMode="cover" />
        ) : null}
        <DashedButton
          label={photo ? 'Take another' : '+ The panel, the finish, the can on his shelf'}
          onPress={async () => {
            const shot = await onPhoto();
            if (shot) setPhoto(shot);
          }}
          style={{ marginTop: photo ? 10 : 0 }}
        />
      </View>

      {err ? (
        <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }}>
          <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <SecondaryButton label="Cancel" onPress={onClose} style={{ flex: 1, borderRadius: radius.xl }} />
        <PrimaryButton
          label="Save the review"
          onPress={() => {
            const any = FEEDBACK_FIELDS.some((f) => (fields[f.id] ?? '').trim());
            if (!any) return setErr('Write down at least one thing they said about it.');
            onSave(fields, outcome, photo?.mediaId ?? null);
          }}
          style={{ flex: 1, borderRadius: radius.xl }}
        />
      </View>
    </BottomSheet>
  );
}
