-- CreateTable
CREATE TABLE "FxRate" (
    "date" DATETIME NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" REAL NOT NULL,

    PRIMARY KEY ("date", "currency")
);

-- CreateIndex
CREATE INDEX "FxRate_currency_date_idx" ON "FxRate"("currency", "date");
