import React from 'react';
import { Pressable, View } from 'react-native';
import { Choice, Input, SecondaryButton, SectionLabel, T } from './ui/primitives';
import { Calendar } from './ui/overlays';
import { VoiceField } from './ui/dictate';
import { pickPhotos, takePhoto } from '../native/capture';
import { getFix } from '../native/location';
import { discardQueuedMedia } from '../sync/media';
import { color as C, radius, weight } from '../theme/tokens';
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
    <View style={{ gap: 16 }}>
      {shown.map((f, i) => (
        <View key={f.id}>
          {f.type === 'info' ? (
            <View
              style={{
                backgroundColor: C.canvas,
                borderRadius: radius.md,
                padding: 12,
                borderLeftWidth: 3,
                borderLeftColor: C.primary,
              }}>
              <T style={[{ fontSize: 14, color: C.ink }, weight(500)]}>{f.label}</T>
              {f.help ? <T s="small" style={{ color: C.body, marginTop: 4 }}>{f.help}</T> : null}
            </View>
          ) : (
            <>
              <SectionLabel style={{ marginBottom: 4 }}>
                {`${i + 1}. ${f.label}${f.required ? ' · needed' : ''}`}
              </SectionLabel>
              {f.help ? <T s="caption" style={{ marginBottom: 6 }}>{f.help}</T> : null}
              {f.showIf ? (
                <T s="caption" style={{ marginBottom: 6, color: C.muted }}>
                  {conditionSentence(f.showIf, fields)}
                </T>
              ) : null}
              <FieldInput taskId={taskId} field={f} value={answers[f.id]} onChange={(v) => set(f.id, v)} />
            </>
          )}
          {problems.get(f.id) ? (
            <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>{problems.get(f.id)}</T>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
          maxLength={f.max ?? 300}
        />
      );
    case 'long_text':
      return (
        <VoiceField
          value={typeof value === 'string' ? value : ''}
          onChangeText={(v) => onChange(v ? v : undefined)}
          multiline
          maxLength={f.max ?? 2000}
        />
      );
    case 'phone':
      return (
        <Input
          value={typeof value === 'string' ? value : ''}
          onChangeText={(v) => onChange(v ? v : undefined)}
          keyboardType="phone-pad"
          maxLength={14}
          placeholder="98xxxxxxxx"
        />
      );
    case 'number':
      return <NumberInput value={value} unit={f.unit} onChange={onChange} />;
    case 'yes_no':
      return (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Choice label="Yes" selected={value === true} onPress={() => onChange(value === true ? undefined : true)} style={{ flex: 1 }} />
          <Choice label="No" selected={value === false} onPress={() => onChange(value === false ? undefined : false)} style={{ flex: 1 }} />
        </View>
      );
    case 'single_choice':
      return (
        <View style={{ gap: 8 }}>
          {(f.options ?? []).map((o) => (
            <Choice key={o} label={o} selected={value === o} onPress={() => onChange(value === o ? undefined : o)} />
          ))}
        </View>
      );
    case 'multi_choice': {
      const picked = Array.isArray(value) ? value : [];
      return (
        <View style={{ gap: 8 }}>
          <T s="caption">Tap every one that applies.</T>
          {(f.options ?? []).map((o) => {
            const on = picked.includes(o);
            return (
              <Choice
                key={o}
                label={(on ? '✓  ' : '') + o}
                selected={on}
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
          {steps.map((n) => (
            <Choice
              key={n}
              label={String(n)}
              selected={value === n}
              onPress={() => onChange(value === n ? undefined : n)}
              style={{ minWidth: 48, flexGrow: 1 }}
            />
          ))}
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

/** Typed as text so a half-typed "12." is not thrown away mid-keystroke. */
function NumberInput({
  value,
  unit,
  onChange,
}: {
  value: TaskAnswer | undefined;
  unit?: string;
  onChange: (v: TaskAnswer | undefined) => void;
}) {
  const [text, setText] = React.useState(typeof value === 'number' ? String(value) : '');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Input
        style={{ flex: 1 }}
        value={text}
        keyboardType="decimal-pad"
        onChangeText={(v) => {
          const clean = v.replace(/[^\d.\-]/g, '');
          setText(clean);
          const n = Number(clean);
          onChange(clean === '' || !Number.isFinite(n) ? undefined : n);
        }}
      />
      {unit ? <T style={{ color: C.muted }}>{unit}</T> : null}
    </View>
  );
}

function DateInput({ value, onChange }: { value?: string; onChange: (v: TaskAnswer | undefined) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <View>
      <SecondaryButton label={value ? dmy(value) + ' · change' : 'Pick a date'} onPress={() => setOpen((o) => !o)} fullWidth />
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
    <View style={{ gap: 8 }}>
      <T s="caption">Month</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {MONTHS.map((m, i) => (
          <Pill key={m} label={m} on={month === i + 1} onPress={() => pick(i + 1, day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][i] ? 0 : day)} />
        ))}
      </View>
      <T s="caption">Day</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {days.map((d) => (
          <Pill key={d} label={String(d)} on={day === d} onPress={() => pick(month, d)} />
        ))}
      </View>
      {value && value.day && value.month ? (
        <T s="small" style={{ color: C.body }}>{`${value.day} ${MONTHS[value.month - 1]}`}</T>
      ) : null}
    </View>
  );
}

function Pill({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={{
        minWidth: 44,
        height: 40,
        paddingHorizontal: 10,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: on ? C.primary : C.border,
        backgroundColor: on ? C.primary : C.surface,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <T style={[{ fontSize: 14, color: on ? C.surface : C.body }, weight(on ? 600 : 400)]}>{label}</T>
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
  const room = max - value.length;

  const camera = async () => {
    const shot = await takePhoto({ parentType: 'task', parentId: taskId, kind: 'task_proof' });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') setErr(shot.reason);
      return;
    }
    setErr(null);
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

  return (
    <View style={{ gap: 8 }}>
      {value.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {value.map((id, i) => (
            <Pressable
              key={id}
              onPress={() => remove(id)}
              accessibilityLabel={'Remove photo ' + (i + 1)}
              style={{
                paddingHorizontal: 10,
                height: 36,
                borderRadius: radius.md,
                backgroundColor: C.successBg,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              <T style={{ fontSize: 13, color: C.success }}>{`Photo ${i + 1} ✓  ✕`}</T>
            </Pressable>
          ))}
        </View>
      ) : null}
      {room > 0 ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <SecondaryButton label="Camera" onPress={() => void camera()} style={{ flex: 1 }} />
          <SecondaryButton label="Gallery" onPress={() => void gallery()} style={{ flex: 1 }} />
        </View>
      ) : null}
      <T s="caption">
        {`${value.length} of ${max} photo${max === 1 ? '' : 's'}${(f.min ?? 0) > 1 ? ` · at least ${f.min}` : ''}. Tap a photo to remove it.`}
      </T>
      {err ? <T style={{ fontSize: 13, color: C.danger }}>{err}</T> : null}
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
  return (
    <View style={{ gap: 6 }}>
      <SecondaryButton
        label={busy ? 'Finding where you are…' : value ? 'Take it again' : 'Use where I am now'}
        onPress={() => void take()}
        fullWidth
      />
      {value ? (
        <T s="small" style={{ color: C.body }}>
          {taskAnswerText({ id: '', type: 'location', label: '' }, value) +
            (value.accuracyM ? ` · within ${value.accuracyM} m` : '')}
        </T>
      ) : null}
      {err ? <T style={{ fontSize: 13, color: C.danger }}>{err}</T> : null}
    </View>
  );
}
