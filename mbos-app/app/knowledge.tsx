import React from 'react';
import { View, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, T } from '../src/components/ui/primitives';
import { color as C, type, weight, type BadgeTone } from '../src/theme/tokens';
import { listCourses, type CourseRow } from '../src/data/library';
import { useStore } from '../src/state/store';

/**
 * Training, short enough to do between two shops.
 *
 * Like the document library, this listed four invented modules and admitted it
 * in a caption. The pull carries `courses`, so the real ones are read here and
 * an empty centre says nothing has been published rather than showing a course
 * nobody can open.
 */

export default function KnowledgeScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const [courses, setCourses] = React.useState<CourseRow[] | null>(null);

  useFocusEffect(
    React.useCallback(() => {
      void listCourses().then(setCourses);
    }, []),
  );

  return (
    <AppFrame title="Knowledge centre" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <T style={type.h1}>Knowledge centre</T>
      {/* THE NAG IS GONE, because nothing on this screen can answer it.
          It read "2 modules are due. Your manager sees who has finished." on a
          screen where a module can be neither opened nor ticked off — the
          course's material is not on the wire at all, and `completedAt` is read
          here and written by nobody, in the office or on the phone. So the
          count could never fall, and being chased for work with no way to do it
          and a manager named as watching is worse than not being told. What it
          says instead is what is true: this is the list, and the doing is not
          here yet. It comes back the day something writes a completion. */}
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        What the office has published, and when each is due. Reading a module and
        marking it off are not on the phone yet.
      </T>

      {courses === null ? (
        <Card style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T s="small" style={{ color: C.muted, textAlign: 'center' }}>Looking…</T>
        </Card>
      ) : courses.length === 0 ? (
        <Card style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>Nothing published yet</T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            Training appears here once the office publishes it.
          </T>
        </Card>
      ) : (
        <ListCard style={{ marginTop: 12 }}>
          {courses.map((k, i) => {
            const done = k.completedAt != null;
            const isDue = !done && k.mandatory === 1;
            const tone: BadgeTone = done ? 'success' : isDue ? 'amber' : 'neutral';
            return (
              <Pressable
                key={k.id}
                /* A DURATION CANNOT SAY WHETHER THERE IS ANYTHING TO OPEN, and
                   it was the thing deciding. This chose between "about 20
                   minutes" and "nothing attached to open" on `minutes`, so a
                   course with material and no stated length said there was
                   nothing there, and one with a length and no material said how
                   long it would take and then did nothing at all.

                   The handset cannot answer that question either way:
                   `mbos_courses.attachment_id` exists in the office and is not
                   on the wire, so there is no file reference on this row to
                   branch on. Until it is sent, the tap says the one thing that
                   is true of every row — which is a refusal, and better than a
                   confident wrong sentence about somebody's training. */
                onPress={() => notify(k.title + ' cannot be opened on the phone yet.')}
                accessibilityRole="button"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  borderTopWidth: i ? 1 : 0,
                  borderTopColor: C.wash,
                }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{k.title}</T>
                  <T s="caption">
                    {[k.kind, k.minutes ? k.minutes + ' min' : null, k.deadline ? 'by ' + k.deadline : null]
                      .filter(Boolean)
                      .join(' · ') || 'Course'}
                  </T>
                </View>
                <Badge tone={tone}>{done ? 'Done' : isDue ? 'Due' : 'Not started'}</Badge>
              </Pressable>
            );
          })}
        </ListCard>
      )}
    </AppFrame>
  );
}
