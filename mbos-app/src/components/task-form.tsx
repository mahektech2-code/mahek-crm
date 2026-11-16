import React from 'react';
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Input } from './ui/primitives';
import { Icon } from './ui/Icon';
import { feedback } from './ui/feedback';
import { Calendar } from './ui/overlays';
import { VoiceField } from './ui/dictate';
import { pickPhotos, takePhoto } from '../native/capture';
import { getFix } from '../native/location';
import { discardQueuedMedia } from '../sync/media';
import { color as C, weight } from '../theme/tokens';
import { dmy } from '../lib/format';
import {
  conditionSentence,
  taskAnswerText,
  visibleTaskFields,
  type BirthdayAnswer,
  type LocationAnswer,
  type TaskAnswer,
  type TaskAnswers,
  type TaskField,
} from '../engines/task-form';

/**
 * The office's form, drawn field by field.
 *
 * Nothing here knows what a task is FOR. The Sales Dashboard picked the
 * fields — text, numbers, picks, photographs, a birthday, a place — and this
 * draws exactly those, in order, and hides a field the moment the answer it
 * depends on stops saying so (`visibleTaskFields`, the same rule the office
 * reads the answers back with). Problems are shown under the field they are
 * about, never at the top.
 *
 * Photographs are queued against the TASK the moment they are taken, like
 * every other photograph in this app; one taken and then removed is dropped
 * from the queue rather than uploaded as an orphan.
 */
export function TaskFormFields({
  taskId,
  fields,
  answers,
  onChange,
  problems,
}: {
  taskId: string;
  fields: TaskField[];
  answers: TaskAnswers;
  onChange: (next: TaskAnswers) => void;
  problems: Map<string, string>;
}) {
  const shown = visibleTaskFields(fields, answers);
  const set = (id: string, value: TaskAnswer | undefined) => {
    const next = { ...answers };
    if (value === undefined) delete next[id];
    else next[id] = value;
    onChange(next);
  };

  return (
    <View style={{ gap: 14 }}>
      {shown.map((f, i) => {
        const value = answers[f.id];
        /* What the label carries after its name — the birthday it reads as, how
           many photos of how many, the multi-choice instruction. */
        const extra =
          f.type === 'birthday' && value && typeof value === 'object' && !Array.isArray(value) && 'month' in value && value.day && value.month
            ? { text: '· ' + value.day + ' ' + MONTHS[value.month - 1], ink: C.primaryDeep, w: 600 as const }
            : f.type === 'photo'
              ? {
                  text: '· ' + (Array.isArray(value) ? value.length : 0) + ' of ' + (f.max ?? 1),
                  ink: C.muted,
                  w: 600 as const,
                }
              : f.type === 'multi_choice'
                ? { text: '· tap all that apply', ink: C.muted, w: 500 as const, a11y: 'Tap every one that applies.' }
                : null;
        const label = (
          <Text
            accessibilityLabel={`${i + 1}. ${f.label}${f.required ? ', needed' : ''}${extra ? ' ' + (extra.a11y ?? extra.text) : ''}`}
            style={[{ fontSize: 13, lineHeight: 18, color: C.ink }, weight(700)]}>
            {`${i + 1} · ${f.label}`}
            {f.required ? <Text style={{ color: C.danger }}>{' *'}</Text> : null}
            {extra ? <Text style={[{ color: extra.ink }, weight(extra.w)]}>{' ' + extra.text}</Text> : null}
          </Text>
        );
        return (
          <View key={f.id}>
            {f.type === 'info' ? (
              <View style={{ backgroundColor: '#F7F4FF', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', gap: 10 }}>
                <InfoGlyph />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[{ fontSize: 14, lineHeight: 19, color: C.ink }, weight(700)]}>{f.label}</Text>
                  {f.help ? <Text style={{ fontSize: 13, lineHeight: 18, color: C.body, marginTop: 2 }}>{f.help}</Text> : null}
                </View>
              </View>
            ) : f.type === 'yes_no' ? (
              /* A yes or no sits on its own line beside its question, the way
                 V3 draws it — the two are one glance. */
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>{label}</View>
                  <FieldInput taskId={taskId} field={f} value={value} onChange={(v) => set(f.id, v)} />
                </View>
                <Notes field={f} fields={fields} />
              </>
            ) : (
              <>
                {label}
                <Notes field={f} fields={fields} />
                <View style={{ marginTop: 6 }}>
                  <FieldInput taskId={taskId} field={f} value={value} onChange={(v) => set(f.id, v)} />
                </View>
              </>
            )}
            {problems.get(f.id) ? (
              <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger, marginTop: 4 }, weight(600)]}>{problems.get(f.id)}</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** The help line and the "Only when…" condition under a question's label. */
function Notes({ field: f, fields }: { field: TaskField; fields: TaskField[] }) {
  return (
    <>
      {f.help ? <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 2 }}>{f.help}</Text> : null}
      {f.showIf ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
          <Svg width={12} height={12} viewBox="0 0 24 24" fill="none">
            <Path d="M7 7h10v10M7 17L17 7" stroke={C.muted} strokeWidth={2} strokeLinecap="round" />
          </Svg>
          <Text style={{ flex: 1, fontSize: 11, lineHeight: 15, color: C.muted }}>{conditionSentence(f.showIf, fields)}</Text>
        </View>
      ) : null}
    </>
  );
}

function InfoGlyph() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v5M12 8h.01" stroke={C.primaryDeep} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

/** The wash pill every typed answer is written into. */
const BOX = { backgroundColor: C.canvas, borderWidth: 0, borderRadius: 24, minHeight: 48, fontSize: 15, paddingHorizontal: 16 } as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function FieldInput({
  taskId,
  field: f,
  value,
  onChange,
}: {
  taskId: string;
  field: TaskField;
  value: TaskAnswer | undefined;
  onChange: (v: TaskAnswer | undefined) => void;
}) {
  switch (f.type) {
    case 'short_text':
      return (
        <Input
          value={typeof value === 'string' ? value : ''}
          onChangeText={(v) => onChange(v ? v : undefined)}
          accessibilityLabel={f.label}
          maxLength={f.max ?? 300}
          style={BOX}
        />
      );
    case 'long_text':
      return (
        <VoiceField
          value={typeof value === 'string' ? value : ''}
          onChangeText={(v) => onChange(v ? v : undefined)}
          accessibilityLabel={f.label}
          multiline
          maxLength={f.max ?? 2000}
          style={{ backgroundColor: C.canvas, borderWidth: 0, borderRadius: 20, minHeight: 72, fontSize: 15, paddingHorizontal: 16 }}
        />
      );
    case 'phone':
      return (
        <View style={{ justifyContent: 'center' }}>
          <View style={{ position: 'absolute', left: 16, zIndex: 1 }}>
            <Icon name="call" size={16} color={C.muted} strokeWidth={2} />
          </View>
          <Input
            value={typeof value === 'string' ? value : ''}
            onChangeText={(v) => onChange(v ? v : undefined)}
            accessibilityLabel={f.label}
            keyboardType="phone-pad"
            maxLength={14}
            placeholder="98xxxxxxxx"
            style={[BOX, { paddingLeft: 40 }]}
          />
        </View>
      );
    case 'number':
      return <NumberInput label={f.label} value={value} unit={f.unit} onChange={onChange} />;
    case 'yes_no':
      return (
        <View
          accessibilityRole="radiogroup"
          style={{ height: 44, borderRadius: 22, backgroundColor: C.canvas, padding: 4, flexDirection: 'row', gap: 4 }}>
          {([true, false] as const).map((b) => {
            const on = value === b;
            return (
              <Pressable
                key={String(b)}
                onPress={() => {
                  if (!on) feedback('select');
                  onChange(on ? undefined : b);
                }}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={b ? 'Yes' : 'No'}
                hitSlop={{ top: 4, bottom: 4 }}
                style={{ width: 56, borderRadius: 18, backgroundColor: on ? C.navy : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={[{ fontSize: 14, color: on ? '#FFFFFF' : C.ink }, weight(on ? 700 : 600)]}>{b ? 'Yes' : 'No'}</Text>
              </Pressable>
            );
          })}
        </View>
      );
    case 'single_choice':
      return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(f.options ?? []).map((o) => (
            <Chip key={o} label={o} on={value === o} height={40} role="radio" onPress={() => onChange(value === o ? undefined : o)} />
          ))}
        </View>
      );
    case 'multi_choice': {
      const picked = Array.isArray(value) ? value : [];
      return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(f.options ?? []).map((o) => {
            const on = picked.includes(o);
            return (
              <Chip
                key={o}
                label={o}
                on={on}
                height={36}
                navy
                role="checkbox"
                onPress={() => {
                  const next = on ? picked.filter((p) => p !== o) : [...picked, o];
                  onChange(next.length ? next : undefined);
                }}
              />
            );
          })}
        </View>
      );
    }
    case 'rating': {
      const lo = f.min ?? 1;
      const hi = f.max ?? 5;
      const steps: number[] = [];
      for (let n = lo; n <= hi; n++) steps.push(n);
      return (
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {steps.map((n) => {
            const on = value === n;
            return (
              <Pressable
                key={n}
                onPress={() => {
                  if (!on) feedback('select');
                  onChange(on ? undefined : n);
                }}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={String(n)}
                style={{
                  flexGrow: 1,
                  minWidth: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: on ? C.primary : C.canvas,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                <Text style={[{ fontSize: 15, color: on ? '#FFFFFF' : C.ink }, weight(700)]}>{String(n)}</Text>
              </Pressable>
            );
          })}
        </View>
      );
    }
    case 'date':
      return <DateInput value={typeof value === 'string' ? value : undefined} onChange={onChange} />;
    case 'birthday':
      return <BirthdayInput value={value as BirthdayAnswer | undefined} onChange={onChange} />;
    case 'photo':
      return <PhotoInput taskId={taskId} field={f} value={Array.isArray(value) ? value : []} onChange={onChange} />;
    case 'location':
      return <LocationInput value={value as LocationAnswer | undefined} onChange={onChange} />;
    case 'info':
      return null;
  }
}

/** A pickable pill. Navy-with-a-tick is the multi-choice look; primary is the rest. */
function Chip({
  label,
  on,
  onPress,
  height,
  navy = false,
  role,
  a11y,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  height: number;
  navy?: boolean;
  role: 'radio' | 'checkbox' | 'button';
  a11y?: string;
}) {
  const bg = on ? (navy ? C.navy : C.primary) : C.canvas;
  return (
    <Pressable
      onPress={() => {
        if (!on) feedback('select');
        onPress();
      }}
      accessibilityRole={role}
      accessibilityState={role === 'button' ? { selected: on } : { checked: on }}
      accessibilityLabel={a11y ?? label}
      hitSlop={height < 44 ? { top: (44 - height) / 2, bottom: (44 - height) / 2 } : undefined}
      style={{
        minWidth: height,
        height,
        paddingHorizontal: 14,
        borderRadius: height / 2,
        backgroundColor: bg,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
      }}>
      {on && navy ? <Icon name="tick" size={14} color={C.lime} strokeWidth={2.4} /> : null}
      <Text style={[{ fontSize: 13, color: on ? '#FFFFFF' : C.ink }, weight(700)]}>{label}</Text>
    </Pressable>
  );
}

/** Typed as text so a half-typed "12." is not thrown away mid-keystroke. */
function NumberInput({
  label,
  value,
  unit,
  onChange,
}: {
  label: string;
  value: TaskAnswer | undefined;
  unit?: string;
  onChange: (v: TaskAnswer | undefined) => void;
}) {
  const [text, setText] = React.useState(typeof value === 'number' ? String(value) : '');
  return (
    <View style={{ justifyContent: 'center' }}>
      <Input
        style={[BOX, { fontWeight: '700' }, unit ? { paddingRight: 44 } : null]}
        value={text}
        accessibilityLabel={label + (unit ? ', in ' + unit : '')}
        keyboardType="decimal-pad"
        onChangeText={(v) => {
          const clean = v.replace(/[^\d.\-]/g, '');
          setText(clean);
          const n = Number(clean);
          onChange(clean === '' || !Number.isFinite(n) ? undefined : n);
        }}
      />
      {unit ? (
        <Text pointerEvents="none" style={{ position: 'absolute', right: 16, fontSize: 15, color: C.muted }}>
          {unit}
        </Text>
      ) : null}
    </View>
  );
}

function DateInput({ value, onChange }: { value?: string; onChange: (v: TaskAnswer | undefined) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <View>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={value ? dmy(value) + ', change' : 'Pick a date'}
        style={({ pressed }) => ({
          height: 48,
          borderRadius: 24,
          backgroundColor: value ? C.primaryTint : pressed ? C.hairline : C.canvas,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        })}>
        <Icon name="cal" size={16} color={value ? C.primaryDeep : C.ink} strokeWidth={2} />
        <Text style={[{ fontSize: 14, color: value ? C.primaryDeep : C.ink }, weight(value ? 700 : 600)]}>
          {value ? dmy(value) + ' · change' : 'Pick a date'}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ marginTop: 8 }}>
          <Calendar
            selected={value ?? ''}
            onPick={(d) => {
              onChange(d);
              setOpen(false);
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

/** A day and a month — never a year; nobody at a counter is asked their age. */
function BirthdayInput({ value, onChange }: { value?: BirthdayAnswer; onChange: (v: TaskAnswer | undefined) => void }) {
  const month = value?.month ?? 0;
  const day = value?.day ?? 0;
  const longest = month ? [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] : 31;
  const days: number[] = [];
  for (let d = 1; d <= longest; d++) days.push(d);
  const pick = (m: number, d: number) => onChange(m || d ? { day: d, month: m } : undefined);
  return (
    <View style={{ gap: 6 }}>
      {/* Six months a row and eight days a row, as V3 lays them out. */}
      <View accessibilityLabel="Month">
        <Grid cols={6}>
          {MONTHS.map((m, i) => (
            <DayPill
              key={m}
              label={m}
              a11y={'Month ' + MONTH_NAMES[i]}
              on={month === i + 1}
              onPress={() => pick(i + 1, day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][i] ? 0 : day)}
            />
          ))}
        </Grid>
      </View>
      <View accessibilityLabel="Day">
        <Grid cols={8}>
          {days.map((d) => (
            <DayPill key={d} label={String(d)} a11y={'Day ' + d} on={day === d} onPress={() => pick(month, d)} />
          ))}
        </Grid>
      </View>
      {value && value.day && value.month ? (
        <Text style={[{ fontSize: 13, color: C.primaryDeep }, weight(600)]}>{`${value.day} ${MONTHS[value.month - 1]}`}</Text>
      ) : null}
    </View>
  );
}

/** Equal cells, `cols` to a row, the last row padded so its cells keep their width. */
function Grid({ cols, children }: { cols: number; children: React.ReactNode }) {
  const items = React.Children.toArray(children);
  const rows: React.ReactNode[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return (
    <View style={{ gap: 6 }}>
      {rows.map((r, ri) => (
        <View key={ri} style={{ flexDirection: 'row', gap: 6 }}>
          {r.map((c, ci) => (
            <View key={ci} style={{ flex: 1 }}>
              {c}
            </View>
          ))}
          {Array.from({ length: cols - r.length }, (_, k) => (
            <View key={'pad' + k} style={{ flex: 1 }} />
          ))}
        </View>
      ))}
    </View>
  );
}

function DayPill({
  label,
  a11y,
  on,
  onPress,
}: {
  label: string;
  a11y: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ selected: on }}
      hitSlop={{ top: 4, bottom: 4 }}
      style={{
        height: 36,
        borderRadius: 18,
        backgroundColor: on ? C.primary : C.canvas,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text style={[{ fontSize: 13, color: on ? '#FFFFFF' : C.ink }, weight(700)]}>{label}</Text>
    </Pressable>
  );
}

function PhotoInput({
  taskId,
  field: f,
  value,
  onChange,
}: {
  taskId: string;
  field: TaskField;
  value: string[];
  onChange: (v: TaskAnswer | undefined) => void;
}) {
  const max = f.max ?? 1;
  const [err, setErr] = React.useState<string | null>(null);
  /* The picture behind each photo taken here, so the tile can show it. A
     photo kept from an earlier draft, or picked from the gallery, has only
     its id on this phone's form state and is drawn as a numbered tile. */
  const [uris, setUris] = React.useState<Record<string, string>>({});
  const room = max - value.length;

  const camera = async () => {
    const shot = await takePhoto({ parentType: 'task', parentId: taskId, kind: 'task_proof' });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') setErr(shot.reason);
      return;
    }
    setErr(null);
    setUris((u) => ({ ...u, [shot.mediaId]: shot.uri }));
    onChange([...value, shot.mediaId]);
  };
  const gallery = async () => {
    const got = await pickPhotos({ parentType: 'task', parentId: taskId, kind: 'task_proof', max: room });
    if (!got.ok) {
      if (got.reason !== 'cancelled') setErr(got.reason);
      return;
    }
    setErr(null);
    onChange([...value, ...got.picked.map((p) => p.mediaId)].slice(0, max));
  };
  const remove = (id: string) => {
    void discardQueuedMedia(id).catch(() => undefined);
    const next = value.filter((v) => v !== id);
    onChange(next.length ? next : undefined);
  };

  const addTile = (label: string, icon: React.ReactNode, onPress: () => void) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 64,
        height: 64,
        borderRadius: 16,
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderColor: '#B9A6FF',
        backgroundColor: pressed ? C.primaryTint : '#F7F4FF',
        alignItems: 'center',
        justifyContent: 'center',
      })}>
      {icon}
    </Pressable>
  );

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {value.map((id, i) => (
          <Pressable
            key={id}
            onPress={() => remove(id)}
            accessibilityRole="button"
            accessibilityLabel={'Remove photo ' + (i + 1)}
            style={{ width: 64, height: 64 }}>
            {uris[id] ? (
              <Image source={{ uri: uris[id] }} style={{ width: 64, height: 64, borderRadius: 16, backgroundColor: '#DCE3EE' }} />
            ) : (
              <View
                style={{ width: 64, height: 64, borderRadius: 16, backgroundColor: C.successBg, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="tick" size={16} color={C.success} strokeWidth={2.4} />
                <Text style={[{ fontSize: 11, color: C.success }, weight(700)]}>{'Photo ' + (i + 1)}</Text>
              </View>
            )}
            <View
              style={{
                position: 'absolute',
                right: -4,
                top: -4,
                width: 22,
                height: 22,
                borderRadius: 11,
                backgroundColor: C.navy,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              <Icon name="close" size={11} color="#FFFFFF" strokeWidth={2.6} />
            </View>
          </Pressable>
        ))}
        {room > 0 ? (
          <>
            {addTile('Camera', <Icon name="camera" size={22} color={C.primaryDeep} strokeWidth={2} />, () => void camera())}
            {addTile('Gallery', <Icon name="image" size={22} color={C.primaryDeep} strokeWidth={2} />, () => void gallery())}
          </>
        ) : null}
      </View>
      <Text
        accessibilityLabel={`${value.length} of ${max} photo${max === 1 ? '' : 's'}${(f.min ?? 0) > 1 ? ` · at least ${f.min}` : ''}. Tap a photo to remove it.`}
        style={{ fontSize: 11, color: C.muted }}>
        {`${(f.min ?? 0) > 1 ? `At least ${f.min} · ` : ''}${value.length ? 'tap ✕ to remove' : `${value.length} of ${max}`}`}
      </Text>
      {err ? <Text style={[{ fontSize: 12, color: C.danger }, weight(600)]}>{err}</Text> : null}
    </View>
  );
}

function LocationInput({ value, onChange }: { value?: LocationAnswer; onChange: (v: TaskAnswer | undefined) => void }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const take = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await getFix({ accuracyThresholdM: 100, timeoutMs: 15000, precise: true });
      if (r.status === 'ok' || r.status === 'coarse') {
        onChange({ lat: r.fix.lat, lng: r.fix.lng, accuracyM: Math.round(r.fix.accuracyM), at: r.fix.at });
        if (r.status === 'coarse') setErr(r.reason);
      } else setErr(r.reason);
    } finally {
      setBusy(false);
    }
  };
  const label = busy ? 'Finding where you are…' : value ? 'Take it again' : 'Use where I am now';
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Pressable
          onPress={busy ? undefined : () => void take()}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ busy }}
          style={({ pressed }) => ({
            height: 48,
            paddingHorizontal: 14,
            borderRadius: 24,
            backgroundColor: C.navy,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            opacity: pressed ? 0.85 : 1,
          })}>
          {busy ? <ActivityIndicator size="small" color={C.lime} /> : <Icon name="locate" size={16} color={C.lime} strokeWidth={2.2} />}
          <Text style={[{ fontSize: 13, color: '#FFFFFF' }, weight(700)]}>{label}</Text>
        </Pressable>
        {value ? (
          <Text style={[{ flexShrink: 1, fontSize: 12, color: C.success }, weight(600)]}>
            {taskAnswerText({ id: '', type: 'location', label: '' }, value) +
              (value.accuracyM ? ` · within ${value.accuracyM} m` : '')}
          </Text>
        ) : null}
      </View>
      {err ? <Text style={[{ fontSize: 12, color: C.danger }, weight(600)]}>{err}</Text> : null}
    </View>
  );
}
