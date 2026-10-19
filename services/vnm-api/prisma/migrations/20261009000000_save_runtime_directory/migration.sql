CREATE TABLE "SaveRuntimeDirectory" (
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "directory" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("userId", "gameId"),
    CONSTRAINT "SaveRuntimeDirectory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SaveRuntimeDirectory_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
