CREATE TABLE "SaveSyncState" (
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "payload" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("userId", "gameId"),
    CONSTRAINT "SaveSyncState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SaveSyncState_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
