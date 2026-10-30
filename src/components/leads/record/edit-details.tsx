"use client";

import { useRouter } from "next/navigation";

import { Button } from "@/components/console/parts";

/**
 * EDIT THE LEAD'S BASICS — the Sales Manager's six-field form.
 *
 * The unified record had no edit of its own, and the Sales Manager's record
 * (now retired) did. The form and its write (`editLeadBasics`) already exist
 * and ask the Sales Manager seat again on the server, so this is only the way
 * in; it is drawn for somebody holding that workspace and the page it opens
 * answers 404 for a lead outside their book.
 */
export function EditDetails({ href }: { href: string }) {
  const router = useRouter();
  return (
    <Button size="sm" tone="quiet" title="Edit this lead's name, contact, city and product." onClick={() => router.push(href)}>
      Edit details
    </Button>
  );
}
