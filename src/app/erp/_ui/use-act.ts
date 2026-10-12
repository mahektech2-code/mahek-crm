"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useToast } from "@/components/ui/toast";
import type { Result } from "@/lib/result";

/** The sentence a refused write is reported in, everywhere in the ERP: the first field's own reason, else the refusal. */
export function resultError(r: { error: string; fieldErrors?: { message: string }[] }): string {
  return r.fieldErrors?.[0]?.message ?? r.error;
}

/**
 * The ONE way an ERP button outside a list runs a write: toast the answer,
 * refresh the page. The list's own actions go through `useErpUi().finish`,
 * which reports in the same words.
 */
export function useAct() {
  const router = useRouter();
  const { push } = useToast();
  const [pending, start] = useTransition();
  const run = <T,>(fn: () => Promise<Result<T>>, after?: (r: Result<T>) => void) =>
    new Promise<Result<T>>((resolve) =>
      start(async () => {
        const r = await fn();
        if (r.ok) push(r.message ?? "Saved");
        else push(resultError(r), "error");
        after?.(r);
        router.refresh();
        resolve(r);
      }),
    );
  return { run, pending };
}
