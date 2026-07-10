-- CreateTable
CREATE TABLE "ClassificationRule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "incomeCategory" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ClassificationRule_kind_enabled_priority_idx" ON "ClassificationRule"("kind", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ClassificationRule_kind_pattern_key" ON "ClassificationRule"("kind", "pattern");
