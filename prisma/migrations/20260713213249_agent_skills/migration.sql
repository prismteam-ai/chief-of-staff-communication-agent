-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "skills" TEXT[];

-- AlterTable
ALTER TABLE "AgentAction" ADD COLUMN     "meta" JSONB;
