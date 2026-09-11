export type StoredFile = {
  key: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
};

export type ReadResult = {
  buffer: Buffer;
  mimeType: string;
};

export interface StorageProvider {
  /** Persist a buffer under a generated, collision-safe key and return where it lives. */
  save(input: { buffer: Buffer; originalName: string; mimeType: string }): Promise<StoredFile>;
  /** Remove a previously-saved object. No-ops if the key doesn't exist. */
  delete(key: string): Promise<void>;
  /** Read a previously-saved object back, or null if it doesn't exist. */
  read(key: string): Promise<ReadResult | null>;
}
