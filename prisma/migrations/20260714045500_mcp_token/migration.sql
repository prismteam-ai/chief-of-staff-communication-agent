-- AlterTable
ALTER TABLE "User" ADD COLUMN "mcpToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_mcpToken_key" ON "User"("mcpToken");
