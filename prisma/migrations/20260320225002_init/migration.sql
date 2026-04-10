-- CreateTable
CREATE TABLE "QueryLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "phone" TEXT NOT NULL,
    "queryType" TEXT NOT NULL,
    "userMessage" TEXT NOT NULL,
    "aiResult" TEXT,
    "fipeResult" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "errorMsg" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FipeCache" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "cacheKey" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "FipeCache_cacheKey_key" ON "FipeCache"("cacheKey");
