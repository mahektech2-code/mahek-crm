"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Card, Textarea, buttonClass } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/overlays";
import { recordShare, removePoster } from "@/lib/actions/studio";
import { sendPosterTemplate } from "@/lib/actions/studio-inbox";

/* ---------------------------------------------------------------------------
 * GETTING A POSTER OUT OF THE STUDIO, which is the whole point of it.
 *
 * Download saves the file. On a phone, Share hands the picture and the
 * message to the phone's own share sheet — WhatsApp included — which is the
 * only way a web page can put an image INTO a chat. On a desktop there is no
 * such sheet, so "Open WhatsApp" opens the chat with the message written and
 * the person attaches the file they just downloaded; the button says so.
 *
 * Nothing is sent by MahekOne. Every way out is recorded, so the poster's
 * page can say who sent it and when.
 * ------------------------------------------------------------------------- */

export function PosterActions(props: {
  posterId: string;
  imageUrl: string;
  fileName: string;
  caption: string | null;
  whatsappHref: string | null;
  whatsappBlocked: string | null;
  inboxHref?: string | null;
  inboxNote?: string | null;
  templateSend?: boolean;
  canRemove: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [caption, setCaption] = useState(props.caption ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /* Whether the phone has a share sheet is a fact about the browser, not the
     server: read it after hydration so the two first renders agree. */
  const canShareFiles = useSyncExternalStore(
    () => () => {},
    () => "canShare" in navigator,
    () => false,
  );

  const download = async (format: "png" | "jpeg") => {
    void recordShare(props.posterId, "download", format);
    const a = document.createElement("a");
    a.href = `${props.imageUrl}?format=${format}&download=1`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const share = async () => {
    setBusy(true);
    try {
      const blob = await (await fetch(`${props.imageUrl}?format=jpeg`)).blob();
      const file = new File([blob], props.fileName.replace(/\.png$/, ".jpg"), { type: "image/jpeg" });
      if (!navigator.canShare?.({ files: [file] })) {
        toast.push("This browser cannot share a picture. Download it and attach it instead.", "error");
        return;
      }
      await navigator.share({ files: [file], text: caption || undefined });
      await recordShare(props.posterId, "device", "jpeg");
      router.refresh();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) toast.push("Sharing did not finish. Try again, or download it.", "error");
    } finally {
      setBusy(false);
    }
  };

  const templateKey = useRef(`k${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`);
  const sendAsTemplate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await sendPosterTemplate({ posterId: props.posterId, clientKey: templateKey.current });
      if (!r.ok) {
        toast.push(r.error, "error");
        return;
      }
      templateKey.current = `k${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      router.push(`/studio/inbox?c=${encodeURIComponent(r.data.conversationId)}`);
    } catch {
      /* No answer came back: the key is kept, so pressing again cannot send it twice. */
      toast.push("No answer came back, so it is not known whether this went. Check the Inbox before sending it again.", "error");
    } finally {
      setBusy(false);
    }
  };

  const openWhatsapp = async () => {
    if (!props.whatsappHref) return;
    await recordShare(props.posterId, "whatsapp");
    const href = caption ? props.whatsappHref.replace(/\?text=.*$/, `?text=${encodeURIComponent(caption)}`) : props.whatsappHref.replace(/\?text=.*$/, "");
    window.open(href, "_blank", "noopener");
    router.refresh();
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="text-sm font-semibold text-ink">Send it</div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => download("png")}>
          Download PNG
        </Button>
        <Button onClick={() => download("jpeg")}>Download JPG</Button>
        {canShareFiles ? (
          <Button onClick={share} disabled={busy}>
            {busy ? "Preparing…" : "Share…"}
          </Button>
        ) : null}
      </div>
      {props.caption !== null ? (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Message to send with it</span>
          <Textarea rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} />
        </label>
      ) : null}
      {props.inboxHref ? (
        <div>
          <Link href={props.inboxHref} className={buttonClass({ variant: "whatsapp" })}>
            Send in Inbox
          </Link>
          <p className="mt-1.5 text-[12.5px] text-muted">Opens their chat in the WhatsApp Inbox with this poster and message ready. It is sent through Kapso, and you can see when it is delivered and read.</p>
        </div>
      ) : null}
      {props.templateSend ? (
        <div>
          <Button variant="whatsapp" onClick={() => void sendAsTemplate()} disabled={busy}>
            {busy ? "Sending…" : "Send in Inbox"}
          </Button>
          <p className="mt-1.5 text-[12.5px] text-muted">{props.inboxNote}</p>
        </div>
      ) : props.inboxNote ? (
        <p className="text-[12.5px] text-muted">{props.inboxNote}</p>
      ) : null}
      {props.whatsappHref ? (
        <div>
          <Button variant={props.inboxHref || props.templateSend ? "secondary" : "whatsapp"} onClick={openWhatsapp}>
            {props.inboxHref || props.templateSend ? "Open in the WhatsApp app instead" : "Open WhatsApp chat"}
          </Button>
          <p className="mt-1.5 text-[12.5px] text-muted">Opens their chat with the message written. Attach the poster you downloaded, then send — MahekOne sends nothing itself.</p>
        </div>
      ) : props.whatsappBlocked ? (
        <p className="text-[12.5px] text-muted">{props.whatsappBlocked}</p>
      ) : null}
      {props.canRemove ? (
        <div className="border-t border-divider pt-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmRemove(true)}
          >
            Remove from my posters
          </Button>
          <ConfirmDialog
            open={confirmRemove}
            title="Remove this poster?"
            body="It leaves your posters list. Copies already downloaded or sent on WhatsApp are not affected."
            confirmLabel="Remove"
            cancelLabel="Keep it"
            destructive
            onConfirm={async () => {
              const res = await toast.run(removePoster(props.posterId));
              if (res.ok) router.push("/studio/posters");
            }}
            onClose={() => setConfirmRemove(false)}
          />
        </div>
      ) : null}
    </Card>
  );
}
