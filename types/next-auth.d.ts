import type { PermissionKey } from "@/lib/permissions";

declare module "next-auth" {
  interface User {
    role?: string;
    studentId?: string;
    authProvider?: string;
    /** Student device security (lib/student-devices.ts), set by the sign-in that admitted this device. */
    deviceId?: string;
    sessionSecret?: string | null;
    sessionRowId?: string | null;
    authAt?: number;
  }
  interface Session {
    user: {
      id?: string;
      name?: string | null;
      email?: string | null;
      role?: string;
      permissions?: PermissionKey[];
      studentId?: string;
      mobile?: string | null;
      authProvider?: string;
      /** StudentDevice row id of this browser (never the device cookie). */
      deviceId?: string;
      /** StudentSession row id (never the session secret). */
      sessionRowId?: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: string;
    permissions?: PermissionKey[];
    studentDbId?: string;
    studentId?: string;
    authProvider?: string;
    /** Raw per-session secret; only its SHA-256 is stored (StudentSession.tokenHash). */
    sid?: string;
    /** StudentSession row id. */
    sref?: string;
    /** StudentDevice row id. */
    did?: string;
    /** Sign-in time, ms. */
    authAt?: number;
  }
}
