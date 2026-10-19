-- Saves outlive library entries, while deleting an account still removes its saves.
CREATE TABLE "new_SaveSyncState" (
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "gameTitle" TEXT NOT NULL DEFAULT '',
    "uploadId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "payload" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("userId", "gameId"),
    CONSTRAINT "SaveSyncState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SaveSyncState" ("userId", "gameId", "gameTitle", "revision", "payload", "checksum", "updatedAt")
SELECT s."userId", s."gameId", COALESCE(g."extractedTitle", ''), s."revision", s."payload", s."checksum", s."updatedAt"
FROM "SaveSyncState" s LEFT JOIN "Game" g ON g."id" = s."gameId";
DROP TABLE "SaveSyncState";
ALTER TABLE "new_SaveSyncState" RENAME TO "SaveSyncState";
