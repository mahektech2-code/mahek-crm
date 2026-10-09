"use client";

import * as React from "react";
import { Card, PageHeader, Td, Th, Tr, EmptyState } from "@/components/ui/primitives";
import { RowMenu, ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { MEDIA, type MediaItem } from "../mock-data";
import { tempFeedback } from "../prototype";

export default function MediaPage() {
  const toast = useToast();
  const [items, setItems] = React.useState<MediaItem[]>(MEDIA);
  const [removing, setRemoving] = React.useState<MediaItem | null>(null);

  return (
    <div className="p-6">
      <PageHeader
        title="Media"
        subtitle="The media library behind every image on the site — files added from Products and Gallery land here."
      />

      <Card className="overflow-x-auto">
        {items.length === 0 ? (
          <EmptyState title="No media" body="Files added from other screens will show up here." />
        ) : (
          <table className="w-full border-collapse" style={{ "--rowh": "48px" } as React.CSSProperties}>
            <thead>
              <tr>
                <Th>File</Th>
                <Th>Kind</Th>
                <Th>Used by</Th>
                <Th>Updated</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <Tr key={m.id}>
                  <Td>{m.filename}</Td>
                  <Td className="capitalize">{m.kind}</Td>
                  <Td>{m.usedBy}</Td>
                  <Td>{m.updatedAt}</Td>
                  <Td align="right">
                    <RowMenu items={[{ label: "Delete", destructive: true, onSelect: () => setRemoving(m) }]} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title="Delete file"
        body={`Delete "${removing?.filename}"? Anything still using it will show a broken image.`}
        destructive
        confirmLabel="Delete"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          setItems((all) => all.filter((m) => m.id !== removing?.id));
          toast.push(tempFeedback("File removed from this list"));
        }}
      />
    </div>
  );
}
