import { LocalDiskStorageProvider } from "./local-provider";
import type { StorageProvider } from "./types";

// Single swap point: replace with an S3/Cloudinary-backed StorageProvider later without
// touching any call site — every caller only depends on the StorageProvider interface.
export const storage: StorageProvider = new LocalDiskStorageProvider();

export type { StorageProvider, StoredFile } from "./types";
export { UploadValidationError, validateUpload } from "./validate";
export type { UploadKind } from "./validate";
