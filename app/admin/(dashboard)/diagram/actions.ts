"use server";

import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import { requireAdminRole } from "@/lib/auth/requireAdmin";
import { refreshDiagramSnapshot } from "@/lib/diagram/snapshot";
import type { DiagramGraph } from "@/lib/diagram/types";
import { prisma } from "@/lib/db";

export type DiagramActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

const GENERIC_ERROR = "That didn't work. Please try again.";

/** Refresh Diagram — re-scans the live app/ route tree and source files and recomputes the
 * entire graph from scratch, then replaces the cached snapshot. Never a page reload: the client
 * swaps in the returned graph directly. */
export async function refreshDiagramAction(): Promise<DiagramActionResult<DiagramGraph>> {
  try {
    const session = await requireAdminRole();
    const graph = await refreshDiagramSnapshot(session.user.id);
    await writeAuditLog({ adminId: session.user.id, action: "diagram_refresh", entity: "DiagramSnapshot" });
    return { ok: true, data: graph };
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}

const metaSchema = z.object({
  route: z.string().min(1),
  displayName: z.string().trim().max(120).optional(),
  sectionLabel: z.string().trim().max(60).optional(),
  statusOverride: z.enum(["ACTIVE", "COMING_SOON", "DRAFT", "IN_DEVELOPMENT", "NEEDS_REVIEW", "AUTO"]).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export type UpdateNodeMetaInput = z.infer<typeof metaSchema>;

/** Admin-authored overlay for one detected route — display name, section label, a manual status
 * override, and free-form notes. Never touches anything that is itself auto-detected. */
export async function updateNodeMetaAction(input: UpdateNodeMetaInput): Promise<DiagramActionResult<DiagramGraph>> {
  try {
    const session = await requireAdminRole();
    const parsed = metaSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };
    const { route, displayName, sectionLabel, statusOverride, notes } = parsed.data;

    await prisma.diagramNodeMeta.upsert({
      where: { route },
      create: {
        route,
        displayName: displayName || null,
        sectionLabel: sectionLabel || null,
        statusOverride: statusOverride && statusOverride !== "AUTO" ? statusOverride : null,
        notes: notes || null,
        updatedById: session.user.id,
      },
      update: {
        displayName: displayName || null,
        sectionLabel: sectionLabel || null,
        statusOverride: statusOverride && statusOverride !== "AUTO" ? statusOverride : null,
        notes: notes || null,
        updatedById: session.user.id,
      },
    });

    await writeAuditLog({ adminId: session.user.id, action: "diagram_meta_update", entity: "DiagramNodeMeta", entityId: route });
    const graph = await refreshDiagramSnapshot(session.user.id);
    return { ok: true, data: graph };
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}

const plannedSchema = z.object({
  label: z.string().trim().min(1).max(120),
  plannedRoute: z.string().trim().max(160).optional(),
  section: z.string().trim().min(1).max(60),
  notes: z.string().trim().max(2000).optional(),
});

export type AddPlannedPageInput = z.infer<typeof plannedSchema>;

export async function addPlannedPageAction(input: AddPlannedPageInput): Promise<DiagramActionResult<DiagramGraph>> {
  try {
    const session = await requireAdminRole();
    const parsed = plannedSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_ERROR };

    const created = await prisma.diagramPlannedPage.create({
      data: { ...parsed.data, plannedRoute: parsed.data.plannedRoute || null, createdById: session.user.id },
    });

    await writeAuditLog({ adminId: session.user.id, action: "create", entity: "DiagramPlannedPage", entityId: created.id });
    const graph = await refreshDiagramSnapshot(session.user.id);
    return { ok: true, data: graph };
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}

export async function deletePlannedPageAction(id: string): Promise<DiagramActionResult<DiagramGraph>> {
  try {
    const session = await requireAdminRole();
    await prisma.diagramPlannedPage.delete({ where: { id } });
    await writeAuditLog({ adminId: session.user.id, action: "delete", entity: "DiagramPlannedPage", entityId: id });
    const graph = await refreshDiagramSnapshot(session.user.id);
    return { ok: true, data: graph };
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}
