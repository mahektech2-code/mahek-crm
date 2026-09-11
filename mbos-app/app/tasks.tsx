import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, DashedButton, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { BottomSheet } from '../src/components/ui/overlays';
import { color as C, radius, shadow, weight } from '../src/theme/tokens';
import { bucketOf, completeTask, createTask, listOpenTasks, snoozeTask, type Task } from '../src/data/tasks';
import { customerNames, daysSince, listCustomersPage, type Customer } from '../src/data/customers';
import { dmy, isoDate, plural } from '../src/lib/format';
import { useStore } from '../src/state/store';

/**
 * Tasks, in five buckets.
 *
 * A bucket with nothing in it is not shown at all — an empty "Tomorrow"
 * heading is a line of furniture between the salesman and the work that is
 * actually overdue. Snoozing asks why, because a task pushed back three times
 * is something the manager needs to see rather than a habit the app helps.
 *
 * The buckets are DERIVED from the due date on every render rather than stored
 * on the row: a task written "Today" yesterday is overdue this morning, and
 * that is exactly the morning it matters.
 *
 * IT MUST NAME EVERY BUCKET `bucketOf` CAN RETURN. It listed four of five, so
 * anything more than a week out was filed under `Later` and drawn by no branch
 * at all — and because the list was not empty the empty state was suppressed
 * too, leaving a salesman holding only far-dated work looking at a "+ New task"
 * button over blank space. The office's nurture and reorder tasks are routinely
 * 14 to 30 days out, so that was not an edge case: it was work assigned to him,
 * counting against him, invisible and impossible to complete.
 */

const BUCKETS = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Later'] as const;
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
  const set = useStore((st) => st.set);
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);

  const [tasks, setTasks] = React.useState<Task[]>([]);
  /* THE PICKER IS A PAGE, NOT THE BOOK. This rendered a Choice per customer
     and read every row to do it — the same fault the Customers screen had, on
     a screen nobody had opened with a full book yet. The names on the task
     rows are looked up by id instead, so capping the picker cannot blank
     them. */
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [bookTotal, setBookTotal] = React.useState(0);
  const [names, setNames] = React.useState<Map<string, string>>(new Map());
  const [today] = React.useState(() => isoDate(new Date()));

  const [formOpen, setFormOpen] = React.useState(false);
  const [title, setTitle] = React.useState('');
  /* THE SHOP IS PICKED, NEVER PRE-PICKED. The sheet used to open with
     `customers[0]` already selected — the alphabetically first of a capped
     fifty — and `Choice` is a radio with no way to deselect, so there was no
     way to clear it, no way to reach the fifty-first shop of a thousand, and no
     way to raise a task that belongs to no customer at all. Every task somebody
     added without scrolling was filed against whichever shop sorts first. The
     name is held beside the id so a pick survives the search being typed
     over. */
  const [picked, setPicked] = React.useState<{ id: string; name: string } | null>(null);
  const [custQuery, setCustQuery] = React.useState('');
  const [when, setWhen] = React.useState<(typeof WHENS)[number]>('Today');
  const [pri, setPri] = React.useState<(typeof PRIS)[number]>('Normal');
  const [titleErr, setTitleErr] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    void listOpenTasks().then(async (t) => {
      if (!live) return;
      setTasks(t);
      const found = await customerNames(t.map((x) => x.customerId ?? '').filter(Boolean));
      if (live) setNames(found);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  /* The book is read by the SEARCH rather than once on focus, which is what
     makes a shop past the first page reachable at all. An empty query is the
     same first page this always showed. */
  React.useEffect(() => {
    let live = true;
    void listCustomersPage({ query: custQuery.trim() || undefined, limit: 50 }).then((page) => {
      if (!live) return;
      setCustomers(page.rows);
      setBookTotal(page.total);
    });
    return () => {
      live = false;
    };
  }, [custQuery]);

  const nameOf = (id: string | null) => (id ? (names.get(id) ?? '') : '');

  const openForm = () => {
    setTitle('');
    setPicked(null);
    setCustQuery('');
    setWhen('Today');
    setPri('Normal');
    setTitleErr(false);
    setFormOpen(true);
  };

  const save = async () => {
    const t = title.trim();
    if (!t) return setTitleErr(true);
    await createTask({ title: t, customerId: picked?.id ?? null, priority: pri, dueDate: dateFor(when, today) });
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

                    {/* A task that ASKS for something specific opens the screen
                        that answers it. Without this the office raises a
                        validation call and the salesman reads a title with
                        nowhere to go — which is how a workflow becomes a list
                        of sentences people tick off without doing. */}
                    {t.sourceType === 'lead_validation' && t.customerId ? (
                      <SecondaryButton
                        label="Make the call"
                        onPress={() =>
                          router.push(`/validate?id=${t.customerId}&taskId=${t.id}&from=tasks`)
                        }
                        style={{ marginTop: 10 }}
                      />
                    ) : null}
                    {t.sourceType === 'requirement_visit' && t.customerId ? (
                      <SecondaryButton
                        label="Open the shop"
                        onPress={() => {
                          set({ custId: t.customerId ?? undefined, pTab: 0 });
                          router.push('/customer');
                        }}
                        style={{ marginTop: 10 }}
                      />
                    ) : null}
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        marginTop: 12,
                      }}>
                      <T style={[{ fontSize: 13, color: g === 'Overdue' ? C.danger : C.muted }, weight(500)]}>
                        {/* A heading of "Later" says nothing a man planning a
                            week can use, so anything past tomorrow prints its
                            own date instead of repeating the bucket's name. */}
                        {g === 'Overdue'
                          ? 'Overdue by ' + plural(daysSince(t.dueDate, today) ?? 0, 'day')
                          : g === 'This week' || g === 'Later'
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
          <Input
            value={custQuery}
            onChangeText={setCustQuery}
            placeholder="Search your book by name, area or phone"
          />
          <View style={{ gap: 8, marginTop: 8 }}>
            {/* A job that belongs to nobody in particular is a real task —
                "collect the rate cards from the office" — and a radio list with
                no such row made it unrecordable. It is first because it is also
                the only way to undo a pick. */}
            <Choice
              label="No customer — a general job"
              selected={picked === null}
              onPress={() => setPicked(null)}
            />
            {/* A pick made before the search was typed stays on screen and
                stays chosen, even once it has fallen out of the results. */}
            {picked && !customers.some((c) => c.id === picked.id) ? (
              <Choice label={picked.name} selected onPress={() => setPicked(null)} />
            ) : null}
            {customers.map((x) => (
              <Choice
                key={x.id}
                label={x.name}
                sub={[x.area, x.city].filter(Boolean).join(' · ') || undefined}
                selected={picked?.id === x.id}
                onPress={() => setPicked({ id: x.id, name: x.name })}
              />
            ))}
            {custQuery.trim() && customers.length === 0 ? (
              <T s="caption">No shop in your book matches that.</T>
            ) : null}
            {bookTotal > customers.length ? (
              <T s="caption">
                {'Showing ' + customers.length + ' of ' + bookTotal + ' — search for the rest.'}
              </T>
            ) : null}
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
