"use server";

import { CommunicationType } from "@prisma/client";
import { getStudentSession } from "@/lib/student-session";
import { createCommunication, isRateLimited, requestIp } from "@/lib/communications";
import { contactMessageSchema, growWithUsSchema } from "@/lib/communications-schemas";

export interface CommunicationFormState {
  error?: string;
  success?: boolean;
  referenceId?: string;
}

export async function submitContactMessageAction(
  _prev: CommunicationFormState,
  formData: FormData
): Promise<CommunicationFormState> {
  const parsed = contactMessageSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const ipAddress = await requestIp();
  if (await isRateLimited(ipAddress)) {
    return { error: "Too many messages sent recently. Please try again in a few minutes." };
  }

  // Identity is derived from the server-side session only — a signed-in
  // student's studentId is never taken from the submitted form.
  const session = await getStudentSession();

  const communication = await createCommunication({
    type: CommunicationType.CONTACT,
    name: parsed.data.name,
    email: parsed.data.email,
    phone: parsed.data.phone || undefined,
    subject: parsed.data.subject,
    message: parsed.data.message,
    studentId: session?.user?.id,
    ipAddress,
  });

  return { success: true, referenceId: communication.referenceId };
}

export async function submitGrowWithUsAction(
  _prev: CommunicationFormState,
  formData: FormData
): Promise<CommunicationFormState> {
  const parsed = growWithUsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const ipAddress = await requestIp();
  if (await isRateLimited(ipAddress)) {
    return { error: "Too many submissions sent recently. Please try again in a few minutes." };
  }

  const session = await getStudentSession();

  const combinedMessage = parsed.data.experience
    ? `${parsed.data.message}\n\nExperience / introduction:\n${parsed.data.experience}`
    : parsed.data.message;

  const communication = await createCommunication({
    type: CommunicationType.GROW_WITH_US,
    interestType: parsed.data.interestType,
    name: parsed.data.name,
    email: parsed.data.email,
    phone: parsed.data.phone || undefined,
    message: combinedMessage,
    studentId: session?.user?.id,
    ipAddress,
  });

  return { success: true, referenceId: communication.referenceId };
}
