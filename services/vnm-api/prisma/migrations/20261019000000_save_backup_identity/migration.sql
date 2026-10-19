CREATE TABLE "SaveGameIdentity" (
 "userId" TEXT NOT NULL, "gameId" TEXT NOT NULL, "directoryName" TEXT,
 "gameTitle" TEXT NOT NULL, "saveDirectory" TEXT,
 PRIMARY KEY ("userId", "gameId"),
 CONSTRAINT "SaveGameIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
