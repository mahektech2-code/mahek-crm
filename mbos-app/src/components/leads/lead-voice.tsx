import React from 'react';
import { View, Pressable, ActivityIndicator, Text, TextInput } from 'react-native';
import { PillButton } from '../ui/v3';
import { TickDisc } from './v3-parts';
import { Icon } from '../ui/Icon';
import { VoiceField, useDictation, useOnline } from '../ui/dictate';
import { color as C, weight } from '../../theme/tokens';
import { getConfig } from '../../data/config';
import { leadVoice } from '../../sync/api';
import { dmy } from '../../lib/format';
import type { AreaRule } from '../../engines/lead-areas';
import { matchLocation } from '../../engines/lead-scan';
import {
  CHOICE_FIELDS,
  VOICE_FIELDS,
  VOICE_FIELD_LABEL,
  choiceWord,
  voiceFill,
  voiceValues,
  type LeadVoiceFill,
  type LeadVoiceFound,
  type LeadVoiceField,
  type VoiceLists,
} from '../../engines/lead-voice';

/**
 * SPEAK ABOUT THE SHOP — the whole New lead form from one description.
 *
 * The card scan fills six answers from what is printed. The rest of the form
 * is what he learned standing there — what they buy, how much, from whom, who
 * decides, when to come back — and typing that one-handed on a phone is how
 * fourteen optional fields become fourteen empty ones. So he says it, once,
 * in any language, for up to two minutes a go (`voice.maxSeconds`, the same
 * ceiling as every microphone on the handset), as many goes as he likes.
 *
 * THE DICTATION SHEET IS THE EAR, not a second recorder. It pauses, routes
 * short audio to Sarvam and long audio to OpenAI, and shows him the English
 * to correct BEFORE anything is read — so what is read is words he has
 * already looked at, and a misheard digit is fixed in the box rather than
 * discovered in the form. A second take is ADDED to the box, which is how a
 * description longer than one recording is spoken.
 *
 * NOTHING IS FILLED UNSEEN. What came back is listed with a tick beside each
 * answer, every text answer editable, and only "Fill the form" moves the
 * ticked ones into the form — where "Add lead" is still the only thing that
 * saves. What he did not mention is NAMED, so a gap is something he can see
 * rather than something he assumes was heard.
 *
 * NEEDS SIGNAL, and says so before it is pressed.
 */

export function useLeadVoice(): boolean {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    void getConfig<{ available?: boolean } | null>('mbos.ai.leadVoice', null).then((cfg) => {
      if (live) setOn(cfg?.available === true);
    });
    return () => {
      live = false;
    };
  }, []);
  /* The ear is the dictation sheet, so without it there is nothing to speak
     into — typing a paragraph to have it read back is not what the button
     promises. */
  const dictation = useDictation();
  return on && dictation.available;
}

type Phase = 'speak' | 'reading' | 'review';
type Take = { spoken: string; english: string };

const noneTicked = Object.fromEntries(VOICE_FIELDS.map((f) => [f, false])) as Record<LeadVoiceField, boolean>;

export function LeadVoicePanel({
  areas,
  lists,
  current,
  onFill,
  onClose,
}: {
  areas: AreaRule;
  lists: VoiceLists;
  /* What the form already holds, so an answer about to replace it says so. */
  current: Partial<Record<LeadVoiceField, string>>;
  onFill: (fill: LeadVoiceFill) => void;
  onClose: () => void;
}) {
  const online = useOnline();
  const dictation = useDictation();
  /* One read per press — a second tap before the phase changes would bill a
     second read. A ref, because state is a render away and the tap is not. */
  const reading = React.useRef(false);
  /* Closed mid-read, the answer has nowhere to go. */
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [text, setText] = React.useState('');
  const [takes, setTakes] = React.useState<Take[]>([]);
  const [phase, setPhase] = React.useState<Phase>('speak');
  const [error, setError] = React.useState<string | null>(null);
  const [found, setFound] = React.useState<LeadVoiceFound | null>(null);
  const [values, setValues] = React.useState<Record<LeadVoiceField, string> | null>(null);
  const [ticked, setTicked] = React.useState<Record<LeadVoiceField, boolean>>(noneTicked);

  const minutes = dictation.available ? Math.max(1, Math.round(dictation.maxSeconds / 60)) : 2;

  const read = async () => {
    const said = text.trim();
    if (!said || reading.current) return;
    reading.current = true;
    setPhase('reading');
    setError(null);
    /* The original words go with it only while they still belong to the box:
       a take he has since rewritten by hand describes a note that no longer
       exists, and would argue with the English he corrected. */
    const spoken = takes
      .filter((t) => t.spoken && said.includes(t.english.trim()))
      .map((t) => t.spoken)
      .join('\n');
    const r = await leadVoice({ text: said, spoken }).finally(() => {
      reading.current = false;
    });
    if (!alive.current) return;
    if (!r.ok) {
      setPhase('speak');
      setError(r.error);
      return;
    }
    const v = voiceValues(r, lists);
    setFound(r);
    setValues(v);
    /* Ticked where something was heard — and the GSTIN not ticked when it
       failed its checksum, so a number that cannot be right is filled only by
       somebody who has decided it is. */
    setTicked(
      Object.fromEntries(
        VOICE_FIELDS.map((f) => [f, !!v[f] && !(f === 'gstin' && r.gstinCheck === 'invalid')]),
      ) as Record<LeadVoiceField, boolean>,
    );
    setPhase('review');
  };

  const heard = values ? VOICE_FIELDS.filter((f) => values[f] || (f === 'followUp' && found?.followUp?.choices.length)) : [];
  const missed = values ? VOICE_FIELDS.filter((f) => !heard.includes(f)) : [];
  const anyTicked = values ? VOICE_FIELDS.some((f) => ticked[f] && values[f].trim()) : false;

  const set = (f: LeadVoiceField, v: string) => {
    setValues((x) => (x ? { ...x, [f]: v } : x));
    setTicked((t) => ({ ...t, [f]: !!v.trim() }));
  };

  return (
    <View style={{ borderRadius: 24, padding: 16, backgroundColor: C.surface }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon name="mic" size={20} color={C.primary} strokeWidth={2} />
        <Text accessibilityRole="header" style={[{ flex: 1, fontSize: 16, lineHeight: 21, color: C.ink }, weight(800)]}>
          Speak about the shop
        </Text>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={({ pressed }) => ({
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? C.hairline : C.canvas,
          })}>
          <Icon name="close" size={16} color={C.ink} strokeWidth={2.2} />
        </Pressable>
      </View>

      {phase !== 'review' ? (
        <>
          <Text
            accessibilityLabel={`Press the mic and say everything you know, in any language: who you met, the shop, their mobile, the town, what they want and how much a month, who they buy from now, when you will come back. Up to ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} at a time. Press the mic again to add more.`}
            style={[{ marginTop: 6, fontSize: 12, lineHeight: 17, color: C.muted }, weight(400)]}>
            {`Any language · who, shop, mobile, town, need, litres, brand now, when back · ${minutes} min a go · press mic again to add`}
          </Text>
          <View style={{ marginTop: 10 }}>
            <VoiceField
              value={text}
              onChangeText={(v) => {
                setText(v);
                setError(null);
              }}
              onHeard={(h) => setTakes((t) => [...t, { spoken: h.spoken, english: h.english }])}
              placeholder="Met Ramesh Patil at Shree Ganesh Furniture, Hingna MIDC, Nagpur. Mobile 98220 11001…"
              editable={phase === 'speak'}
              style={{ minHeight: 110, textAlignVertical: 'top', borderRadius: 18, backgroundColor: C.canvas, borderWidth: 0 }}
            />
          </View>

          {phase === 'reading' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 }}>
              <ActivityIndicator color={C.primaryDeep} />
              <Text style={[{ fontSize: 14, lineHeight: 20, color: C.body }, weight(600)]}>Filling the form from what you said…</Text>
            </View>
          ) : (
            <>
              <PillButton
                label="Fill the form from this"
                variant="navy"
                height={52}
                onPress={() => void read()}
                disabled={!online || !text.trim()}
                whyDisabled={
                  !online
                    ? 'No internet. This needs signal. Type into the form instead.'
                    : 'First press the mic and say what you know about the shop.'
                }
                style={{ marginTop: 12 }}
              />
              {!online ? (
                <Text style={[{ marginTop: 8, fontSize: 12, lineHeight: 17, color: C.warnInk }, weight(400)]}>
                  No internet. This needs signal. Type into the form instead.
                </Text>
              ) : null}
            </>
          )}
        </>
      ) : values && found ? (
        <>
          <Text
            accessibilityLabel="Check each answer. Untick anything wrong. Only ticked answers go into the form."
            style={[{ marginTop: 6, fontSize: 12, lineHeight: 17, color: C.muted }, weight(400)]}>
            Review · untick anything wrong
          </Text>
          {found.questions.map((q) => (
            <View
              key={q}
              style={{ marginTop: 6, minHeight: 36, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: C.warnBg, justifyContent: 'center' }}>
              <Text style={[{ fontSize: 12, lineHeight: 16, color: C.warnInk }, weight(600)]}>{'? ' + q}</Text>
            </View>
          ))}

          {heard.map((f, i) => (
            <ReviewRow
              key={f}
              field={f}
              last={i === heard.length - 1}
              ticked={ticked[f]}
              onTick={() => setTicked((t) => ({ ...t, [f]: !t[f] && !!values[f].trim() }))}
              hint={hintFor(f, found, values, areas) ?? replaces(f, ticked[f], values[f], current[f])}
            >
              {f === 'followUp' ? (
                values.followUp ? (
                  <Text style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(600)]}>{dmy(values.followUp)}</Text>
                ) : null
              ) : CHOICE_FIELDS.has(f) ? (
                <Text style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(600)]}>{choiceWord(f, values[f], lists)}</Text>
              ) : (
                <TextInput
                  value={values[f]}
                  onChangeText={(v) => set(f, v)}
                  placeholder="Not heard"
                  placeholderTextColor={C.faint}
                  accessibilityLabel={VOICE_FIELD_LABEL[f]}
                  style={[{ fontSize: 15, lineHeight: 20, color: C.ink, paddingVertical: 2, paddingHorizontal: 0 }, weight(400)]}
                  keyboardType={f === 'mobile' ? 'phone-pad' : f === 'potential' || f === 'litres' ? 'number-pad' : 'default'}
                  autoCapitalize={f === 'gstin' ? 'characters' : 'sentences'}
                  multiline={f === 'address' || f === 'requirement'}
                />
              )}
              {f === 'followUp' && found.followUp?.choices.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {found.followUp.choices.map((c) => (
                    <SmallChip key={c.date} label={c.label} on={values.followUp === c.date} onPress={() => set('followUp', c.date)} />
                  ))}
                </View>
              ) : null}
              {f === 'mobile' && found.otherNumbers.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {found.otherNumbers.map((n) => (
                    <SmallChip key={n} label={n} on={values.mobile === n} onPress={() => set('mobile', n)} />
                  ))}
                </View>
              ) : null}
            </ReviewRow>
          ))}

          {/* WHAT WAS NOT HEARD, named — a gap he can see is one he can fill,
              and one he cannot see is one he assumes was taken care of. */}
          {missed.length ? (
            <Text style={[{ marginTop: 8, fontSize: 12, lineHeight: 17, color: C.muted }, weight(400)]}>
              {'Not heard, fill in the form if you know: ' + missed.map((f) => VOICE_FIELD_LABEL[f]).join(', ') + '.'}
            </Text>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <Pressable
              onPress={() => {
                setPhase('speak');
                setFound(null);
                setValues(null);
              }}
              accessibilityRole="button"
              style={({ pressed }) => ({
                minWidth: 110,
                maxWidth: '45%',
                flexShrink: 1,
                paddingHorizontal: 12,
                minHeight: 52,
                paddingVertical: 8,
                borderRadius: 26,
                backgroundColor: pressed ? C.hairline : C.canvas,
                alignItems: 'center',
                justifyContent: 'center',
              })}>
              <Text style={[{ fontSize: 13, lineHeight: 18, color: C.ink, textAlign: 'center' }, weight(700)]}>Change what I said</Text>
            </Pressable>
            <PillButton
              label="Fill the form"
              variant="navy"
              height={52}
              onPress={() => onFill(voiceFill({ values, ticked, found, areas }))}
              disabled={!anyTicked}
              whyDisabled="Tick at least one answer to fill."
              style={{ flex: 1 }}
            />
          </View>
        </>
      ) : null}

      {error ? (
        <View style={{ marginTop: 10, backgroundColor: C.dangerBg, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 }}>
          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger }, weight(600)]}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

function ReviewRow({
  field,
  ticked,
  onTick,
  hint,
  last,
  children,
}: {
  field: LeadVoiceField;
  ticked: boolean;
  onTick: () => void;
  hint: { text: string; warn: boolean } | null;
  last: boolean;
  children?: React.ReactNode;
}) {
  return (
    <View style={{ paddingVertical: 8, minHeight: 52, borderBottomWidth: last ? 0 : 1, borderBottomColor: C.hairline }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable
          onPress={onTick}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: ticked }}
          accessibilityLabel={`Use ${VOICE_FIELD_LABEL[field]}`}
          hitSlop={10}>
          <TickDisc on={ticked} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[{ fontSize: 11, lineHeight: 15, color: C.faint }, weight(400)]}>{VOICE_FIELD_LABEL[field]}</Text>
          {children}
          {hint ? (
            <Text style={[{ fontSize: 11, lineHeight: 15, color: hint.warn ? C.warnInk : C.success }, weight(400)]}>
              {hint.text}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** A 32 pill to pick one of what was heard — a day, a number. */
function SmallChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      hitSlop={{ top: 6, bottom: 6 }}
      style={{ minHeight: 32, paddingVertical: 4, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: on ? C.navy : C.canvas }}>
      <Text style={[{ fontSize: 12, lineHeight: 17, color: on ? '#FFFFFF' : C.ink }, weight(600)]}>{label}</Text>
    </Pressable>
  );
}

/** The sentence under an answer, where there is something worth saying. */
function hintFor(
  field: LeadVoiceField,
  found: LeadVoiceFound,
  values: Record<LeadVoiceField, string>,
  areas: AreaRule,
): { text: string; warn: boolean } | null {
  if (field === 'gstin' && found.gstin) {
    if (found.gstinCheck === 'invalid') {
      return { text: 'This does not look like a valid GST number. Check it on their bill or board.', warn: true };
    }
    if (found.gstinCheck === 'corrected') return { text: 'Check this against their bill or board.', warn: true };
  }
  if (field === 'mobile' && found.otherNumbers.length) {
    return { text: found.mobile ? 'Other numbers you said are below.' : 'Tap the number that is the mobile.', warn: !found.mobile };
  }
  if (field === 'location' && values.location.trim()) {
    const m = matchLocation(areas, values.location.trim(), found.state);
    if (m?.kind === 'outside') {
      return {
        text: areas.kind === 'none' ? 'No area is set for you yet.' : `${m.city} is not in your area. You can add leads only in your own area.`,
        warn: true,
      };
    }
    if (m?.kind === 'area') return { text: 'Your area: ' + m.area.label, warn: false };
  }
  if (field === 'followUp') {
    if (!values.followUp && found.followUp?.choices.length) return { text: 'Which day? Tap one.', warn: true };
    if (found.followUp?.explanation) return { text: found.followUp.explanation, warn: false };
  }
  if (field === 'source' && found.sourceDetail) return { text: found.sourceDetail, warn: false };
  return null;
}

/** Said where a ticked answer will overwrite something he already typed. */
function replaces(
  field: LeadVoiceField,
  ticked: boolean,
  value: string,
  typed: string | undefined,
): { text: string; warn: boolean } | null {
  const was = typed?.trim();
  if (!ticked || !was || !value.trim() || CHOICE_FIELDS.has(field)) return null;
  const digits = (s: string) => s.replace(/\D/g, '').slice(-10);
  const same = field === 'mobile' ? digits(was) === digits(value) : was.toLowerCase() === value.trim().toLowerCase();
  return same ? null : { text: `Replaces what you typed: ${was}`, warn: true };
}
