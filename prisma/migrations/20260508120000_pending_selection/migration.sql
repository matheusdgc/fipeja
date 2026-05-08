-- CreateTable
CREATE TABLE "PendingSelection" (
    "jid" TEXT NOT NULL PRIMARY KEY,
    "options" TEXT NOT NULL,
    "year" INTEGER,
    "originalQuery" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "PendingSelection_expiresAt_idx" ON "PendingSelection"("expiresAt");
