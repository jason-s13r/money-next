-- CreateTable
CREATE TABLE "RuleDocument" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "RuleDocument_slug_key" ON "RuleDocument"("slug");

-- CreateIndex
CREATE INDEX "RuleDocument_active_idx" ON "RuleDocument"("active");
