/**
 * Validation schemas for the public Contact Us / Grow With Us forms. Kept
 * pure (no prisma, no "server-only") so they're directly unit-testable —
 * same rationale as lib/safe-route.ts.
 */
import { z } from "zod";
import { GrowWithUsInterest } from "@prisma/client";

export const contactMessageSchema = z.object({
  name: z.string().trim().min(2, "Name is required.").max(100),
  email: z.string().trim().email("Enter a valid email address.").max(254),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  subject: z.string().trim().min(2, "Subject is required.").max(150),
  message: z.string().trim().min(10, "Message must be at least 10 characters.").max(3000),
});

export const growWithUsSchema = z.object({
  name: z.string().trim().min(2, "Name is required.").max(100),
  email: z.string().trim().email("Enter a valid email address.").max(254),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  interestType: z.nativeEnum(GrowWithUsInterest),
  experience: z.string().trim().max(1000).optional().or(z.literal("")),
  message: z.string().trim().min(10, "Message must be at least 10 characters.").max(3000),
});
