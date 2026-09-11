import "server-only";

import { prisma } from "@/lib/db";

import { buildDiagramGraph } from "./buildGraph";
import type { DiagramGraph } from "./types";

const SNAPSHOT_ID = "singleton";

/** Reads the cached diagram snapshot, generating one for the first time if none exists yet.
 * Regeneration otherwise only happens via refreshDiagramSnapshot() (the explicit Refresh
 * Diagram action) — page loads never re-scan the filesystem. */
export async function getDiagramSnapshot(): Promise<DiagramGraph> {
  const existing = await prisma.diagramSnapshot.findUnique({ where: { id: SNAPSHOT_ID } });
  if (existing) return existing.data as unknown as DiagramGraph;
  return refreshDiagramSnapshot();
}

export async function refreshDiagramSnapshot(adminId?: string): Promise<DiagramGraph> {
  const graph = await buildDiagramGraph();
  await prisma.diagramSnapshot.upsert({
    where: { id: SNAPSHOT_ID },
    create: { id: SNAPSHOT_ID, data: graph as unknown as object, generatedAt: new Date(graph.generatedAt), generatedById: adminId },
    update: { data: graph as unknown as object, generatedAt: new Date(graph.generatedAt), generatedById: adminId },
  });
  return graph;
}
