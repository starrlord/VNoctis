CREATE TABLE "SaveCurrentFile" (
  "userId" TEXT NOT NULL, "gameId" TEXT NOT NULL, "path" TEXT NOT NULL,
  "mtime" REAL NOT NULL, "hash" TEXT NOT NULL,
  PRIMARY KEY ("userId", "gameId", "path"),
  CONSTRAINT "SaveCurrentFile_state_fkey" FOREIGN KEY ("userId", "gameId") REFERENCES "SaveSyncState" ("userId", "gameId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SaveCurrentFile_hash_fkey" FOREIGN KEY ("hash") REFERENCES "SaveFileBlob" ("hash") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SaveCurrentFile_hash_idx" ON "SaveCurrentFile"("hash");
