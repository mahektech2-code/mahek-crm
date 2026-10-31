"use client";

/* ---------------------------------------------------------------------------
 * Our own PDF drawing, for the invoice viewer: pdf.js (the copy unpdf already
 * ships) reads the file in the browser and every page is painted onto a canvas
 * we own. No browser PDF viewer is involved, so there is no download or
 * open-in-a-tab control anywhere. Printing prints PICTURES of the pages from a
 * hidden frame: the browser's print dialog is the only thing it opens.
 * ------------------------------------------------------------------------- */

export type PdfDoc = Awaited<ReturnType<typeof import("unpdf").getDocumentProxy>>;

/** Reads a PDF from one of our own endpoints. The error says what went wrong in words. */
export async function openPdf(url: string): Promise<PdfDoc> {
  const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(res.status === 404 ? "No invoice PDF on this order." : "The invoice could not be opened.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { getDocumentProxy } = await import("unpdf");
  return getDocumentProxy(bytes);
}

type Task = { cancel: () => void; promise: Promise<unknown> };

/**
 * Paints page `n` (1-based) onto `canvas` at `width` CSS pixels, sharp on a
 * high-density screen. A paint still running on the same canvas is cancelled
 * first — two at once is an error in pdf.js.
 */
export async function drawPage(doc: PdfDoc, n: number, canvas: HTMLCanvasElement, width: number): Promise<void> {
  const prev = (canvas as unknown as { __task?: Task }).__task;
  if (prev) prev.cancel();
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (width / base.width) * dpr });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const task = page.render({ canvas, canvasContext: ctx, viewport }) as unknown as Task;
  (canvas as unknown as { __task?: Task }).__task = task;
  try {
    await task.promise;
  } catch (e) {
    if ((e as { name?: string })?.name !== "RenderingCancelledException") throw e;
  }
}

/** Every page of every document as an image, at print quality (about 150 dpi on A4). */
export async function pageImages(docs: PdfDoc[]): Promise<string[]> {
  const out: string[] = [];
  const canvas = document.createElement("canvas");
  for (const doc of docs) {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 1240 / base.width });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await (page.render({ canvas, canvasContext: ctx, viewport }) as unknown as Task).promise;
      out.push(canvas.toDataURL("image/jpeg", 0.92));
    }
  }
  return out;
}

/**
 * Sends the pages to the printer: a hidden frame holds one page per sheet,
 * `copies` times over, and opens the browser's print dialog. The frame is
 * removed once the dialog closes.
 */
export function printImages(images: string[], copies: number): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) return;
  const pages = Array.from({ length: Math.max(1, copies) }, () => images).flat();
  doc.open();
  doc.write(
    `<!doctype html><html><head><title>Invoice</title><style>@page{size:A4;margin:0}html,body{margin:0;padding:0}img{display:block;width:100%;height:auto;page-break-after:always;break-after:page}img:last-child{page-break-after:auto;break-after:auto}</style></head><body>${pages
      .map((src) => `<img src="${src}" alt="">`)
      .join("")}</body></html>`,
  );
  doc.close();
  const win = frame.contentWindow;
  if (!win) return;
  const cleanup = () => setTimeout(() => frame.remove(), 1000);
  win.addEventListener("afterprint", cleanup);
  const go = () => {
    win.focus();
    win.print();
  };
  const imgs = Array.from(doc.images);
  Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => (i.onload = i.onerror = r))))).then(go);
}
