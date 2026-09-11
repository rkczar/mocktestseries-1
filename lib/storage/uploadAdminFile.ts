import "server-only";

import { prisma } from "@/lib/db";

import { storage } from "./index";
import { type UploadKind, UploadValidationError, validateUpload } from "./validate";

export { UploadValidationError };

/**
 * Validates and persists an admin-uploaded file, recording it in UploadedFile.
 * Returns null if `file` is empty/absent (i.e. the field was optional and left blank).
 */
export async function uploadAdminFile(
  file: File | null | undefined,
  kind: UploadKind,
  uploadedById: string,
) {
  if (!file || file.size === 0) return null;

  validateUpload(kind, { name: file.name, type: file.type, size: file.size });

  const buffer = Buffer.from(await file.arrayBuffer());
  const stored = await storage.save({
    buffer,
    originalName: file.name,
    mimeType: file.type || "application/octet-stream",
  });

  return prisma.uploadedFile.create({
    data: {
      key: stored.key,
      url: stored.url,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      originalName: file.name,
      uploadedById,
    },
  });
}
