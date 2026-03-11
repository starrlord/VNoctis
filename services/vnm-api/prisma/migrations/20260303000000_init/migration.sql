-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "directoryPath" TEXT NOT NULL,
    "directoryName" TEXT NOT NULL,
    "extractedTitle" TEXT NOT NULL,
    "vndbId" TEXT,
    "vndbTitle" TEXT,
    "vndbTitleOriginal" TEXT,
    "synopsis" TEXT,
    "developer" TEXT,
    "releaseDate" DATETIME,
    "lengthMinutes" INTEGER,
    "vndbRating" REAL,
    "coverPath" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "screenshots" TEXT NOT NULL DEFAULT '[]',
    "buildStatus" TEXT NOT NULL DEFAULT 'not_built',
    "buildJobId" TEXT,
    "builtAt" DATETIME,
    "webBuildPath" TEXT,
    "metadataSource" TEXT NOT NULL DEFAULT 'unmatched',
    "metadataFetchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BuildJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "logPath" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ScanJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'running',
    "gamesFound" INTEGER NOT NULL DEFAULT 0,
    "gamesNew" INTEGER NOT NULL DEFAULT 0,
    "gamesRemoved" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "Game_directoryPath_key" ON "Game"("directoryPath");
