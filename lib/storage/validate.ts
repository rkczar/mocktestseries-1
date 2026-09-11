export type UploadKind = "image" | "spreadsheet";

const RULES: Record<
  UploadKind,
  { mimeTypes: string[]; extensions: string[]; maxBytes: number }
> = {
  image: {
    mimeTypes: ["image/png", "image/jpeg", "image/webp"],
    extensions: [".png", ".jpg", ".jpeg", ".webp"],
    maxBytes: 5 * 1024 * 1024,
  },
  spreadsheet: {
    mimeTypes: [
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    extensions: [".csv", ".xls", ".xlsx"],
    maxBytes: 15 * 1024 * 1024,
  },
};

// Extensions that must never be accepted, regardless of kind or reported MIME type.
const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".sh", ".bat", ".cmd", ".com", ".msi", ".dll", ".so", ".dylib",
  ".php", ".phtml", ".js", ".mjs", ".cjs", ".jar", ".py", ".rb", ".pl",
  ".ps1", ".vbs", ".apk", ".app", ".scr", ".htaccess",
]);

export class UploadValidationError extends Error {}

function extname(fileName: string) {
  const i = fileName.lastIndexOf(".");
  return i === -1 ? "" : fileName.slice(i).toLowerCase();
}

export function validateUpload(
  kind: UploadKind,
  file: { name: string; type: string; size: number },
) {
  const ext = extname(file.name);
  if (!ext || BLOCKED_EXTENSIONS.has(ext)) {
    throw new UploadValidationError("This file type is not allowed.");
  }

  const rule = RULES[kind];
  if (!rule.extensions.includes(ext)) {
    throw new UploadValidationError(
      `Expected one of ${rule.extensions.join(", ")} for this upload.`,
    );
  }
  if (file.type && !rule.mimeTypes.includes(file.type)) {
    throw new UploadValidationError("The file's content type doesn't match its extension.");
  }
  if (file.size <= 0) {
    throw new UploadValidationError("The file is empty.");
  }
  if (file.size > rule.maxBytes) {
    throw new UploadValidationError(
      `File is too large — max ${(rule.maxBytes / (1024 * 1024)).toFixed(0)}MB.`,
    );
  }

  return { extension: ext };
}
