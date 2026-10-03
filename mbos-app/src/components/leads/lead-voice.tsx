import React from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Card, Choice, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { VoiceField, useDictation, useOnline } from '../ui/dictate';
import { color as C, radius, weight } from '../../theme/tokens';
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
    <Card style={{ marginTop: 12, padding: 14, backgroundColor: C.primaryTint, borderColor: C.primaryEdge }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="mic" size={18} color={C.primaryDeep} />
        <T style={[{ flex: 1, fontSize: 15, color: C.ink }, weight(600)]}>Speak about the shop</T>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10}>
          <Icon name="close" size={18} color={C.muted} />
        </Pressable>
      </View>

      {phase !== 'review' ? (
        <>
          <T s="caption" style={{ marginTop: 4 }}>
            Press the mic and say everything you know, in any language: who you met, the shop, their mobile, the
            town, what they want and how much a month, who they buy from now, when you will come back. Up to{' '}
            {minutes} {minutes === 1 ? 'minute' : 'minutes'} at a time. Press the mic again to add more.
          </T>
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
              style={{ minHeight: 120, textAlignVertical: 'top' }}
            />
          </View>

          {phase === 'reading' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 }}>
              <ActivityIndicator color={C.primaryDeep} />
              <T s="small" style={{ color: C.body }}>
                Filling the form from what you said…
              </T>
            </View>
          ) : (
            <>
              <PrimaryButton
                label="Fill the form from this"
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
                <T s="caption" style={{ marginTop: 8, color: C.warnInk }}>
                  No internet. This needs signal. Type into the form instead.
                </T>
              ) : null}
            </>
          )}
        </>
      ) : values && found ? (
        <>
          <T s="caption" style={{ marginTop: 4 }}>
            Check each answer. Untick anything wrong. Only ticked answers go into the form.
          </T>
          {found.questions.map((q) => (
            <T key={q} s="small" style={{ marginTop: 6, color: C.warnInk }}>
              {'• ' + q}
            </T>
          ))}

          {heard.map((f) => (
            <ReviewRow
              key={f}
              field={f}
              ticked={ticked[f]}
              onTick={() => setTicked((t) => ({ ...t, [f]: !t[f] && !!values[f].trim() }))}
              hint={hintFor(f, found, values, areas) ?? replaces(f, ticked[f], values[f], current[f])}
            >
              {f === 'followUp' ? (
                values.followUp ? (
                  <T style={[{ fontSize: 16, color: C.ink }, weight(500)]}>{dmy(values.followUp)}</T>
                ) : null
              ) : CHOICE_FIELDS.has(f) ? (
                <T style={[{ fontSize: 16, color: C.ink }, weight(500)]}>{choiceWord(f, values[f], lists)}</T>
              ) : (
                <Input
                  value={values[f]}
                  onChangeText={(v) => set(f, v)}
                  placeholder="Not heard"
                  keyboardType={f === 'mobile' ? 'phone-pad' : f === 'potential' || f === 'litres' ? 'number-pad' : 'default'}
                  autoCapitalize={f === 'gstin' ? 'characters' : 'sentences'}
                  multiline={f === 'address' || f === 'requirement'}
                />
              )}
              {f === 'followUp' && found.followUp?.choices.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {found.followUp.choices.map((c) => (
                    <Choice
                      key={c.date}
                      label={c.label}
                      selected={values.followUp === c.date}
                      onPress={() => set('followUp', c.date)}
                      style={{ paddingHorizontal: 10, minHeight: 36 }}
                    />
                  ))}
                </View>
              ) : null}
              {f === 'mobile' && found.otherNumbers.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {found.otherNumbers.map((n) => (
                    <Choice
                      key={n}
                      label={n}
                      selected={values.mobile === n}
                      onPress={() => set('mobile', n)}
                      style={{ paddingHorizontal: 10, minHeight: 36 }}
                    />
                  ))}
                </View>
              ) : null}
            </ReviewRow>
          ))}

          {/* WHAT WAS NOT HEARD, named — a gap he can see is one he can fill,
              and one he cannot see is one he assumes was taken care of. */}
          {missed.length ? (
            <T s="caption" style={{ marginTop: 14 }}>
              {'Not heard, fill in the form if you know: ' + missed.map((f) => VOICE_FIELD_LABEL[f]).join(', ') + '.'}
            </T>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <SecondaryButton
              label="Change what I said"
              onPress={() => {
                setPhase('speak');
                setFound(null);
                setValues(null);
              }}
              style={{ flex: 1, borderRadius: radius.xl }}
            />
            <PrimaryButton
              label="Fill the form"
              onPress={() => onFill(voiceFill({ values, ticked, found, areas }))}
              disabled={!anyTicked}
              whyDisabled="Tick at least one answer to fill."
              style={{ flex: 1, borderRadius: radius.xl }}
            />
          </View>
        </>
      ) : null}

      {error ? (
        <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 10 }}>
          <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{error}</T>
        </View>
      ) : null}
    </Card>
  );
}

function ReviewRow({
  field,
  ticked,
  onTick,
  hint,
  children,
}: {
  field: LeadVoiceField;
  ticked: boolean;
  onTick: () => void;
  hint: { text: string; warn: boolean } | null;
  children?: React.ReactNode;
}) {
  return (
    <View style={{ marginTop: 12 }}>
      <Pressable
        onPress={onTick}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: ticked }}
        accessibilityLabel={`Use ${VOICE_FIELD_LABEL[field]}`}
        hitSlop={6}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 5,
            borderWidth: 1.5,
            borderColor: ticked ? C.primary : C.border,
            backgroundColor: ticked ? C.primary : C.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          {ticked ? <Icon name="tick" size={14} color={C.surface} strokeWidth={2.4} /> : null}
        </View>
        <SectionLabel>{VOICE_FIELD_LABEL[field]}</SectionLabel>
      </Pressable>
      {children}
      {hint ? (
        <T s="caption" style={{ marginTop: 4, color: hint.warn ? C.warnInk : C.muted }}>
          {hint.text}
        </T>
      ) : null}
    </View>
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
