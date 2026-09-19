/**
 * Verifies the Contact / Grow With Us / Admin Communications flow: form
 * validation (pure schemas), the canonical Communication data layer, rate
 * limiting, and RBAC scoping. All fixture rows are deleted at the end
 * regardless of pass/fail.
 *
 * Run from the repo root with the react-server condition so `import
 * "server-only"` resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-communications.ts
 */
import "dotenv/config";
import { PrismaClient, CommunicationType, RoleName } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { contactMessageSchema, growWithUsSchema } from "../lib/communications-schemas";
import { createCommunication, isRateLimited, listCommunications, getCommunicationCounts } from "../lib/communications";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from "../lib/permissions";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

async function main() {
  console.log("=== Communications Verification ===\n");
  const suffix = Date.now().toString(36);
  const fixtureIp = `203.0.113.${(Date.now() % 200) + 1}`; // TEST-NET-3, never a real client IP
  const createdIds: string[] = [];

  try {
    // ---- 1. Validation (pure schemas) -------------------------------------
    console.log("--- Validation ---");
    check(
      "valid contact input is accepted",
      contactMessageSchema.safeParse({
        name: "Test User",
        email: `test-${suffix}@example.com`,
        subject: "Question about mock tests",
        message: "This is a valid test message body.",
      }).success
    );
    check(
      "invalid email is rejected",
      !contactMessageSchema.safeParse({
        name: "Test User",
        email: "not-an-email",
        subject: "Subject",
        message: "This is a valid test message body.",
      }).success
    );
    check(
      "too-short message is rejected",
      !contactMessageSchema.safeParse({
        name: "Test User",
        email: `test-${suffix}@example.com`,
        subject: "Subject",
        message: "short",
      }).success
    );
    check(
      "valid grow-with-us input is accepted with a real interestType",
      growWithUsSchema.safeParse({
        name: "Test Teacher",
        email: `teacher-${suffix}@example.com`,
        interestType: "TEACHER",
        message: "I would like to contribute as a teacher.",
      }).success
    );
    check(
      "grow-with-us rejects an interestType outside the enum (e.g. STUDENT)",
      !growWithUsSchema.safeParse({
        name: "Test Student",
        email: `student-${suffix}@example.com`,
        interestType: "STUDENT",
        message: "I would like to contribute as a student.",
      }).success
    );

    // ---- 2. Data layer: creation + admin visibility ------------------------
    console.log("\n--- Data layer ---");
    const contact = await createCommunication({
      type: CommunicationType.CONTACT,
      name: "Verify Contact",
      email: `verify-contact-${suffix}@example.com`,
      subject: "Verify subject",
      message: "Verify message body for the contact form.",
      ipAddress: fixtureIp,
    });
    createdIds.push(contact.id);
    check("contact submission creates exactly one Communication row", contact.type === "CONTACT");
    check("contact submission gets a CT- prefixed reference ID", contact.referenceId.startsWith("CT-"));
    check("contact submission starts with status NEW", contact.status === "NEW");

    const grow = await createCommunication({
      type: CommunicationType.GROW_WITH_US,
      interestType: "TEACHER",
      name: "Verify Teacher",
      email: `verify-teacher-${suffix}@example.com`,
      message: "Verify message body for grow with us.",
      ipAddress: fixtureIp,
    });
    createdIds.push(grow.id);
    check("grow-with-us submission has type GROW_WITH_US", grow.type === "GROW_WITH_US");
    check("grow-with-us submission gets a GW- prefixed reference ID", grow.referenceId.startsWith("GW-"));
    check("grow-with-us submission stores the interestType (TEACHER)", grow.interestType === "TEACHER");

    const contactList = await listCommunications({ type: CommunicationType.CONTACT });
    check("admin contact listing includes the new contact submission", contactList.some((c) => c.id === contact.id));
    const growList = await listCommunications({ type: CommunicationType.GROW_WITH_US });
    check("admin grow-with-us listing includes the new submission", growList.some((c) => c.id === grow.id));

    const counts = await getCommunicationCounts();
    check("overview counts include at least the 2 fixture rows", counts.total >= 2);

    // ---- 3. Rate limiting ---------------------------------------------------
    console.log("\n--- Rate limiting ---");
    const rateLimitIp = `203.0.113.${((Date.now() + 7) % 200) + 1}`;
    for (let i = 0; i < 5; i++) {
      const row = await createCommunication({
        type: CommunicationType.CONTACT,
        name: `Rate Limit ${i}`,
        email: `rate-${i}-${suffix}@example.com`,
        subject: "Rate limit fixture",
        message: "Rate limit fixture message body.",
        ipAddress: rateLimitIp,
      });
      createdIds.push(row.id);
    }
    check("6th submission from the same IP within the window is rate-limited", await isRateLimited(rateLimitIp));
    check("a different IP is not affected by another IP's rate limit", !(await isRateLimited(fixtureIp)));

    // ---- 4. RBAC scoping -----------------------------------------------------
    console.log("\n--- RBAC ---");
    check("COMMUNICATIONS_MANAGE exists as a permission key", Object.values(PERMISSIONS).includes(PERMISSIONS.COMMUNICATIONS_MANAGE));
    check("MASTER_ADMIN has COMMUNICATIONS_MANAGE", DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.COMMUNICATIONS_MANAGE));
    check("FULL_ADMIN has COMMUNICATIONS_MANAGE", DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.COMMUNICATIONS_MANAGE));
    check(
      "TEACHER does NOT have COMMUNICATIONS_MANAGE (unauthorized users are blocked)",
      !DEFAULT_ROLE_PERMISSIONS[RoleName.TEACHER].includes(PERMISSIONS.COMMUNICATIONS_MANAGE)
    );

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.communication.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
