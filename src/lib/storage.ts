/**
 * File storage seam. No backend is wired yet — the project has not approved
 * one (Vercel Blob vs. something else is still an open decision). Complaint
 * image uploads call `fileStorage.upload()`; swap `notConfiguredStorage` for
 * a real adapter here once a backend is chosen, and nothing above this file
 * needs to change.
 */
export type UploadedFile = { url: string };

export interface FileStorage {
  upload(file: File): Promise<UploadedFile>;
}

export const notConfiguredStorage: FileStorage = {
  async upload() {
    throw new Error(
      "Image storage is not configured yet. Attach a FileStorage adapter in lib/storage.ts.",
    );
  },
};

export const fileStorage: FileStorage = notConfiguredStorage;
