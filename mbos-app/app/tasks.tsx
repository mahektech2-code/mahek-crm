import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, DashedButton, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { VoiceField } from '../src/components/ui/dictate';
import { takePhoto } from '../src/native/capture';
import { discardQueuedMedia } from '../src/sync/media';
import { getConfig } from '../src/data/config';
import { useBoot } from '../src/state/boot';
import { color as C, radius, shadow, weight } from '../src/theme/tokens';
import {
  bucketOf,
  completeTask,
  createTask,
  dropTaskDraft,
  listOpenTasks,
  loadTaskDraft,
  saveTaskDraft,
  snoozeTarget,
  snoozeTask,
  taskFormOf,
  type Task,
} from '../src/data/tasks';
import { TaskFormFields } from '../src/components/task-form';
import { cleanTaskAnswers, taskAnswerProblems, taskAnswersNote, type TaskAnswers } from '../src/engines/task-form';
import { customerNames, daysSince, listCustomersPage, type Customer } from '../src/data/customers';
import { dmy, isoDate, plural } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { Stagger, SwipeRow, animateLayoutFor } from '../src/components/ui/motion';

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

/** What a form asks, in one line: "4 questions · 2 photos". */
function formLine(fields: ReturnType<typeof taskFormOf>): string {
  const asks = fields.filter((f) => f.type !== 'info' && f.type !== 'photo').length;
  const photos = fields.filter((f) => f.type === 'photo').length;
  return [
    asks ? plural(asks, 'question') : '',
    photos ? plural(photos, 'photo') + ' to take' : '',
  ]
    .filter(Boolean)
    .join(' · ') || 'Read and confirm';
}

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

  /* DONE ASKS HOW. See `completeTask` — the office refuses a closed task with
     nothing said about it, so the note is asked here, at the one moment the
     salesman still remembers what he did. */
  const boot = useBoot();
  const me = boot.session?.user.id ?? null;
  const [closing, setClosing] = React.useState<Task | null>(null);
  const [doneNote, setDoneNote] = React.useState('');
  const [donePhoto, setDonePhoto] = React.useState<string | null>(null);
  const [doneErr, setDoneErr] = React.useState<string | null>(null);
  const [doneBusy, setDoneBusy] = React.useState(false);
  /* A task the office attached a form to is answered by the form. The
     answers are kept as a draft as they are given, so a form left half done
     opens where he left it. */
  const [answers, setAnswers] = React.useState<TaskAnswers>({});
  const [answerErrs, setAnswerErrs] = React.useState<Map<string, string>>(new Map());
  const closingForm = React.useMemo(() => (closing ? taskFormOf(closing) : []), [closing]);
  const doneLock = React.useRef(false);
  const [noteRequired, setNoteRequired] = React.useState(true);
  React.useEffect(() => {
    void getConfig<boolean>('mbos.tasks.requireCompletionNote', true)
      .then((v) => setNoteRequired(v !== false))
      .catch(() => setNoteRequired(true));
  }, []);

  const [snoozing, setSnoozing] = React.useState<Task | null>(null);
  const [snoozeTo, setSnoozeTo] = React.useState('');
  const [snoozeWhy, setSnoozeWhy] = React.useState('');
  const [snoozeErr, setSnoozeErr] = React.useState<string | null>(null);

  /* `animate` is asked for by the two acts that move a row — done and snooze —
     and not by focus: a screen opening on its list is not that list changing. */
  const load = React.useCallback((animate?: boolean) => {
    let live = true;
    void listOpenTasks().then(async (t) => {
      if (!live) return;
      if (animate === true) animateLayoutFor(t.length);
      setTasks(t);
      const found = await customerNames(t.map((x) => x.customerId ?? '').filter(Boolean));
      if (live) setNames(found);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(React.useCallback(() => load(), [load]));

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

  const openDone = (t: Task) => {
    setClosing(t);
    setDoneNote('');
    setDonePhoto(null);
    setDoneErr(null);
    setAnswerErrs(new Map());
    setAnswers({});
    if (taskFormOf(t).length) void loadTaskDraft(t).then(setAnswers).catch(() => undefined);
  };

  const changeAnswers = (next: TaskAnswers) => {
    setAnswers(next);
    setAnswerErrs(new Map());
    setDoneErr(null);
    if (closing) void saveTaskDraft(closing.id, next).catch(() => undefined);
  };

  const closeDone = () => {
    /* A photograph taken for a task that was then not closed belongs to
       nothing — drop it rather than let it upload as an orphan. */
    if (donePhoto) void discardQueuedMedia(donePhoto).catch(() => undefined);
    setClosing(null);
  };

  const addDonePhoto = async () => {
    if (!closing) return;
    const shot = await takePhoto({ parentType: 'task', parentId: closing.id, kind: 'task_proof' });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') setDoneErr(shot.reason);
      return;
    }
    if (donePhoto) void discardQueuedMedia(donePhoto).catch(() => undefined);
    setDonePhoto(shot.mediaId);
    setDoneErr(null);
  };

  /* The row leaves once the write has landed, not before: a local SQLite
     write is instant, and a row that vanished on a write that then threw
     would come back with nothing on the screen saying why. */
  const markDone = async () => {
    const t = closing;
    if (!t || doneLock.current) return;
    const form = taskFormOf(t);
    let responses: TaskAnswers | null = null;
    let note = doneNote;
    if (form.length) {
      const problems = taskAnswerProblems(form, answers);
      if (problems.length) {
        setAnswerErrs(new Map(problems.map((p) => [p.fieldId, p.message])));
        setDoneErr(problems.length === 1 ? 'One answer is still needed.' : problems.length + ' answers are still needed.');
        return;
      }
      responses = cleanTaskAnswers(form, answers);
      /* The answers are the "how"; a note he adds goes on top of them. */
      const summary = taskAnswersNote(form, responses);
      note = [doneNote.trim(), summary].filter(Boolean).join('\n');
    } else if (noteRequired && !doneNote.trim()) {
      setDoneErr('Say what you did. Your manager reads this.');
      return;
    }
    doneLock.current = true;
    setDoneBusy(true);
    try {
      await completeTask(t.id, { note, photoId: donePhoto, responses });
      if (responses) void dropTaskDraft(t.id);
      animateLayoutFor(tasks.length);
      setClosing(null);
      notify('Done · ' + t.title);
    } catch (e) {
      setDoneErr(e instanceof Error && e.message ? e.message : 'Could not save. Try again.');
    } finally {
      doneLock.current = false;
      setDoneBusy(false);
      load();
    }
  };

  const openSnooze = (t: Task) => {
    setSnoozing(t);
    setSnoozeTo(snoozeTarget(t.dueDate, today, 1));
    setSnoozeWhy('');
    setSnoozeErr(null);
  };

  const saveSnooze = async () => {
    const t = snoozing;
    if (!t) return;
    const why = snoozeWhy.trim();
    if (!why) return setSnoozeErr('Say why it is moving. Three moves is a story your manager needs.');
    if (!snoozeTo) return setSnoozeErr('Pick the day it moves to.');
    try {
      /* Both halves are kept: the new day and the reason for it, appended
         rather than replaced, because three snoozes is the story. */
      await snoozeTask(t.id, snoozeTo, why);
      setSnoozing(null);
      load(true);
      notify('Moved to ' + dmy(snoozeTo));
    } catch (e) {
      setSnoozeErr(e instanceof Error && e.message ? e.message : 'Could not save. Try again.');
    }
  };

  return (
    <AppFrame title="Tasks" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <DashedButton label="+ New task" tone="primary" onPress={openForm} />

      {tasks.length === 0 ? (
        <Card style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>Nothing pending</T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            What you promise a customer on a visit shows here.
          </T>
        </Card>
      ) : null}

      {BUCKETS.map((g) => {
        const items = tasks.filter((t) => bucketOf(t.dueDate, today) === g);
        const before = BUCKETS.slice(0, BUCKETS.indexOf(g)).reduce(
          (n, b) => n + tasks.filter((t) => bucketOf(t.dueDate, today) === b).length,
          0,
        );
        if (items.length === 0) return null;
        return (
          <View key={g} style={{ marginTop: 20 }}>
            <SectionLabel style={{ marginBottom: 10 }}>{g}</SectionLabel>
            <View style={{ gap: 10 }}>
              {items.map((t, i) => {
                const edge =
                  t.priority === 'High' ? C.danger : g === 'Overdue' ? C.danger : g === 'Today' ? C.warn : C.border;
                /* Swiping left is a SHORTCUT to the Done button on the row,
                   and opens the same sheet: a closed task has to say how. */
                return (
                  <Stagger key={t.id} index={before + i}>
                    <SwipeRow
                      /* The "Done" toast already buzzes. */
                      buzz={false}
                      right={{ label: taskFormOf(t).length ? 'Answer' : 'Done', color: C.success, run: () => openDone(t) }}
                      style={{ borderRadius: radius.xl, overflow: 'hidden' }}>
                      <View
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
                        {/* The shop, or — for a task that belongs to none — who
                            set it, so the caption line is never left blank. */}
                        <T s="caption" style={{ marginTop: 2 }}>
                          {[
                            nameOf(t.customerId) || (t.customerId ? '' : 'No shop'),
                            t.assignerId && me && t.assignerId !== me ? 'From the office' : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </T>
                        {/* What the office wrote is the half of the task that says
                            what to do — a refusal's reason, a manager's
                            instruction. It was stored and never drawn. */}
                        {t.description ? (
                          <T s="small" style={{ color: C.body, marginTop: 6 }}>{t.description}</T>
                        ) : null}
                        {/* A task with a form says how much it asks before he
                            opens it, so "two questions" and "fifteen questions
                            and four photos" are not the same tap. */}
                        {taskFormOf(t).length ? (
                          <T s="caption" style={{ marginTop: 6, color: C.primary }}>
                            {formLine(taskFormOf(t))}
                          </T>
                        ) : null}

                        {/* A task that ASKS for something specific opens the screen
                            that answers it. Without this the office raises a
                            validation call and the salesman reads a title with
                            nowhere to go — which is how a workflow becomes a list
                            of sentences people tick off without doing. */}
                        {t.sourceType === 'lead_validation' && t.customerId ? (
                          <SecondaryButton
                            label="Call now"
                            onPress={() =>
                              router.push(`/validate?id=${t.customerId}&taskId=${t.id}&from=tasks`)
                            }
                            style={{ marginTop: 10 }}
                          />
                        ) : null}
                        {t.sourceType === 'requirement_visit' && t.customerId ? (
                          <SecondaryButton
                            label="Open shop"
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
                              onPress={() => openSnooze(t)}
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
                              onPress={() => openDone(t)}
                              accessibilityRole="button"
                              style={{
                                height: 48,
                                paddingHorizontal: 14,
                                backgroundColor: C.primary,
                                borderRadius: radius.md,
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}>
                              <T style={[{ fontSize: 15, color: C.surface }, weight(500)]}>
                                {taskFormOf(t).length ? 'Answer' : 'Done'}
                              </T>
                            </Pressable>
                          </View>
                        </View>
                      </View>
                    </SwipeRow>
                  </Stagger>
                );
              })}
            </View>
          </View>
        );
      })}

      <BottomSheet open={formOpen} onClose={() => setFormOpen(false)} scroll>
        <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>New task</T>

        <View style={{ marginTop: 14 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What to do</SectionLabel>
          <Input
            value={title}
            onChangeText={(v) => {
              setTitle(v);
              setTitleErr(false);
            }}
            placeholder="Take the rate list to Balaji"
            invalid={titleErr}
          />
          {titleErr ? <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Write what needs to be done.</T> : null}
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Which customer</SectionLabel>
          <Input
            value={custQuery}
            onChangeText={setCustQuery}
            placeholder="Search your customers by name, area or phone"
          />
          <View style={{ gap: 8, marginTop: 8 }}>
            {/* A job that belongs to nobody in particular is a real task —
                "collect the rate cards from the office" — and a radio list with
                no such row made it unrecordable. It is first because it is also
                the only way to undo a pick. */}
            <Choice
              label="No customer. General work"
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
              <T s="caption">No customer found.</T>
            ) : null}
            {bookTotal > customers.length ? (
              <T s="caption">
                {'Showing ' + customers.length + ' of ' + bookTotal + '. Search to find more.'}
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

      <BottomSheet open={closing !== null} onClose={closeDone} scroll>
        <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>
          {closingForm.length ? 'Answer and finish' : 'Mark as done'}
        </T>
        {closing ? <T s="small" style={{ color: C.muted, marginTop: 4 }}>{closing.title}</T> : null}
        {closing?.description && closingForm.length ? (
          <T s="small" style={{ color: C.body, marginTop: 6 }}>{closing.description}</T>
        ) : null}
        {closing && closingForm.length ? (
          <View style={{ marginTop: 14 }}>
            <TaskFormFields
              taskId={closing.id}
              fields={closingForm}
              answers={answers}
              onChange={changeAnswers}
              problems={answerErrs}
            />
          </View>
        ) : null}
        <View style={{ marginTop: 14 }}>
          <SectionLabel style={{ marginBottom: 6 }}>
            {closingForm.length ? 'Anything else (optional)' : noteRequired ? 'What you did · needed' : 'What you did'}
          </SectionLabel>
          <VoiceField
            value={doneNote}
            onChangeText={(v) => {
              setDoneNote(v);
              setDoneErr(null);
            }}
            placeholder={closingForm.length ? 'Anything the questions did not ask.' : 'Gave them the new rate list. They will order next week.'}
            multiline
            maxLength={2000}
          />
        </View>
        {closingForm.length ? null : (
          <View style={{ marginTop: 12 }}>
            <SecondaryButton label={donePhoto ? 'Photo added. Take it again' : 'Add a photo (optional)'} onPress={() => void addDonePhoto()} />
          </View>
        )}
        {closingForm.length ? (
          <T s="caption" style={{ marginTop: 10 }}>Your answers are kept on the phone if you close this — finish later.</T>
        ) : null}
        {doneErr ? <T style={{ fontSize: 13, color: C.danger, marginTop: 10 }}>{doneErr}</T> : null}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <SecondaryButton label="Cancel" onPress={closeDone} style={{ flex: 1, borderRadius: radius.xl }} />
          <PrimaryButton
            label={doneBusy ? 'Saving…' : closingForm.length ? 'Submit' : 'Done'}
            onPress={() => void markDone()}
            disabled={doneBusy}
            style={{ flex: 1, borderRadius: radius.xl }}
          />
        </View>
      </BottomSheet>

      <BottomSheet open={snoozing !== null} onClose={() => setSnoozing(null)} scroll>
        <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>
          Move to another day
        </T>
        {snoozing ? <T s="small" style={{ color: C.muted, marginTop: 4 }}>{snoozing.title}</T> : null}
        {snoozing ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
            <Choice
              label="Next day"
              selected={snoozeTo === snoozeTarget(snoozing.dueDate, today, 1)}
              onPress={() => setSnoozeTo(snoozeTarget(snoozing.dueDate, today, 1))}
              style={{ flex: 1 }}
            />
            <Choice
              label="A week later"
              selected={snoozeTo === snoozeTarget(snoozing.dueDate, today, 7)}
              onPress={() => setSnoozeTo(snoozeTarget(snoozing.dueDate, today, 7))}
              style={{ flex: 1 }}
            />
          </View>
        ) : null}
        <View style={{ marginTop: 12 }}>
          <Calendar
            selected={snoozeTo}
            onPick={(d) => {
              setSnoozeTo(d);
              setSnoozeErr(null);
            }}
            disabledReason={(d) =>
              snoozing && d <= (snoozing.dueDate > today ? snoozing.dueDate : today)
                ? 'Pick a day after ' + dmy(snoozing.dueDate > today ? snoozing.dueDate : today) + '.'
                : null
            }
          />
        </View>
        <T s="small" style={{ color: C.body, marginTop: 8 }}>{snoozeTo ? 'Moves to ' + dmy(snoozeTo) : ''}</T>
        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Why · needed</SectionLabel>
          <Input
            value={snoozeWhy}
            onChangeText={(v) => {
              setSnoozeWhy(v);
              setSnoozeErr(null);
            }}
            placeholder="Shop was closed today"
          />
        </View>
        {snoozeErr ? <T style={{ fontSize: 13, color: C.danger, marginTop: 10 }}>{snoozeErr}</T> : null}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <SecondaryButton label="Cancel" onPress={() => setSnoozing(null)} style={{ flex: 1, borderRadius: radius.xl }} />
          <PrimaryButton label="Move it" onPress={() => void saveSnooze()} style={{ flex: 1, borderRadius: radius.xl }} />
        </View>
      </BottomSheet>
    </AppFrame>
  );
}
