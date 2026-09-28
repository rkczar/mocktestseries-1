"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
  searchMockQuestionBankAction,
  matchingMockQuestionIdsAction,
  type QuestionOpResult,
} from "@/app/admin/(dashboard)/tests/mock/actions";
import type { BankFacets, BankFilters, BankRow } from "@/lib/mock-question-bank";

/** One Question Bank row (with its canonical exam / PYQ provenance). */
export type BankQuestion = BankRow;

/** A question already attached to the test, with its options for Preview. */
export interface SelectedQuestion extends BankQuestion {
  imageUrl: string | null;
  options: { label: string; text: string; imageUrl: string | null; isCorrect: boolean }[];
}

type Panel = "selected" | "bank";
const MAX_BULK_SELECT = 500;

export interface BankExamOption {
  id: string;
  name: string;
  code: string;
}
export interface BankPaperOption {
  id: string;
  examId: string;
  title: string;
  year: number;
}

/**
 * Mock Test → Step 3 Questions. Three obvious ways in: Add From Question
 * Bank (the central bank of ANY exam, searched server-side — defaults to
 * this test's exam; a question from another exam is referenced, never
 * copied or reclassified), Bulk Import Questions
 * (the existing Question Bank importer, opened with this exam + test
 * pre-selected), and View Selected Questions (preview, drag/drop or up/down
 * reorder, remove, replace, search). Every change is persisted immediately
 * by a server action that re-validates eligibility and rewrites a dense
 * order — the stored order is the order students see.
 */
export function MockQuestionsManager({
  mockTestId,
  examId,
  examName,
  expected,
  selected,
  exams,
  papers,
  bulkImportHref,
  readOnly,
}: {
  mockTestId: string;
  examId: string;
  examName: string;
  expected: number | null;
  selected: SelectedQuestion[];
  exams: BankExamOption[];
  papers: BankPaperOption[];
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
          hint={`Pick from ${examName} or any other exam's questions`}
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
          mockTestId={mockTestId}
          mockExamId={examId}
          exams={exams}
          papers={papers}
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
          mockExamId={examId}
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
  mockExamId,
  readOnly,
  pending,
  onReorder,
  onRemove,
  onReplace,
}: {
  selected: SelectedQuestion[];
  mockExamId: string;
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
                mockExamId={mockExamId}
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
  mockExamId,
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
  mockExamId: string;
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
            <Provenance q={q} mockExamId={mockExamId} />
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

/**
 * Canonical ownership at a glance: "PYQ 2024" for this exam's own paper
 * questions, and "PUNJAB-MO · PYQ 2021" / "HR-MO · Bank" for a question
 * referenced from another exam. Membership in this test never changes it.
 */
function Provenance({ q, mockExamId }: { q: BankQuestion; mockExamId: string }) {
  const other = q.examId !== mockExamId;
  if (!other && !q.isPyq) return null;
  const label = `${other ? `${q.examCode} · ` : ""}${q.isPyq ? `PYQ${q.paperYear ? ` ${q.paperYear}` : ""}` : "Bank"}`;
  const title = `${q.examName}${q.paperTitle ? ` — ${q.paperTitle}` : " — Question Bank (not a Previous Year Paper question)"}`;
  return (
    <Badge variant={other ? "info" : "primary"} title={title}>
      {label}
    </Badge>
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

type BankFilterState = Required<{ [K in keyof Omit<BankFilters, "year" | "excludeMockTestId">]: string }> & { year: string };

const EMPTY_FACETS: BankFacets = { subjects: [], topics: [], subTopics: [], years: [] };

function BankPanel({
  mockTestId,
  mockExamId,
  exams,
  papers,
  selectedIds,
  replaceTarget,
  pending,
  onCancelReplace,
  onAdd,
  onReplace,
}: {
  mockTestId: string;
  mockExamId: string;
  exams: BankExamOption[];
  papers: BankPaperOption[];
  selectedIds: Set<string>;
  replaceTarget: SelectedQuestion | null;
  pending: boolean;
  onCancelReplace: () => void;
  onAdd: (ids: string[]) => void;
  onReplace: (id: string) => void;
}) {
  // Source Exam defaults to this test's own exam; "All exams" / another exam
  // is an explicit choice. A replacement starts from the replaced question's
  // own exam + subject.
  const [f, setF] = useState<BankFilterState>({
    examId: replaceTarget?.examId ?? mockExamId,
    paperId: "",
    subjectId: replaceTarget?.subjectId ?? "",
    topicId: "",
    subTopicId: "",
    year: "",
    source: "",
    difficulty: "",
    status: "PUBLISHED",
    qType: "",
    q: "",
  });
  const [query, setQuery] = useState(f.q);
  const [hideAdded, setHideAdded] = useState(true);
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<string[]>([]);
  const [result, setResult] = useState<{ rows: BankQuestion[]; total: number; page: number; pageSize: number; facets: BankFacets } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Loading is derived: the key of the request in flight vs. the last one answered.
  const [answeredKey, setAnsweredKey] = useState<string | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const seq = useRef(0);

  // Debounced free-text search.
  useEffect(() => {
    const t = setTimeout(() => {
      setF((prev) => (prev.q === query ? prev : { ...prev, q: query }));
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const filters = useMemo(
    () => ({ ...f, year: f.year ? Number(f.year) : undefined, excludeMockTestId: hideAdded ? mockTestId : undefined }),
    [f, hideAdded, mockTestId]
  );

  const requestKey = JSON.stringify([filters, page]);
  const loading = answeredKey !== requestKey;
  useEffect(() => {
    const id = ++seq.current;
    searchMockQuestionBankAction(mockTestId, filters, page)
      .then((res) => {
        if (id !== seq.current) return; // a newer request superseded this one
        if ("error" in res) {
          setError(res.error);
          return;
        }
        setError(null);
        setResult(res);
      })
      .catch(() => id === seq.current && setError("Could not load questions — try again."))
      .finally(() => id === seq.current && setAnsweredKey(requestKey));
  }, [mockTestId, filters, page, requestKey]);

  const set = (patch: Partial<BankFilterState>) => {
    setF((prev) => ({ ...prev, ...patch }));
    setPage(1);
  };

  const facets = result?.facets ?? EMPTY_FACETS;
  const rows = result?.rows ?? [];
  const total = result?.total ?? 0;
  const totalPages = result ? Math.max(1, Math.ceil(total / result.pageSize)) : 1;
  const current = result?.page ?? 1;
  const examPapers = papers.filter((p) => !f.examId || p.examId === f.examId);
  const examCode = new Map(exams.map((e) => [e.id, e.code]));
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const addable = (x: BankQuestion) => !selectedIds.has(x.id);
  const toggle = (id: string) => setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const selectPage = () => setPicked((prev) => [...prev, ...rows.filter(addable).map((x) => x.id).filter((id) => !prev.includes(id))]);
  const selectAllFiltered = async () => {
    setSelectingAll(true);
    const res = await matchingMockQuestionIdsAction(mockTestId, filters).catch(() => ({ error: "Could not select — try again." }));
    setSelectingAll(false);
    if ("error" in res) return setError(res.error);
    setPicked((prev) => [...prev, ...res.ids.filter((id) => !prev.includes(id) && !selectedIds.has(id))].slice(0, MAX_BULK_SELECT));
  };
  const crossExamPicked = f.examId !== mockExamId;

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

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <SelectNative
          aria-label="Source exam"
          value={f.examId}
          onChange={(e) => set({ examId: e.target.value, paperId: "", subjectId: "", topicId: "", subTopicId: "", year: "" })}
        >
          <option value="">Source exam: All exams</option>
          {exams.map((e) => (
            <option key={e.id} value={e.id}>
              {e.id === mockExamId ? `${e.name} (this test's exam)` : e.name}
            </option>
          ))}
        </SelectNative>
        <SelectNative
          aria-label="Previous Year Paper"
          value={f.paperId}
          onChange={(e) => set({ paperId: e.target.value, subjectId: "", topicId: "", subTopicId: "", year: "" })}
        >
          <option value="">All papers</option>
          {examPapers.map((p) => (
            <option key={p.id} value={p.id}>
              {f.examId ? p.title : `${examCode.get(p.examId) ?? ""} · ${p.title}`}
            </option>
          ))}
        </SelectNative>
        <Input placeholder="Search question code or text" value={query} onChange={(e) => setQuery(e.target.value)} className="sm:col-span-2" />
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
        <SelectNative aria-label="Subject" value={f.subjectId} onChange={(e) => set({ subjectId: e.target.value, topicId: "", subTopicId: "" })}>
          <option value="">All subjects</option>
          {facets.subjects.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </SelectNative>
        <SelectNative aria-label="Topic" value={f.topicId} disabled={!f.subjectId} onChange={(e) => set({ topicId: e.target.value, subTopicId: "" })}>
          <option value="">All topics</option>
          {facets.topics.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </SelectNative>
        <SelectNative aria-label="Sub-topic" value={f.subTopicId} disabled={!f.topicId} onChange={(e) => set({ subTopicId: e.target.value })}>
          <option value="">All sub-topics</option>
          {facets.subTopics.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </SelectNative>
        <SelectNative aria-label="Year" value={f.year} disabled={Boolean(f.paperId)} onChange={(e) => set({ year: e.target.value })}>
          <option value="">All years</option>
          {facets.years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </SelectNative>
        <SelectNative aria-label="Source" value={f.source} disabled={Boolean(f.paperId)} onChange={(e) => set({ source: e.target.value })}>
          <option value="">Source: All</option>
          <option value="PYQ">PYQ</option>
          <option value="BANK">Non-PYQ</option>
        </SelectNative>
        <SelectNative aria-label="Difficulty" value={f.difficulty} onChange={(e) => set({ difficulty: e.target.value })}>
          <option value="">Any difficulty</option>
          <option value="EASY">Easy</option>
          <option value="MEDIUM">Medium</option>
          <option value="HARD">Hard</option>
        </SelectNative>
        <SelectNative aria-label="Status" value={f.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="PUBLISHED">Published</option>
          <option value="DRAFT">Draft</option>
          <option value="">Published + Draft</option>
        </SelectNative>
        <SelectNative aria-label="Question type" value={f.qType} onChange={(e) => set({ qType: e.target.value })}>
          <option value="">Type: All MCQ</option>
          <option value="TEXT">Text MCQ</option>
          <option value="IMAGE">Image-based MCQ</option>
        </SelectNative>
      </div>

      {crossExamPicked ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Questions from another exam are <strong>referenced</strong> by this test — they keep their own exam, Previous Year Paper and code.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
        <span aria-live="polite">{loading && !result ? "Loading…" : `${total} match${loading ? " · updating…" : ""}`}</span>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={hideAdded}
            onChange={(e) => {
              setHideAdded(e.target.checked);
              setPage(1);
            }}
          />{" "}
          Hide questions already in this test
        </label>
        {!replaceTarget ? (
          <>
            <Button type="button" size="compact" variant="outline" onClick={selectPage} disabled={rows.length === 0}>
              Select page
            </Button>
            <Button type="button" size="compact" variant="outline" onClick={selectAllFiltered} disabled={total === 0 || selectingAll}>
              {selectingAll ? "Selecting…" : `Select all ${Math.min(total, MAX_BULK_SELECT)}${total > MAX_BULK_SELECT ? ` (max ${MAX_BULK_SELECT})` : ""}`}
            </Button>
            {picked.length > 0 ? (
              <Button type="button" size="compact" variant="ghost" onClick={() => setPicked([])}>
                Clear selection
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-[var(--color-error)]">
          {error}
        </p>
      ) : null}

      <ul className={`flex flex-col rounded-[var(--radius-card)] border border-[var(--color-border)] ${loading ? "opacity-60" : ""}`}>
        {rows.map((x) => {
          const inTest = selectedIds.has(x.id);
          return (
            <li key={x.id} className="flex items-start gap-2 border-b border-[var(--color-border)] px-3 py-2 last:border-0">
              {!replaceTarget ? (
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={inTest || pickedSet.has(x.id)}
                  disabled={inTest}
                  onChange={() => toggle(x.id)}
                  aria-label={`Select ${x.code}`}
                />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-muted-foreground)]">
                  <span className="font-mono">{x.code}</span>
                  <Provenance q={x} mockExamId={mockExamId} />
                  {x.status !== "PUBLISHED" ? <Badge variant="warning">{x.status}</Badge> : null}
                  {x.hasImage ? <ImageIcon className="h-3.5 w-3.5" aria-label="Image-based" /> : null}
                </span>
                <span className="mt-0.5 line-clamp-2 text-sm text-[var(--color-foreground)]">{x.text}</span>
                <span className="mt-0.5 block text-[11px] text-[var(--color-muted-foreground)]">
                  {x.subjectName}
                  {x.topicName ? ` › ${x.topicName}` : ""}
                  {x.subTopicName ? ` › ${x.subTopicName}` : ""} · {x.difficulty.charAt(0) + x.difficulty.slice(1).toLowerCase()}
                  {!x.isPyq && x.year ? ` · ${x.year}` : ""}
                  {inTest ? <span className="text-[var(--color-success)]"> · Already in this test</span> : null}
                </span>
              </span>
              {replaceTarget ? (
                <Button type="button" size="compact" disabled={inTest || pending} onClick={() => onReplace(x.id)}>
                  Use this
                </Button>
              ) : null}
            </li>
          );
        })}
        {rows.length === 0 && !loading ? <li className="p-6 text-center text-xs text-[var(--color-muted-foreground)]">No questions match these filters.</li> : null}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
          <Button type="button" size="compact" variant="outline" disabled={current <= 1 || loading} onClick={() => setPage(current - 1)}>
            Prev
          </Button>
          Page {current} / {totalPages}
          <Button type="button" size="compact" variant="outline" disabled={current >= totalPages || loading} onClick={() => setPage(current + 1)}>
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
