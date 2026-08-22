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

  const due = courses?.filter((c) => c.completedAt == null && c.mandatory === 1).length ?? 0;

  return (
    <AppFrame title="Knowledge centre" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <T style={type.h1}>Knowledge centre</T>
      {/* The old line said "One module is due" whatever was on the screen. It
          counts now, and says nothing where there is nothing to count. */}
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        {due > 0
          ? `${due} ${due === 1 ? 'module is' : 'modules are'} due. Your manager sees who has finished.`
          : 'Your manager sees who has finished.'}
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
                onPress={() => notify(k.title)}
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
