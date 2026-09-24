"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, Eye, FileSpreadsheet, GripVertical, Image as ImageIcon, ListOrdered, Plus, Replace, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import {
  addMockTestQuestionsAction,
  removeMockTestQuestionsAction,
  reorderMockTestQuestionsAction,
  replaceMockTestQuestionAction,
  type QuestionOpResult,
} from "@/app/admin/(dashboard)/tests/mock/actions";

/** One Question Bank row offered by Add From Question Bank (text is pre-truncated server-side). */
export interface BankQuestion {
  id: string;
  code: string;
  text: string;
  subjectId: string;
  subjectName: string;
  topicId: string | null;
  topicName: string | null;
  subTopicId: string | null;
  subTopicName: string | null;
  year: number | null;
  isPyq: boolean;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  hasImage: boolean;
}

/** A question already attached to the test, with its options for Preview. */
export interface SelectedQuestion extends BankQuestion {
  imageUrl: string | null;
  options: { label: string; text: string; imageUrl: string | null; isCorrect: boolean }[];
}

type Panel = "selected" | "bank";
const PAGE_SIZE = 50;
const MAX_BULK_SELECT = 500;

/**
 * Mock Test → Step 3 Questions. Three obvious ways in: Add From Question
 * Bank (the exam's canonical questions, filtered), Bulk Import Questions
 * (the existing Question Bank importer, opened with this exam + test
 * pre-selected), and View Selected Questions (preview, drag/drop or up/down
 * reorder, remove, replace, search). Every change is persisted immediately
 * by a server action that re-validates exam ownership and rewrites a dense
 * order — the stored order is the order students see.
 */
export function MockQuestionsManager({
  mockTestId,
  examName,
  expected,
  selected,
  bank,
  bulkImportHref,
  readOnly,
}: {
  mockTestId: string;
  examName: string;
  expected: number | null;
  selected: SelectedQuestion[];
  bank: BankQuestion[];
  bulkImportHref: string;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(selected.length === 0 && !readOnly ? "bank" : "selected");
  const [replaceTarget, setReplaceTarget] = useState<SelectedQuestion | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const count = selected.length;
  const drafts = selected.filter((q) => q.status !== "PUBLISHED").length;
  const selectedIds = useMemo(() => new Set(selected.map((q) => q.id)), [selected]);

  const run = (op: () => Promise<QuestionOpResult>, success: (r: QuestionOpResult) => string) => {
    setMessage(null);
    startTransition(async () => {
      const result = await op().catch((e: unknown) => ({ error: e instanceof Error ? e.message : "Action failed." }));
      if (result.error) setMessage({ tone: "error", text: result.error });
      else setMessage({ tone: "success", text: success(result) });
      router.refresh();
    });
  };

  const openBank = () => {
    setReplaceTarget(null);
    setPanel("bank");
  };

  return (
    <div className="flex flex-col gap-5">
      <QuestionCount count={count} expected={expected} drafts={drafts} />

      <div className="grid gap-3 sm:grid-cols-3">
        <ActionTile
          active={panel === "bank" && !replaceTarget}
          disabled={readOnly}
          onClick={openBank}
          icon={<Plus className="h-5 w-5" aria-hidden />}
          title="Add From Question Bank"
          hint={`Pick from ${examName}'s canonical questions`}
        />
        {readOnly ? (
          <ActionTile disabled icon={<FileSpreadsheet className="h-5 w-5" aria-hidden />} title="Bulk Import Questions" hint="Master Admin only" />
        ) : (
          <Link
            href={bulkImportHref}
            className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 text-left transition-colors hover:border-[var(--color-primary)]"
          >
            <span className="text-[var(--color-primary)]">
              <FileSpreadsheet className="h-5 w-5" aria-hidden />
            </span>
            <span>
              <span className="block text-sm font-semibold uppercase tracking-wide text-[var(--color-foreground)]">Bulk Import Questions</span>
              <span className="block text-xs text-[var(--color-muted-foreground)]">CSV / XLS / XLSX → Question Bank → this test, in row order</span>
            </span>
          </Link>
        )}
        <ActionTile
          active={panel === "selected"}
          onClick={() => {
            setReplaceTarget(null);
            setPanel("selected");
          }}
          icon={<ListOrdered className="h-5 w-5" aria-hidden />}
          title={`View Selected Questions (${count})`}
          hint="Preview, reorder, remove, replace"
        />
      </div>

      {message ? (
        <p role="status" className={`text-sm ${message.tone === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      {panel === "bank" ? (
        <BankPanel
          bank={bank}
          selectedIds={selectedIds}
          replaceTarget={replaceTarget}
          pending={pending}
          onCancelReplace={() => {
            setReplaceTarget(null);
            setPanel("selected");
          }}
          onAdd={(ids) =>
            run(
              () => addMockTestQuestionsAction(mockTestId, ids),
              (r) => `Added ${r.added ?? 0} question${r.added === 1 ? "" : "s"} to the end of the test${r.skipped ? ` (${r.skipped} already in the test or not eligible)` : ""}.`
            )
          }
          onReplace={(newId) => {
            const target = replaceTarget;
            if (!target) return;
            run(() => replaceMockTestQuestionAction(mockTestId, target.id, newId), () => `Replaced ${target.code}.`);
            setReplaceTarget(null);
            setPanel("selected");
          }}
        />
      ) : (
        <SelectedPanel
          selected={selected}
          readOnly={readOnly}
          pending={pending}
          onReorder={(ids) => run(() => reorderMockTestQuestionsAction(mockTestId, ids), () => "Order saved.")}
          onRemove={(ids) => run(() => removeMockTestQuestionsAction(mockTestId, ids), () => `Removed ${ids.length} question${ids.length === 1 ? "" : "s"}.`)}
          onReplace={(q) => {
            setReplaceTarget(q);
            setPanel("bank");
          }}
        />
      )}
    </div>
  );
}

function QuestionCount({ count, expected, drafts }: { count: number; expected: number | null; drafts: number }) {
  const remaining = expected !== null ? expected - count : null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">Questions</p>
        <p className="text-2xl font-semibold tabular-nums text-[var(--color-foreground)]">
          {count}
          {expected !== null ? <span className="text-[var(--color-muted-foreground)]"> / {expected}</span> : null}
        </p>
      </div>
      {count === 0 ? (
        <Badge variant="warning">Needs Questions</Badge>
      ) : remaining === null ? null : remaining > 0 ? (
        <Badge variant="info">
          {remaining} Question{remaining === 1 ? "" : "s"} Remaining
        </Badge>
      ) : remaining === 0 ? (
        <Badge variant="success">Complete</Badge>
      ) : (
        <Badge variant="warning">Exceeds expected by {-remaining}</Badge>
      )}
      {drafts > 0 ? (
        <Badge variant="warning" title="Draft questions stay in order but are hidden from students until published in the Question Bank.">
          {drafts} Draft — hidden from students until published
        </Badge>
      ) : null}
    </div>
  );
}

function ActionTile({
  active,
  disabled,
  onClick,
  icon,
  title,
  hint,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`flex items-start gap-3 rounded-[var(--radius-card)] border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10" : "border-[var(--color-border)] hover:border-[var(--color-primary)]"
      }`}
    >
      <span className="text-[var(--color-primary)]">{icon}</span>
      <span>
        <span className="block text-sm font-semibold uppercase tracking-wide text-[var(--color-foreground)]">{title}</span>
        <span className="block text-xs text-[var(--color-muted-foreground)]">{hint}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// View Selected Questions
// ---------------------------------------------------------------------------

function SelectedPanel({
  selected,
  readOnly,
  pending,
  onReorder,
  onRemove,
  onReplace,
}: {
  selected: SelectedQuestion[];
  readOnly: boolean;
  pending: boolean;
  onReorder: (ids: string[]) => void;
  onRemove: (ids: string[]) => void;
  onReplace: (q: SelectedQuestion) => void;
}) {
  const [search, setSearch] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const subjects = useMemo(() => [...new Map(selected.map((q) => [q.subjectId, q.subjectName])).entries()], [selected]);
  const needle = search.trim().toLowerCase();
  const filtering = needle !== "" || subjectId !== "";
  const visible = selected
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => (!subjectId || q.subjectId === subjectId) && (!needle || q.text.toLowerCase().includes(needle) || q.code.toLowerCase().includes(needle)));
  const ids = selected.map((q) => q.id);
  const canReorder = !readOnly && !filtering && !pending;

  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length) return;
    onReorder(arrayMove(ids, from, to));
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    move(ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
  };

  if (selected.length === 0) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted-foreground)]">
        No questions yet — add them from the Question Bank or bulk import a spreadsheet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search selected by text or code" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        <SelectNative aria-label="Filter by subject" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} className="max-w-[220px]">
          <option value="">All subjects</option>
          {subjects.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </SelectNative>
        {!readOnly && checked.size > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              onRemove([...checked]);
              setChecked(new Set());
            }}
          >
            Remove {checked.size} selected
          </Button>
        ) : null}
        <span className="text-xs text-[var(--color-muted-foreground)]">
          {filtering ? `${visible.length} match · clear filters to reorder` : "Drag ⋮⋮ or use ↑ ↓ to reorder — saved instantly"}
        </span>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col rounded-[var(--radius-card)] border border-[var(--color-border)]">
            {visible.map(({ q, index }) => (
              <SelectedRow
                key={q.id}
                q={q}
                index={index}
                total={ids.length}
                canReorder={canReorder}
                readOnly={readOnly}
                pending={pending}
                checked={checked.has(q.id)}
                previewOpen={previewId === q.id}
                onCheck={(on) =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(q.id);
                    else next.delete(q.id);
                    return next;
                  })
                }
                onPreview={() => setPreviewId((cur) => (cur === q.id ? null : q.id))}
                onMove={(d) => move(index, index + d)}
                onRemove={() => onRemove([q.id])}
                onReplace={() => onReplace(q)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SelectedRow({
  q,
  index,
  total,
  canReorder,
  readOnly,
  pending,
  checked,
  previewOpen,
  onCheck,
  onPreview,
  onMove,
  onRemove,
  onReplace,
}: {
  q: SelectedQuestion;
  index: number;
  total: number;
  canReorder: boolean;
  readOnly: boolean;
  pending: boolean;
  checked: boolean;
  previewOpen: boolean;
  onCheck: (on: boolean) => void;
  onPreview: () => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onReplace: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: q.id, disabled: !canReorder });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`border-b border-[var(--color-border)] px-3 py-2 last:border-0 ${isDragging ? "relative z-10 bg-[var(--color-surface)] shadow-lg" : ""}`}
    >
      <div className="flex items-start gap-2">
        {canReorder ? (
          <button type="button" className="mt-0.5 cursor-grab text-[var(--color-muted-foreground)]" aria-label={`Drag Q${index + 1} to reorder`} {...attributes} {...listeners}>
            <GripVertical className="h-4 w-4" />
          </button>
        ) : null}
        {!readOnly ? <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={`Select ${q.code}`} /> : null}
        <span className="w-9 shrink-0 pt-0.5 text-xs font-semibold tabular-nums text-[var(--color-muted-foreground)]">Q{index + 1}</span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm text-[var(--color-foreground)]">{q.text}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-muted-foreground)]">
            <span>{q.code}</span>·<span>{q.subjectName}</span>
            {q.topicName ? <span>› {q.topicName}</span> : null}
            {q.isPyq ? <Badge variant="primary">PYQ{q.year ? ` ${q.year}` : ""}</Badge> : null}
            {q.hasImage ? <ImageIcon className="h-3.5 w-3.5" aria-label="Has image" /> : null}
            {q.status !== "PUBLISHED" ? <Badge variant="warning">{q.status}</Badge> : null}
          </span>
        </span>
        <span className="flex shrink-0 gap-0.5">
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Preview" onClick={onPreview}>
            <Eye className="h-3.5 w-3.5" />
          </Button>
          {!readOnly ? (
            <>
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Move up" onClick={() => onMove(-1)} disabled={!canReorder || index === 0}>
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Move down" onClick={() => onMove(1)} disabled={!canReorder || index === total - 1}>
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Replace" onClick={onReplace} disabled={pending}>
                <Replace className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Remove" onClick={onRemove} disabled={pending}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : null}
        </span>
      </div>
      {previewOpen ? <QuestionPreview q={q} /> : null}
    </li>
  );
}

function QuestionPreview({ q }: { q: SelectedQuestion }) {
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-button)] bg-[color-mix(in_srgb,var(--color-foreground)_4%,transparent)] p-3 text-sm">
      <p className="whitespace-pre-wrap text-[var(--color-foreground)]">{q.text}</p>
      {q.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- admin preview of an uploaded question image
        <img src={q.imageUrl} alt={`${q.code} question image`} className="max-h-48 w-fit rounded border border-[var(--color-border)]" />
      ) : null}
      <ul className="flex flex-col gap-1">
        {q.options.map((o) => (
          <li key={o.label} className={o.isCorrect ? "font-medium text-[var(--color-success)]" : "text-[var(--color-foreground)]"}>
            {o.label}. {o.text} {o.isCorrect ? "✓" : ""}
            {o.imageUrl ? " [image]" : ""}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-[var(--color-muted-foreground)]">
        {q.difficulty} · {q.subjectName}
        {q.topicName ? ` › ${q.topicName}` : ""}
        {q.subTopicName ? ` › ${q.subTopicName}` : ""}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add From Question Bank
// ---------------------------------------------------------------------------

function BankPanel({
  bank,
  selectedIds,
  replaceTarget,
  pending,
  onCancelReplace,
  onAdd,
  onReplace,
}: {
  bank: BankQuestion[];
  selectedIds: Set<string>;
  replaceTarget: SelectedQuestion | null;
  pending: boolean;
  onCancelReplace: () => void;
  onAdd: (ids: string[]) => void;
  onReplace: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [subjectId, setSubjectId] = useState(replaceTarget?.subjectId ?? "");
  const [topicId, setTopicId] = useState("");
  const [subTopicId, setSubTopicId] = useState("");
  const [year, setYear] = useState("");
  const [source, setSource] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [qType, setQType] = useState("");
  const [status, setStatus] = useState("PUBLISHED");
  const [hideAdded, setHideAdded] = useState(true);
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<string[]>([]);

  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const uniq = (rows: [string, string][]) => [...new Map(rows).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const subjects = useMemo(() => uniq(bank.map((x) => [x.subjectId, x.subjectName])), [bank]);
  const topics = useMemo(
    () => uniq(bank.filter((x) => x.topicId && (!subjectId || x.subjectId === subjectId)).map((x) => [x.topicId!, x.topicName ?? ""])),
    [bank, subjectId]
  );
  const subTopics = useMemo(
    () => uniq(bank.filter((x) => x.subTopicId && (!topicId || x.topicId === topicId) && (!subjectId || x.subjectId === subjectId)).map((x) => [x.subTopicId!, x.subTopicName ?? ""])),
    [bank, subjectId, topicId]
  );
  const years = useMemo(() => [...new Set(bank.map((x) => x.year).filter((y): y is number => y !== null))].sort((a, b) => b - a), [bank]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return bank.filter(
      (x) =>
        (!hideAdded || !selectedIds.has(x.id)) &&
        (!subjectId || x.subjectId === subjectId) &&
        (!topicId || x.topicId === topicId) &&
        (!subTopicId || x.subTopicId === subTopicId) &&
        (!year || String(x.year) === year) &&
        (!source || (source === "PYQ" ? x.isPyq : !x.isPyq)) &&
        (!difficulty || x.difficulty === difficulty) &&
        (!qType || (qType === "IMAGE" ? x.hasImage : !x.hasImage)) &&
        (!status || x.status === status) &&
        (!needle || x.text.toLowerCase().includes(needle) || x.code.toLowerCase().includes(needle))
    );
  }, [bank, selectedIds, hideAdded, subjectId, topicId, subTopicId, year, source, difficulty, qType, status, q]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const pageRows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const addable = (x: BankQuestion) => !selectedIds.has(x.id);
  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };

  const toggle = (id: string) => setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const selectPage = () => setPicked((prev) => [...prev, ...pageRows.filter(addable).map((x) => x.id).filter((id) => !prev.includes(id))]);
  const selectAllFiltered = () =>
    setPicked((prev) => [...prev, ...filtered.filter(addable).map((x) => x.id).filter((id) => !prev.includes(id))].slice(0, MAX_BULK_SELECT));

  return (
    <div className="flex flex-col gap-3">
      {replaceTarget ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-button)] border border-[var(--color-primary)] bg-[var(--color-primary)]/10 px-3 py-2 text-sm">
          <span>
            Replacing <strong>{replaceTarget.code}</strong> — choose the question that takes its slot.
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={onCancelReplace}>
            Cancel
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-5">
        <Input placeholder="Question text or code" value={q} onChange={(e) => reset(() => setQ(e.target.value))} className="col-span-2" />
        <SelectNative aria-label="Subject" value={subjectId} onChange={(e) => reset(() => { setSubjectId(e.target.value); setTopicId(""); setSubTopicId(""); })}>
          <option value="">All subjects</option>
          {subjects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </SelectNative>
        <SelectNative aria-label="Topic" value={topicId} onChange={(e) => reset(() => { setTopicId(e.target.value); setSubTopicId(""); })}>
          <option value="">All topics</option>
          {topics.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </SelectNative>
        <SelectNative aria-label="Sub-topic" value={subTopicId} onChange={(e) => reset(() => setSubTopicId(e.target.value))}>
          <option value="">All sub-topics</option>
          {subTopics.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </SelectNative>
        <SelectNative aria-label="Year" value={year} onChange={(e) => reset(() => setYear(e.target.value))}>
          <option value="">Any year</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </SelectNative>
        <SelectNative aria-label="Source" value={source} onChange={(e) => reset(() => setSource(e.target.value))}>
          <option value="">Source: All</option>
          <option value="PYQ">PYQ</option>
          <option value="BANK">Non-PYQ</option>
        </SelectNative>
        <SelectNative aria-label="Difficulty" value={difficulty} onChange={(e) => reset(() => setDifficulty(e.target.value))}>
          <option value="">Any difficulty</option>
          <option value="EASY">Easy</option>
          <option value="MEDIUM">Medium</option>
          <option value="HARD">Hard</option>
        </SelectNative>
        <SelectNative aria-label="Question type" value={qType} onChange={(e) => reset(() => setQType(e.target.value))}>
          <option value="">Type: All MCQ</option>
          <option value="TEXT">Text MCQ</option>
          <option value="IMAGE">Image-based MCQ</option>
        </SelectNative>
        <SelectNative aria-label="Status" value={status} onChange={(e) => reset(() => setStatus(e.target.value))}>
          <option value="PUBLISHED">Published</option>
          <option value="DRAFT">Draft</option>
          <option value="">Published + Draft</option>
        </SelectNative>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
        <span>{filtered.length} match</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={hideAdded} onChange={(e) => reset(() => setHideAdded(e.target.checked))} /> Hide questions already in this test
        </label>
        {!replaceTarget ? (
          <>
            <Button type="button" size="compact" variant="outline" onClick={selectPage} disabled={pageRows.length === 0}>
              Select page
            </Button>
            <Button type="button" size="compact" variant="outline" onClick={selectAllFiltered} disabled={filtered.length === 0}>
              Select all {Math.min(filtered.length, MAX_BULK_SELECT)}
              {filtered.length > MAX_BULK_SELECT ? ` (max ${MAX_BULK_SELECT})` : ""}
            </Button>
            {picked.length > 0 ? (
              <Button type="button" size="compact" variant="ghost" onClick={() => setPicked([])}>
                Clear selection
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border)]">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[11px] uppercase text-[var(--color-muted-foreground)]">
              <th className="w-8 px-3 py-2" />
              <th className="px-2 py-2">Code</th>
              <th className="px-2 py-2">Question</th>
              <th className="px-2 py-2">Subject / Topic</th>
              <th className="px-2 py-2">Year</th>
              <th className="px-2 py-2">Source</th>
              <th className="px-2 py-2">Difficulty</th>
              <th className="px-2 py-2">Type</th>
              {replaceTarget ? <th className="px-2 py-2" /> : null}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((x) => {
              const inTest = selectedIds.has(x.id);
              return (
                <tr key={x.id} className="border-b border-[var(--color-border)] last:border-0 align-top">
                  <td className="px-3 py-2">
                    {!replaceTarget ? (
                      <input type="checkbox" checked={inTest || pickedSet.has(x.id)} disabled={inTest} onChange={() => toggle(x.id)} aria-label={`Select ${x.code}`} />
                    ) : null}
                  </td>
                  <td className="px-2 py-2 font-mono text-[11px] text-[var(--color-muted-foreground)]">{x.code}</td>
                  <td className="px-2 py-2">
                    <span className="line-clamp-2 text-[var(--color-foreground)]">{x.text}</span>
                    {inTest ? <span className="text-[11px] text-[var(--color-success)]">Already in this test</span> : null}
                    {x.status !== "PUBLISHED" ? <Badge variant="warning">{x.status}</Badge> : null}
                  </td>
                  <td className="px-2 py-2 text-xs text-[var(--color-muted-foreground)]">
                    {x.subjectName}
                    {x.topicName ? <span className="block">{x.topicName}</span> : null}
                  </td>
                  <td className="px-2 py-2 text-xs">{x.year ?? "—"}</td>
                  <td className="px-2 py-2 text-xs">{x.isPyq ? "PYQ" : "Non-PYQ"}</td>
                  <td className="px-2 py-2 text-xs">{x.difficulty}</td>
                  <td className="px-2 py-2 text-xs">
                    {x.hasImage ? (
                      <span className="flex items-center gap-1">
                        <ImageIcon className="h-3.5 w-3.5" aria-hidden /> Image
                      </span>
                    ) : (
                      "Text"
                    )}
                  </td>
                  {replaceTarget ? (
                    <td className="px-2 py-2">
                      <Button type="button" size="compact" disabled={inTest || pending} onClick={() => onReplace(x.id)}>
                        Use this
                      </Button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-6 text-center text-xs text-[var(--color-muted-foreground)]">
                  No questions match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
          <Button type="button" size="compact" variant="outline" disabled={current <= 1} onClick={() => setPage(current - 1)}>
            Prev
          </Button>
          Page {current} / {totalPages}
          <Button type="button" size="compact" variant="outline" disabled={current >= totalPages} onClick={() => setPage(current + 1)}>
            Next
          </Button>
        </div>
        {!replaceTarget ? (
          <Button
            type="button"
            disabled={picked.length === 0 || pending}
            onClick={() => {
              onAdd(picked);
              setPicked([]);
            }}
          >
            {pending ? "Adding…" : `Add Selected Questions (${picked.length})`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
