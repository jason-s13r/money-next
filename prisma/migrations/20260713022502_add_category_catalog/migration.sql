-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "groupId" TEXT,
    "groupName" TEXT,
    "syncedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Category_groupName_idx" ON "Category"("groupName");
