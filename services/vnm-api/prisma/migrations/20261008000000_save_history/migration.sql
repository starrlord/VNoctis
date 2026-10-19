ALTER TABLE "SaveSyncState" ADD COLUMN "currentVersionId" TEXT;
CREATE TABLE "SaveFileBlob" (
  "hash" TEXT NOT NULL PRIMARY KEY, "data" BLOB NOT NULL, "size" INTEGER NOT NULL
);
CREATE TABLE "SaveVersion" (
  "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "gameId" TEXT NOT NULL,
  "gameTitle" TEXT NOT NULL, "kind" TEXT NOT NULL, "alternate" BOOLEAN NOT NULL DEFAULT false,
  "branchId" TEXT, "baseRevision" INTEGER NOT NULL, "revision" INTEGER NOT NULL, "deviceLabel" TEXT NOT NULL,
  "checksum" TEXT NOT NULL, "saveChecksum" TEXT NOT NULL, "byteSize" INTEGER NOT NULL,
  "restoredFrom" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SaveVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SaveVersion_userId_gameId_createdAt_idx" ON "SaveVersion"("userId", "gameId", "createdAt");
CREATE INDEX "SaveVersion_userId_gameId_branchId_idx" ON "SaveVersion"("userId", "gameId", "branchId");
CREATE TABLE "SaveVersionFile" (
  "versionId" TEXT NOT NULL, "path" TEXT NOT NULL, "mtime" REAL NOT NULL, "hash" TEXT NOT NULL,
  PRIMARY KEY ("versionId", "path"),
  CONSTRAINT "SaveVersionFile_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "SaveVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SaveVersionFile_hash_fkey" FOREIGN KEY ("hash") REFERENCES "SaveFileBlob" ("hash") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SaveVersionFile_hash_idx" ON "SaveVersionFile"("hash");
CREATE TABLE "SaveUploadReceipt" (
  "userId" TEXT NOT NULL, "gameId" TEXT NOT NULL, "uploadId" TEXT NOT NULL,
  "checksum" TEXT NOT NULL, "revision" INTEGER NOT NULL, "disposition" TEXT NOT NULL,
  "versionId" TEXT, "branchId" TEXT, "saveChecksum" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "gameId", "uploadId"),
  CONSTRAINT "SaveUploadReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
