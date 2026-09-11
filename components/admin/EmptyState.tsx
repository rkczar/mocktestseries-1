export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="rounded-[12px] border border-dashed border-border-strong bg-surface p-8 text-center">
      <p className="text-sm font-bold text-text-muted">{title}</p>
      {body ? <p className="mt-1.5 text-sm text-text-faint">{body}</p> : null}
    </div>
  );
}
