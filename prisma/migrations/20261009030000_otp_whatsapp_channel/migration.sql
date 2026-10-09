-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('SMS', 'WHATSAPP');

-- AlterTable
ALTER TABLE "OtpRequest" ADD COLUMN     "channel" "OtpChannel" NOT NULL DEFAULT 'SMS';
