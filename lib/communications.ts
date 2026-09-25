import "server-only";
import crypto from "node:crypto";
import { CommunicationType, type CommunicationStatus, type GrowWithUsInterest } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/client-ip";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_SUBMISSIONS = 5;

const REFERENCE_PREFIX: Record<CommunicationType, string> = {
  [CommunicationType.CONTACT]: "CT",
  [CommunicationType.GROW_WITH_US]: "GW",
};

/** Trusted client IP — see lib/client-ip.ts (the one resolver every rate limit uses). */
export const requestIp = getClientIp;

/**
 * DB-backed rate limit, mirroring the StudentLoginAttempt pattern
 * (lib/auth-student.ts) so it works correctly across the PM2 cluster's
 * multiple worker processes — an in-memory counter would not.
 */
export async function isRateLimited(ipAddress: string): Promise<boolean> {
  if (ipAddress === "unknown") return false; // can't rate-limit what we can't identify; the DB unique/index still bounds abuse cost
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const recentCount = await prisma.communication.count({
    where: { ipAddress, createdAt: { gte: windowStart } },
  });
  return recentCount >= RATE_LIMIT_MAX_SUBMISSIONS;
}

async function generateReferenceId(type: CommunicationType): Promise<string> {
  const prefix = REFERENCE_PREFIX[type];
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const referenceId = `${prefix}-${suffix}`;
    const existing = await prisma.communication.findUnique({ where: { referenceId }, select: { id: true } });
    if (!existing) return referenceId;
  }
  throw new Error("Could not generate a unique reference ID.");
}

export interface CreateCommunicationInput {
  type: CommunicationType;
  interestType?: GrowWithUsInterest;
  name: string;
  email: string;
  phone?: string;
  subject?: string;
  message: string;
  studentId?: string;
  ipAddress: string;
  userAgent?: string;
}

export async function createCommunication(input: CreateCommunicationInput) {
  const referenceId = await generateReferenceId(input.type);
  return prisma.communication.create({
    data: {
      referenceId,
      type: input.type,
      interestType: input.interestType,
      name: input.name,
      email: input.email,
      phone: input.phone || null,
      subject: input.subject || null,
      message: input.message,
      studentId: input.studentId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
  });
}

export interface CommunicationFilters {
  type?: CommunicationType;
  status?: CommunicationStatus;
}

export async function listCommunications(filters: CommunicationFilters = {}) {
  return prisma.communication.findMany({
    where: { type: filters.type, status: filters.status },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { assignedAdmin: { select: { id: true, name: true } } },
  });
}

export async function getCommunication(id: string) {
  return prisma.communication.findUnique({
    where: { id },
    include: { assignedAdmin: { select: { id: true, name: true } }, student: { select: { id: true, name: true, studentId: true } } },
  });
}

export async function getCommunicationCounts() {
  const rows = await prisma.communication.groupBy({ by: ["type", "status"], _count: { _all: true } });
  const total = rows.reduce((sum, r) => sum + r._count._all, 0);
  const byType = (type: CommunicationType) => rows.filter((r) => r.type === type).reduce((s, r) => s + r._count._all, 0);
  const byStatus = (status: CommunicationStatus) => rows.filter((r) => r.status === status).reduce((s, r) => s + r._count._all, 0);
  return {
    total,
    contact: byType(CommunicationType.CONTACT),
    growWithUs: byType(CommunicationType.GROW_WITH_US),
    new: byStatus("NEW"),
    inProgress: byStatus("IN_PROGRESS"),
    resolved: byStatus("RESOLVED"),
  };
}
