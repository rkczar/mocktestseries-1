"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export function ConfirmDeleteButton({
  action,
  itemLabel,
  triggerLabel = "Delete",
  title = "Delete this item?",
  description,
  hiddenFields,
}: {
  action: (formData: FormData) => void | Promise<void>;
  itemLabel: string;
  triggerLabel?: string;
  title?: string;
  description?: string;
  hiddenFields?: Record<string, string>;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <button
            type="button"
            className="rounded-[8px] border border-error-border bg-error-tint px-3 py-1.5 text-[13px] font-bold text-error hover:bg-error/10"
          />
        }
      >
        {triggerLabel}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {description ?? `This permanently removes "${itemLabel}". This can't be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form action={action}>
          {hiddenFields
            ? Object.entries(hiddenFields).map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))
            : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="submit"
              className="bg-error text-white hover:bg-error/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
