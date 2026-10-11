CREATE TABLE "WorkJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "ownerId" TEXT,
  "gameId" TEXT,
  "title" TEXT NOT NULL,
  "input" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "stage" TEXT NOT NULL DEFAULT 'queued',
  "bytesDone" BIGINT NOT NULL DEFAULT 0,
  "bytesTotal" BIGINT NOT NULL DEFAULT 0,
  "error" TEXT,
  "result" TEXT,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "WorkJob_status_createdAt_idx" ON "WorkJob"("status", "createdAt");
