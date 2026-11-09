-- Teacher Login (username/password or registered-mobile OTP). Additive only.
ALTER TYPE "OtpPurpose" ADD VALUE 'TEACHER_LOGIN';

ALTER TABLE "TeacherProfile" ADD COLUMN "mobile" TEXT,
ADD COLUMN "mobileVerifiedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "TeacherProfile_mobile_key" ON "TeacherProfile"("mobile");
