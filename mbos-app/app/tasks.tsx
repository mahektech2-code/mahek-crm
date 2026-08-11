import React from 'react';
import { View, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, DashedButton, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { BottomSheet } from '../src/components/ui/overlays';
import { color as C, radius, shadow, weight } from '../src/theme/tokens';
import { bucketOf, completeTask, createTask, listOpenTasks, snoozeTask, type Task } from '../src/data/tasks';
import { daysSince, listCustomers, type Customer } from '../src/data/customers';
import { dmy, isoDate, plural } from '../src/lib/format';
import { useStore } from '../src/state/store';

/**
 * Tasks, in four buckets.
 *
 * A bucket with nothing in it is not shown at all — an empty "Tomorrow"
 * heading is a line of furniture between the salesman and the work that is
 * actually overdue. Snoozing asks why, because a task pushed back three times
 * is something the manager needs to see rather than a habit the app helps.
 *
 * The buckets are DERIVED from the due date on every render rather than stored
 * on the row: a task written "Today" yesterday is overdue this morning, and
 * that is exactly the morning it matters.
 */

const BUCKETS = ['Overdue', 'Today', 'Tomorrow', 'This week'] as const;
const WHENS = ['Today', 'Tomorrow', 'This week'] as const;
const PRIS = ['Normal', 'High'] as const;

/** The three offers the design makes, as real dates. */
function dateFor(when: (typeof WHENS)[number], today: string): string {
  const base = new Date(today + 'T00:00:00');
  const add = when === 'Today' ? 0 : when === 'Tomorrow' ? 1 : 7;
  base.setDate(base.getDate() + add);
  return isoDate(base);
}

export default function TasksScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);

  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [today] = React.useState(() => isoDate(new Date()));

  const [formOpen, setFormOpen] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [custId, setCustId] = React.useState<string | null>(null);
  const [when, setWhen] = React.useState<(typeof WHENS)[number]>('Today');
  const [pri, setPri] = React.useState<(typeof PRIS)[number]>('Normal');
  const [titleErr, setTitleErr] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([listOpenTasks(), listCustomers()]).then(([t, c]) => {
      if (!live) return;
      setTasks(t);
      setCustomers(c);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  const nameOf = (id: string | null) => customers.find((c) => c.id === id)?.name ?? '';

  const openForm = () => {
    setTitle('');
    setCustId(customers[0]?.id ?? null);
    setWhen('Today');
    setPri('Normal');
    setTitleErr(false);
    setFormOpen(true);
  };

  const save = async () => {
    const t = title.trim();
    if (!t) return setTitleErr(true);
    await createTask({ title: t, customerId: custId, priority: pri, dueDate: dateFor(when, today) });
    setFormOpen(false);
    load();
    notify('Task added · ' + t);
  };

  const markDone = async (t: Task) => {
    await completeTask(t.id, null);
    load();
    notify('Done · ' + t.title);
  };

  const snooze = (t: Task) =>
    askConfirm({
      title: 'Push this to another day?',
      body: t.title + ' · ' + nameOf(t.customerId),
      reasonLabel: 'Why · required',
      confirmLabel: 'Push it back',
      run: (reason) => {
        /* Both halves are kept: the new day and the reason for it, appended
           rather than replaced, because three snoozes is the story. */
        const to = isoDate(new Date(Date.now() + 86_400_000));
        void snoozeTask(t.id, to, reason).then(() => {
          load();
          notify('Moved to tomorrow · ' + reason);
        });
      },
    });

  return (
    <AppFrame title="Tasks" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <DashedButton label="+ New task" tone="primary" onPress={openForm} />

      {tasks.length === 0 ? (
        <Card style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>Nothing outstanding</T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            Anything you promise a customer during a visit lands here.
          </T>
        </Card>
      ) : null}

      {BUCKETS.map((g) => {
        const items = tasks.filter((t) => bucketOf(t.dueDate, today) === g);
        if (items.length === 0) return null;
        return (
          <View key={g} style={{ marginTop: 20 }}>
            <SectionLabel style={{ marginBottom: 10 }}>{g}</SectionLabel>
            <View style={{ gap: 10 }}>
              {items.map((t) => {
                const edge =
                  t.priority === 'High' ? C.danger : g === 'Overdue' ? C.danger : g === 'Today' ? C.warn : C.border;
                return (
                  <View
                    key={t.id}
                    style={{
                      backgroundColor: C.surface,
                      borderWidth: 1,
                      borderColor: C.hairline,
                      borderLeftWidth: 3,
                      borderLeftColor: edge,
                      borderRadius: radius.xl,
                      paddingHorizontal: 16,
                      paddingVertical: 14,
                      boxShadow: shadow.soft,
                    }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                      <T style={[{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: C.ink }, weight(500)]}>
                        {t.title}
                      </T>
                      {t.priority === 'High' ? (
                        <View
                          style={{
                            backgroundColor: C.dangerBg,
                            borderRadius: 10,
                            paddingHorizontal: 8,
                            paddingVertical: 2,
                          }}>
                          <T
                            style={[
                              { fontSize: 11, letterSpacing: 0.33, textTransform: 'uppercase', color: C.danger },
                              weight(600),
                            ]}>
                            High
                          </T>
                        </View>
                      ) : null}
                    </View>
                    <T s="caption" style={{ marginTop: 2 }}>{nameOf(t.customerId)}</T>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        marginTop: 12,
                      }}>
                      <T style={[{ fontSize: 13, color: g === 'Overdue' ? C.danger : C.muted }, weight(500)]}>
                        {g === 'Overdue'
                          ? 'Overdue by ' + plural(daysSince(t.dueDate, today) ?? 0, 'day')
                          : g === 'This week'
                            ? dmy(t.dueDate)
                            : g}
                      </T>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Pressable
                          onPress={() => snooze(t)}
                          accessibilityRole="button"
                          style={{
                            height: 48,
                            paddingHorizontal: 12,
                            borderWidth: 1,
                            borderColor: C.border,
                            backgroundColor: C.surface,
                            borderRadius: radius.md,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}>
                          <T style={{ fontSize: 15, color: C.body }}>Snooze</T>
                        </Pressable>
                        <Pressable
                          onPress={() => markDone(t)}
                          accessibilityRole="button"
                          style={{
                            height: 48,
                            paddingHorizontal: 14,
                            backgroundColor: C.primary,
                            borderRadius: radius.md,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}>
                          <T style={[{ fontSize: 15, color: C.surface }, weight(500)]}>Done</T>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}

      <BottomSheet open={formOpen} onClose={() => setFormOpen(false)} scroll>
        <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>New task</T>

        <View style={{ marginTop: 14 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What needs doing</SectionLabel>
          <Input
            value={title}
            onChangeText={(v) => {
              setTitle(v);
              setTitleErr(false);
            }}
            placeholder="Take the rate list to Balaji"
            invalid={titleErr}
          />
          {titleErr ? <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Say what needs doing.</T> : null}
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Which customer</SectionLabel>
          <View style={{ gap: 8 }}>
            {customers.map((x) => (
              <Choice key={x.id} label={x.name} selected={custId === x.id} onPress={() => setCustId(x.id)} />
            ))}
          </View>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>When</SectionLabel>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {WHENS.map((w) => (
              <Choice key={w} label={w} selected={when === w} onPress={() => setWhen(w)} style={{ flex: 1 }} />
            ))}
          </View>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Priority</SectionLabel>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {PRIS.map((p) => (
              <Choice key={p} label={p} selected={pri === p} onPress={() => setPri(p)} style={{ flex: 1 }} />
            ))}
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <SecondaryButton label="Cancel" onPress={() => setFormOpen(false)} style={{ flex: 1, borderRadius: radius.xl }} />
          <PrimaryButton label="Add task" onPress={save} style={{ flex: 1, borderRadius: radius.xl }} />
        </View>
      </BottomSheet>
    </AppFrame>
  );
}
