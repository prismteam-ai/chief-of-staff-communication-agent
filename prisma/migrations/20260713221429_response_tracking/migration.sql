-- AlterTable
ALTER TABLE "AgentAction" ADD COLUMN     "recommendation" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "answeredAt" TIMESTAMP(3),
ADD COLUMN     "responseStatus" TEXT NOT NULL DEFAULT 'pending';
