export function StatusBanner({ success, error }: { success?: string; error?: string }) {
  if (!success && !error) return null;

  if (error) {
    return (
      <div className="mb-5 rounded-[10px] border border-error-border bg-error-tint px-4 py-3 text-sm font-semibold text-error">
        {error}
      </div>
    );
  }

  return (
    <div className="mb-5 rounded-[10px] border border-success-border bg-success-tint px-4 py-3 text-sm font-semibold text-success-text">
      {success}
    </div>
  );
}
