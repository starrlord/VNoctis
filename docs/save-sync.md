# Ren'Py Web save synchronization

The authenticated `/play/:gameId` player synchronizes browser saves with VNoctis.
Saves are keyed by the authenticated user ID and stable database game ID, independent
of the web-build directory. Rebuilding or removing build output does not remove
server snapshots. Removing a library Game retains its snapshots as orphaned saves;
rediscovering the same game ID makes them available again. Deleting a User still
deletes that account's snapshots by cascade.

## Persistence investigation

The deployment defaults to Ren'Py 8.5.2. Its official web package's `renpy-pre.js`
mounts Emscripten IDBFS at `/home/web_user/.renpy` and calls `FS.syncfs(true)`
under an `initFs` run dependency before Python starts. The compiled `renpy.js`
uses IndexedDB database version 21 with a `FILE_DATA` store; its default database
name is the mountpoint, shared by every game on that origin. LocalStorage is used
for web cache bookkeeping, not save bytes.

Numbered, quick, and auto slots are complete save files (including metadata,
screenshots, log and signatures). Persistent progress and preferences live in
`persistent`; token keys and upgrade metadata live in the mount's `tokens` folder.
Copying slots alone would miss persistent data and its verification keys.

Sources: [official 8.5.2 web package](https://www.renpy.org/dl/8.5.2/renpy-8.5.2-web.zip),
[save location](https://github.com/renpy/renpy/blob/8.5.2.26010301/renpy/savelocation.py),
[persistent data](https://github.com/renpy/renpy/blob/8.5.2.26010301/renpy/persistent.py),
[tokens](https://github.com/renpy/renpy/blob/8.5.2.26010301/renpy/savetoken.py).

## Integration

- `services/vnm-ui/src/pages/Player.jsx` loads the same-origin game iframe and
  displays bridge status. `useAuth.jsx` supplies the user; `useApi.js` describes
  the existing bearer-token convention.
- `services/vnm-ui/nginx.conf` serves `/web-builds/` from the shared volume and
  injects `/save-sync.js` at `<head>`, before Ren'Py scripts. This covers locally
  built exports, manually registered prebuilt builds, and scanned prebuilt web
  directories without editing their files.
- The bridge attaches an Emscripten `preInit` hook, redirects IDBFS's database
  name to `vnm-saves:<user>:<game>`, and wraps `FS.syncfs`. It leaves the filesystem
  paths expected by Python unchanged. Restoring finishes before the original
  populate callback releases the startup dependency.
- Backend routes follow the Fastify plugins and global JWT authentication in
  `services/vnm-api/src/index.js`. All authenticated users can access the shared
  library, including hidden games, as with the existing library detail route.
- Build paths are handled by `services/vnm-builder/src/builder.py`,
  `services/vnm-api/src/routes/import.js`, `routes/library.js`, and
  `services/scanner.js`; no build/import post-processing change is needed.

## API and storage

`GET /api/v1/games/:gameId/saves` returns the live revision, snapshot, slot
checksum, and current history version ID. An absent record has revision zero and
a null snapshot. `?uploadId=...` also returns that upload's durable receipt.
Responses are not cacheable. `deltaUploads: true` advertises changed-file upload
support; bridges using older APIs keep sending complete snapshots.

`PUT /api/v1/games/:gameId/saves` accepts `{ revision, snapshot, uploadId,
baseSaveChecksum, deviceLabel, alternate, branchId }`. It returns the accepted
revision, current server revision, history ID, and `current` or `alternate`
disposition. A snapshot is `{ version: 1, files: [{ path, mtime,
data }] }`, where paths are relative to the mount, times are milliseconds, and
data is opaque base64. Directories are reconstructed. Empty directories are not
required for save validity. Deletions are represented by absence from the next
complete snapshot.

When its full baseline is known, the bridge sends `delta: { version: 1,
files: [changed files], deleted: [relative paths] }` instead of `snapshot`.
The API applies it atomically only at exactly the submitted revision, validates
the complete resulting tree and size, and retains a complete history version.
Stale revisions return `SAVE_BASE_CHANGED` before any write. The bridge durably
switches that request to its retained full snapshot and retries through normal
alternate-preservation logic. Successful delta receipts are checked before
revision checks, so lost acknowledgements remain idempotent after later saves.

`SaveSyncState` stores a compact file-hash manifest and SHA-256 checksum in SQLite.
`SaveCurrentFile` references the same content-addressed `SaveFileBlob` rows as
history, including current-only preference changes. Live updates therefore write
new file bytes and small references rather than rewriting every unchanged slot.
Legacy inline snapshots remain readable and convert atomically on their next
upload or restore. Cleanup protects blobs referenced by either history or live
state. This uses the existing SQLite backup/migration path. Initial imports,
unknown baselines, alternate continuations, and stale-delta fallbacks send the
full save tree. Ordinary acknowledged updates send only changed files/deletions.
Limits on the complete resulting tree are 128 MiB decoded bytes, 4096 files,
512-character relative paths, and an approximately 179 MiB HTTP body allowance
for base64 encoding and metadata. Files are never unpickled,
unzipped, or written to server filesystem paths.

Permanent upload rejections pause automatic retries while retaining the pending
upload and latest browser saves. Temporary outages still retry. Invalid expanded
deltas retry once using their preserved full snapshot; validation errors identify
oversize data or malformed file trees instead of reporting an offline connection.
Reopening the game retries retained progress after the server problem is fixed.

Creation uses a unique `(userId, gameId)` key. Save transactions are serialized
for SQLite and store live state, immutable history, and receipts together. A stale
writer can advance live state only when the server's actual slots still match its
acknowledged baseline, or its incoming slots already match the server. Otherwise
its snapshot is preserved as an alternate without replacing live state. The
server ignores body user IDs and derives identity
from the existing verified session. Parameter validation and a game existence
check precede save access.

## Migration, failures, and conflicts

An existing isolated local tree with no server record imports automatically.
Legacy IDBFS storage has no user/game ownership information, so it is never
silently assigned. On first use without either a server or isolated local copy,
the startup prompt offers only the current game's verified save directory when
matching legacy saves exist. It uses runtime or build metadata for the current
build, matches the complete directory path, and never lists unrelated games.
Choose to copy that directory and token files, or continue without importing.
Unknown directories proceed without a prompt; rebuilding captures eligible
settings before launch. Runtime metadata from a previous launch can also identify
the destination. The legacy database stays untouched. This convenience assumes the usual
single-user deployment: legacy data has no account ownership, so a matching
directory cannot establish who created it. On shared browsers, import only saves
you own.

Offline edits keep their last acknowledged server revision and a dirty flag.
Browser filesystem writes remain immediate. Written or atomically renamed
`.save` slots schedule a browser filesystem flush after the engine's synchronous
writes finish, without waiting for its periodic flush. They trigger a server
upload as soon as that flush succeeds. A slot written during an upload follows immediately after its
acknowledgement. Persistent-only writes are batched every five seconds, and
failed uploads are retried on that interval and on reconnect. Closing or killing
the tab during a transfer can still interrupt it; unacknowledged browser data
remains dirty for the next launch. Unchanged file contents and timestamp-only
touches do not upload or increment the server revision. Persistent-only changes
still synchronize even when no numbered save slot is created. The status remains
steady for fast uploads; “Syncing…” appears if a transfer takes over half a second.
The player notice disappears after four seconds and can be dismissed immediately.
Successful uploads containing newly written or changed Ren'Py `.save` slots
(numbered, quick, or auto saves) briefly show “Save synced,” including consecutive
saves with the same status text. Persistent-only updates, unchanged flushes, and
slot deletions do not bring it back. New offline/conflict/error
states briefly reveal it for eight seconds; recovery reveals it for four seconds.
Requests time out after eight
seconds; failure does not block gameplay or erase browser data. On reload, dirty
local data is retained if the service cannot be reached. The browser records the
exact acknowledged `.save` bytes and server slot checksum in IndexedDB. On launch,
pending uploads are acknowledged or replayed first. Unsynced actual save progress
then uploads normally or is archived as an alternate if another device advanced.
The current server snapshot loads automatically afterward; there is no blocking
save-conflict choice. Unsynced seen-text/preferences alone do not create divergent
save progress. A running game can keep playing its alternate continuation and
back up subsequent slot changes; the next launch returns to synced saves.
Older `vnm-save-backups` databases are left untouched, but new recovery copies are
kept in server history instead.

Pending requests retain their upload ID, revision, and exact snapshot in the
`vnm-save-outbox` IndexedDB database. Retrying an acknowledged upload returns the
same accepted revision when its ID and checksum match its receipt, even if another
device advanced or that history version expired. Reusing an ID for different
bytes is rejected. On launch, a receipt also acknowledges a lost response. Offline save
writes remain local and retry after connectivity returns; the game itself still
needs its assets available to run offline.

`pageshow` and return to visible state restart exactly one retry timer and attempt
pending uploads. Hiding/leaving a page also attempts an upload, but browser
termination cannot guarantee delivery.

## Server save history

Both library and gallery game launchers have a **Save history** button. The list
belongs to the signed-in user and that game, including for administrators; admins
do not see other users' active-game history here. Versions show save type, device
label, time, logical snapshot size, and a Current badge. Download exports a ZIP
containing the original binary files at their relative paths (slots, persistent
data, and signing keys). Extract the game's folder and copy its contents into
the matching native game's save folder; signing keys belong in Ren'Py's tokens
folder. The underlying API JSON snapshot remains available for sync clients.
Restore is confirmed and creates a new live version, preserving the
exact prior live tree. It is used on the next game launch. A stale restore dialog
must refresh rather than overwrite an intervening save. Non-current versions can
be explicitly deleted.

**Import save folder** selects one game's native save folder. **Choose files
instead** supports browsers without folder selection and lets users include
`persistent` and `security_keys.txt` alongside `.save` files. The preview maps
them to the game's known web save directory, lists selected
files, and reports skipped unrelated files. Import requires confirmation and a
matching live revision, backs up exact prior progress, creates an `imported`
history version, and replaces live slots for the next launch. Existing signing
keys are retained if none were supplied. Repeated requests reuse an upload
receipt. Paths, file count, file types and aggregate size are validated;
compatibility with the chosen game/version is the user's responsibility.
Imports and explicit restores share the last-40 manual version retention.

After startup the bridge reads `config.savedir` from the running engine and
records its path relative to `/home/web_user/.renpy`, separately for each user
and game. This does not create a save or a history entry, and retries after an
offline launch. Existing snapshots with only `persistent` can also identify a
single destination; a `sync` mirror is excluded when its parent is present.
The selected desktop folder's name is never used to guess the web destination.
For an unknown or ambiguous directory, launch the game once and reopen history.
An advanced manual entry remains available for a verified runtime directory.
Known destinations are read-only, and imports are rejected if the recorded
runtime directory changed after the preview. Saves go directly in the configured
directory; no extra `saves/` suffix is added. Directories outside the bridge's
mounted root are not recorded automatically.

New web builds also capture a single top-level literal `config.save_directory`
declaration using the SDK's existing initialized build reflection pass. The
capture requires the effective setting to match the literal and the default
save-path resolver. Computed, conditional, multiple, custom-path, or unavailable
source declarations remain unknown and use runtime detection. A temporary build
hook and its JSON output are excluded from the distribution; all build modes use
an overlay with writable scripts/progressive rules copied away from source links.
The successful build callback stores the directory on the game, making it
available to every user's import preview before first play. Existing builds need
rebuilding to obtain this metadata; runtime and snapshot fallbacks still work.

Runtime metadata takes priority over build metadata. Successful rebuilds clear
old runtime reports, and new reports must match the player's build timestamp.
Stale open tabs cannot replace the new metadata; rejecting their directory report
does not pause their save uploads. Snapshots predating a rebuild are not evidence
of its new destination, and refreshing an unknown destination clears the previous
folder field. First-launch restores create directories and
write imported files before Ren'Py continues startup and scans its save slots.

History is outside Ren'Py's mounted filesystem. The engine's rotating ten
autosave slots and original filenames are unchanged. A historical restore
reconstructs exactly that version's original slots, persistent data, and tokens;
it never adds ninety autosave files to the live folder.

`SaveVersion` metadata and `SaveVersionFile` manifests refer to `SaveFileBlob`
rows keyed by SHA-256 of decoded file bytes. Identical content is shared even
across renamed/rotated slots. Uploads check existing blob hashes before inserting
bytes, so unchanged files are not passed back to the database. Retention scans
for unused blobs only when versions are removed, plus the periodic sweep.
Removing versions garbage-collects only blobs with
no remaining history or live references. Each history manifest is immutable;
the live manifest remains separate. Existing synced data is archived lazily on
first access/replacement.
History cannot recover saves overwritten before deployment.

Retention is applied on writes/history access and by hourly maintenance:

- Autosave/checkpoint versions from the past 24 hours: keep all.
- Older versions through seven days: keep the newest per hour containing saves.
- Older versions through thirty days: keep the newest per day containing saves.
- Manual/quick saves, imports, and explicit restores: keep their newest 40 independently.
- Current live version: always keep.
- Unresolved alternate continuations: keep until explicitly restored or deleted.

Hour/day buckets use UTC; the UI displays dates in the browser's local timezone.
Restoring an alternate resolves its continuation's earlier alternatives too;
those retained snapshots then follow their normal time/count policy. Actual slot
changes (including deletion) create history. Persistent-only writes keep syncing
but do not fill history. An initial checkpoint or pre-restore backup can capture
the complete current tree separately. Small upload receipts are retained until
the user or that game's orphaned saves are deleted, independently of history
expiry, so retries remain idempotent.

History captures snapshots received by the server. While offline, Ren'Py retains
its normal local rotating slots and the bridge retains pending/latest progress;
it does not archive every intermediate offline autosave. The latest offline
continuation is preserved when connectivity returns. Game assets must already
be available for offline play.

## Orphaned save administration

The admin navigation's **Saves** button opens an overlay styled like Import Game.
It lists orphaned snapshots by game title, owner, date, and stored size, with
download and individually confirmed deletion. Active games are excluded.
Each API operation verifies the current database admin role. A deletion checks
both the listed revision and continued absence of the game in one atomic SQL
statement, so a stale overlay cannot purge a returned game's saves. Lists are
paged at 50 entries; full payloads are fetched only for downloads.

Deleting orphaned saves also deletes that user's history and receipts for the
game, without removing shared content still referenced by another user/version.
The orphaned-save API returns the current versioned JSON snapshot containing opaque save bytes and game
identity, not a native Ren'Py save ZIP. No reassignment/import UI or active-game
purge is included. The live snapshot has no automatic expiration; history follows
the retention policy above. Renaming a
game directory changes its fingerprint ID, so it does not automatically reclaim
the old directory's saves.

Do not bump revisions to force a divergent upload into live state: it must be
preserved as an alternate instead. Login changes cannot make an old running game's bridge upload
its files using a new account's token.

## Compatibility and limits

The verified runtime is Ren'Py 8.5.2 with its standard HTML shell and IDBFS globals.
Compatible prebuilt ZIPs receive the same injection when served by VNoctis;
importing a prebuilt ZIP still uses existing import/scan/register behavior.
Custom HTML without a `<head>` tag, different runtime storage, a bridge blocked
by CSP, or cross-origin game hosting displays the player fallback status. Such
builds keep their original browser-local storage behavior and do not synchronize.
R2 public galleries are cross-origin and unauthenticated; they are outside this
feature. Direct game URLs without the player parameters also remain local-only.
Full offline preparation is explicit in the per-user dashboard; ordinary on-demand caching alone does not make a game ready offline.
If a game update changes its own `config.save_directory` or save compatibility,
the old snapshot remains stored, but VNoctis cannot make the new game interpret it.

Existing Ren'Py service workers match cached requests including their query
strings. Player URLs include user/game parameters and the SHA-256 version of the
bridge, so they do not reuse older game HTML after a bridge update. The UI image
injects the same version into the bridge script URL, and the manager entry HTML
requires cache revalidation to discover its latest hashed React assets.
Avoid custom service workers that strip queries or
serve HTML from another build. Original third-party games already execute with
same-origin script access; storage namespaces are account isolation for normal
operation, not a sandbox against malicious game JavaScript.

## Validation

Run `npm test` in each service and `npm run build` in `services/vnm-ui`.
Builder metadata tests run on Linux with `python -m unittest discover -s test -v`
in `services/vnm-builder`; they verify literal detection, conservative fallback,
source protection, reserved filenames, and distribution exclusions.
Run `npm run test:player` in the UI for the built React player plus bridge test
in mobile-sized Chromium. It verifies that the startup toast disappears,
persistent-only uploads stay quiet, consecutive save acknowledgements become
visible, and notices can be dismissed. It also verifies the admin overlay and
library/gallery history download/restore controls, including mobile sizing and
nested modal dismissal. This uses a filesystem fixture, not a VN.
Set `CHROME_PATH` to an existing Chrome executable or install Playwright Chromium.
API tests apply all committed SQL migrations to a temporary SQLite database,
then verify authentication gating, user/game isolation, stale and concurrent
writers, traversal/payload limits, build-path changes, retention across 90 rotating
autosaves, deduplication, exact restoration, orphan retention/admin cleanup, and
account deletion. History/restore access is isolated by both user and game.
Bridge tests exercise device handoff, offline save/reload/reconnect, competing
sessions, selected-folder legacy import, and declining import.

For the real-runtime browser check, unpack the official web SDK, set
`RENPY_WEB_RUNTIME` to its `web` directory, and run `npm run test:renpy` in the UI.
Install Playwright Chromium with `npx playwright install chromium`, or set
`CHROME_PATH` to an existing Chrome executable. This test uses the actual
Ren'Py HTML, JavaScript, WASM, filesystem, and IndexedDB in fresh browser contexts.
It suppresses Python/game startup because no game ZIP is needed; it verifies the
original `initFs` startup gate, byte-preserving handoff, and account/game isolation.

Before release, test a representative VN through its normal numbered, quick,
auto save/load UI, persistent preferences, and a compatible imported prebuilt
ZIP. Repeat the handoff between physical devices, including mobile Safari.
These full gameplay/device checks require game fixtures and are not covered by
the filesystem integration test.

## Browser processing and autosave performance

### Incremental startup downloads

On HTTPS and localhost, the bridge requests `GET /games/:gameId/saves?manifest=1`
instead of the full base64 snapshot. The response includes `fileDownloads: true`
and a version-1 manifest of `{path, mtime, hash, size}` records, together with the
existing revision, directory, checksum and upload-receipt information. A null
manifest means there is no server state; an empty manifest is an existing empty
state. Older clients can continue using the original snapshot endpoint.

The bridge hashes the populated user/game browser filesystem in its save worker.
Matching bytes are reused even when autosave rotation moved them to another
filename. Missing content is requested as binary data from
`GET /games/:gameId/saves/files/:hash?revision=N`, verified against SHA-256 and
size, and assembled before changing the engine filesystem. Unchanged resident
files are not rewritten. Deletions follow the complete manifest.

Both endpoints require the authenticated account and an existing game. Binary
access requires a current-file association for that account/game and the exact
revision; a globally known hash or another user's history grants no access.
Responses use `Cache-Control: no-store`. A changed revision returns 409 with
`SAVE_MANIFEST_CHANGED`; startup retries the manifest once. Inline legacy states
remain readable without a schema migration. Receipts, offline alternatives and
pending-upload recovery retain the existing protocol.

Incremental transfers underpin guarded latest-slot-first startup, described
below. Existing browser files and a bounded verified memory cache provide reuse;
a separate persistent immutable cache/readiness dashboard remains future work.
Without Web Crypto (for example, an insecure HTTP LAN origin), or with an older
API, the bridge retains the complete-snapshot download fallback. Download failures
use the existing `vnm-save-status` messages and `SaveSyncToast`, not a second toast
implementation. Existing builds retain complete hydration; rebuilding with the
updated builder enables the version-gated engine adapter where supported.

### Explicit server-save preparation

`public/save-offline.js` exports `createSavePreparation` for the per-user
dashboard. It can prepare saves without starting Ren'Py: fetch the manifest,
download individual immutable files with two concurrent transfers, verify their
sizes/SHA-256 hashes, then recheck the server revision and build. Unchanged
verified files are reused. Cancellation, quota errors, changed server state,
dirty local progress or pending uploads prevent successful preparation.

Prepared bytes live in the separate `vnm-prepared-saves` IndexedDB database,
scoped to the authenticated user/game. Save readiness rehashes the actual files,
rather than trusting a stored completion flag. New browser progress does not
discard an otherwise complete checkpoint: the dashboard reports "Available
offline · sync pending" while the bridge retains engine/outbox progress. A
checkpoint older than a known acknowledged revision cannot establish readiness. It identifies the captured
server revision/build and preparation time, not ongoing server freshness or
complete game/app availability. Cleanup also removes interrupted transfers for
that scope; it never deletes engine saves or pending uploads. Retained immutable
copies may use additional disk space until that scope is cleared.

The bridge uses verified prepared files for matching server-manifest hashes.
After transient startup failures, a clean session may restore the explicit
prepared checkpoint locally. It refuses older revisions or a different known
same-revision baseline, never replacing newer acknowledged browser progress.
Dirty/pending sessions retain the existing filesystem/outbox recovery path.
The status is `Offline — using prepared saves`, not a successful server sync.

### Preparing and managing offline games

Open **Dashboard → Prepare a game**, choose a completed local build and select
**Prepare offline**. The estimate covers game bytes, with saves added separately.
Preparation downloads the public app shell, all listed game assets and the current
account's complete save checkpoint. Two concurrent transfers stream game assets
to Cache Storage with incremental SHA-256 verification; a large archive does not
need one equally large ArrayBuffer. Previously verified files are reused. The
HTML bridge reference is refreshed when the app changes, even if the game has
not been rebuilt. Cancellation retains completed files for the next attempt.
Quota failures and interrupted downloads cannot publish a completeness marker.

The builder writes `.vnm-offline-manifest.json` after the SDK finishes. Existing
games need one rebuild with this builder before full offline preparation is
available. The authenticated `offline-manifest` and `offline-file` routes bind
original bytes to a completed build; Nginx denies direct access to private
`.vnm-*` files. The public `cache-build` route exposes only build identity and
status for the on-demand asset worker. R2/cross-origin builds are excluded.

The dashboard tracks games per authenticated account. Public game assets are
physically shared on this origin, while save checkpoints, runtime saves and
pending uploads are scoped to the account and game. Removing downloads removes
that account's library entry; physical assets remain if another account still
uses them. It keeps engine saves, prepared save checkpoints and pending uploads.
Updating a game retains the previous complete entry until the replacement
finishes, then unpins obsolete builds so unused copies can be removed. A running
old-build tab remains protected by the worker's client check.

A normal dashboard check verifies the app shell and prepared save bytes, checks
the game completion receipt, and confirms every listed game asset still exists.
**Verify** additionally streams and rehashes all game bytes. Corruption or
missing files removes readiness; **Update offline files** repairs them. Readiness
refers to a captured build/save checkpoint, not perpetual server freshness. After
new online saves advance the acknowledged revision, update preparation again.
Unsynced browser progress is preserved and remains playable offline; preparation
will not replace it. Open the game online to let it sync before refreshing the
server checkpoint.

The root app worker caches public app files only, never API/auth responses. A
closed tab can reopen `/dashboard` or a retained player route offline using the
last server-verified account profile and its unexpired token. Logout, an account
change or a real 401/403 denial invalidates that fallback. Offline profiles have
no administrative privileges. Reconnect to renew an expired session. This is
normal shared-browser account isolation, not protection against malicious
same-origin scripts or someone with browser developer access.

**Protect downloaded files** requests persistent browser storage and explicitly
reports a refusal; browsers may still remove ordinary storage or users can clear
it manually. Physical mobile/Safari eviction and persistence policies still need
device validation. Desktop Chrome tests cover a fully disabled network, closed-tab
app/game reopening, native Continue, pending progress, separate accounts,
corruption/eviction repair, shared cleanup, cancellation/resume and denial of an
invalid session. Existing browsers without preparation continue through the
ordinary bridge without downloading the optional preparation module.

### Preview catalogs and coordinated transfers

The API also advertises `previewDownloads: true` and serves
`GET /games/:gameId/saves/files/:hash/preview?revision=N`. It uses the same
account/game ownership and revision checks as binary downloads and requires a
current `.save` association. The result is `{version: 2, supported, metadata,
screenshot}`, with an optional PNG thumbnail encoded as base64. Unsupported or
invalid formats return `supported: false` so the lazy-slot adapter can
fall back to the original complete save instead of inventing an empty slot.

Extraction reads only ZIP directory entries, bounded JSON (64 KiB) and a bounded
PNG (4 MiB, at most four million pixels). Large thumbnails are normalized with
Sharp to fit 384×216, with a 256 KiB output limit, without changing the original
save bytes. This accommodates native web saves whose PNG is stored uncompressed
inside the deflated ZIP. It verifies lengths and ZIP CRCs;
deflate runs asynchronously with a bounded output length. It never reads or
deserializes the pickled game-state log. Encryption, ZIP64, legacy TGA-only
previews and unsupported archive layouts fall back. Results, including unsupported
markers, persist in `SaveFileBlob.preview` and disappear when the blob is pruned.
Older preview cache versions are regenerated on the next authorized request.
The `20261016000000_save_previews` migration adds this nullable cache column.
Cache hits recheck authorization and do not read the full blob contents.

The bridge now coordinates two concurrent content transfers, joins requests for
the same revision/hash, supports queued foreground priority and independent
consumer cancellation, and retains a bounded 16 MiB memory cache of verified
content. Cancelling all consumers aborts their transfer. A failed verification
or changed account never populates the cache. Retries can reuse already verified
content. This cache contains downloaded copies only, not pending upload data;
evicting it cannot discard local progress. Installation still belongs to the
engine thread, separately from content fetching.

Preview queries use bounded concurrency and deduplicate identical hashes.
Unsupported previews hydrate their complete slot before startup. Excessive
preview catalogs fall back to complete hydration rather than allocating an
unbounded collection of thumbnails.

### Logical snapshots for partially cached folders

The API advertises `referenceUploads: true`. A PUT can contain `fileSnapshot`
instead of `snapshot` or `delta`, with an upload ID and the usual revision,
checksum and branch metadata:

```json
{
  "version": 1,
  "baseVersionId": "an-authenticated-history-version",
  "files": [
    { "path": "Game/1-1.save", "mtime": 1000, "data": "bmV3IHNhdmU=" },
    { "path": "Game/auto-2.save", "mtime": 900, "hash": "<64 lowercase hex characters>", "size": 800000 }
  ]
}
```

This describes the complete **logical** folder, not the browser's resident subset.
Each entry contains either new base64 bytes or a hash/size reference authorized
by `baseVersionId` for this account and game. References can move between paths,
so autosave rotation/copying needs no download. Knowing a blob hash, another
account's baseline, or another game's baseline grants no access. The server
expands and validates the complete folder before using the existing history,
revision and receipt transaction. Stale offline progress is archived against its
own baseline, never assembled from the current device's different progress.
Receipt identity is independent of file ordering.

Manifest requests ensure a readable baseline version exists. History retention
still applies: a pruned/missing baseline returns `SAVE_REFERENCE_BASE_MISSING`.
Receipts are checked first, so a committed retry remains acknowledged even after
that baseline is gone. The sender can retry as a complete snapshot using verified
local bytes for **every** logical reference, preserving its upload ID. If any
referenced bytes are unavailable, syncing pauses and retains the pending request
and browser progress. It does not drop uncached slots or repeatedly send failures.
This explicit retention limit must remain visible when lazy/offline mode ships.

The bridge persists its logical catalog in the per-user/game `catalogs` store
in outbox database version 3. When the server advertises reference uploads and
Web Crypto is available, it generates logical snapshots from hash-verified
resident files and the captured catalog. Other servers/origins retain the
previous full/delta protocol. Signing/persistent files retain their bytes rather
than depending on an older slot baseline. Local catalog recovery data never
travels in the API request.

If the account/game's engine filesystem is empty but its pending-upload backup
survives, startup restores those backed-up resident files before contacting the
server. Cached progress therefore remains loadable during a save-service outage.
A populated engine filesystem is retained because it may contain newer writes.
This cannot recover data if browser storage eviction also removes the outbox.

Filesystem rename/unlink hooks maintain explicit aliases/deletions. Native
filesystem flushes capture catalog state and persist it only after their storage
operation succeeds. Monotonic ordering prevents an older callback from replacing
a newer catalog. Unchanged catalog generations do not cause repeated database
writes on routine engine flushes. Hashes are cached with unchanged worker bytes.

Request preparation checks both filesystem mutation and catalog generation.
Acknowledgements merge current resident writes before advancing the baseline,
persist the updated catalog/checkpoint, and then clear the acknowledged outbox
entry. A write during an upload remains dirty and follows it; lost responses
reuse the exact persisted logical request and receipt on reload. These are
ordered recovery writes across the existing databases, not a single transaction
shared with the engine's IDBFS store.

### Version-gated latest-slot startup

The builder checks normalized source fingerprints for the researched Ren'Py
8.5.2.26010301 `loadsave.py` and `savelocation.py`. It generates an early private
module in the temporary build overlay and advertises capability only after
confirming that the compiled adapter exists in the published `game.zip`.
Unrecognized SDK sources retain complete hydration. The runtime also checks its
version; direct game URLs without an authenticated bridge keep native behavior.
Imported prebuilt games and existing builds without the marker use the fallback.

On a clean launch with matching build/directory metadata and capable endpoints,
the bridge retrieves the manifest, previews, required support/signing data and
the newest loadable canonical slot. Verified resident files are reused. Metadata
and thumbnails expose other slots immediately. It does not automatically load
the newest slot or bypass the menu. Dirty/pending-upload recovery deliberately
uses the complete hydration path before replaying the existing preservation
protocol. Transfers remain individual binary requests.

The native location adapter supplies catalog-only slot listing, timestamps, JSON
and screenshots. Missing selected slots wait cooperatively for a verified exact
file through the coordinator. A cancellable HTML loading overlay covers this
wait; failures return through a narrow, trusted SDK-generated abort boundary in
load/get_save_data, preserving current progress and posting the existing player
toast. Repeated identical failures restart the same toast's visibility timer.
The version-sensitive abort boundary preserves original function objects/aliases;
it is intentionally limited to the pinned SDK rather than a generic Ren'Py API.

After startup, two bounded prefetch workers fill missing files individually.
Hydration installs only when the alias still has the expected hash and no newer
local file replaced it. Installation does not trigger a save upload. Binary
`GET /games/:gameId/saves/versions/:versionId/files/:hash` checks history ownership
by account/game and pins the requested immutable version across later autosaves;
history retention still applies. Local pending bytes remain separate from cache.

Canonical copy/rename/delete operations update remote aliases even without local
bytes. Matching `sync/` mirrors do not force eager downloads or rotate twice.
When a remote-only source replaces a resident destination, the stale destination
is invalidated so the native scanner cannot revive old bytes. Logical hash-based
checkpoints distinguish cache growth from new progress during offline recovery.

Validation includes a synthetic native game built with the production adapter,
the real bridge/worker, authenticated fixture transport and migrated SQLite API:
latest-only startup, metadata for seven slots, delayed native FileLoad, saving
while five old slots are uncached, failed-load preservation/toast/retry, remote-only
autosave rotation, and native QuickLoad after background prefetch. Isolated
Abnormal/LTA web builds also passed latest-only startup, native load and save
checks. Native recovery checks cover warm partial-cache restarts, save-service
outages, cached/uncached loads, pending progress across tab closure and engine
database loss, reconnection, lost acknowledgements and competing device progress.
Those recovery tests keep runtime/game assets available. Separate full-app
Chrome tests disable all HTTP and verify closed-tab native offline launches.
Physical mobile/Safari, custom save backends and other SDK versions remain
release-validation gates.

Save requests allow 60 seconds for the network operation, including reading the
response body. Upload preparation completes before that timer starts. Startup
downloads retry a transient network, timeout, or server failure once before
allowing the game to continue using its browser copy. Later uploads never imply
that the server snapshot loaded successfully, and do not replace a running
game's files with server progress. Reopen the game to retry a failed startup.
Console warnings identify download, upload, preparation, restore, or storage
failures without including credentials or save data. Authentication failures
pause syncing and ask the player to sign in again.

Native browser filesystem flushes share a serialized queue, including bridge
hydration/checkpoint flushes. Consecutive pending writes coalesce into one native
flush while every caller still receives its callback. A slot written or removed
during an active flush retains a follow-up flush rather than losing its pending
persistence signal. The callback-only `FS.syncfs(callback)` overload also remains
a write flush.

The pinned runtime can report `ErrnoError` 44 (missing file) when autosave rotation
removes a path between IDBFS's local-tree scan and asynchronous reconciliation.
A failed write flush retries up to three times with short backoff only if tracked
filesystem writes, renames or deletions changed the tree during that attempt.
Populate operations, unchanged missing paths, and quota/permission failures are
not retried this way. Persistent failures still reach callers and diagnostics;
filesystem error numbers are included even when the engine supplies no message.

Routine snapshot byte comparisons, base64 encoding, and large JSON serialization
run in a dedicated Web Worker. The bridge copies filesystem bytes on the game
thread and transfers owned buffers, leaving engine memory intact. Writes made
during worker processing remain dirty and follow the acknowledged upload;
acknowledgement reuses its validation scan instead of scanning a third time.

Browsers that block workers use the original synchronous processing fallback.
A crashed worker falls back without discarding local saves or the pending outbox.
This moves VNoctis save preparation, not Ren'Py's own autosave serialization,
filesystem access, or IndexedDB persistence. Those can still cause pauses.

Run `npm run test:save-worker` in `services/vnm-ui` for native-browser checks of
worker processing, writes during preparation/acknowledgement, retained engine
buffers, and blocked/crashed worker fallback. Set `PLAYWRIGHT_CHANNEL=chrome`
to use an installed Chrome instead of Playwright's bundled Chromium.

## Portable save backups

Save History **Download backup** exports a selected snapshot as a VNoctis ZIP.
Use **Import backup ZIP** in that game's Save History to restore it. These ZIPs
are intended for reimport into VNoctis; desktop-game compatibility is not
guaranteed. Native folder/file import remains available separately. Older raw
Save History ZIPs are also accepted, with an explicit destination game.

Dashboard **Save backups** exports the signed-in account's current saves and
retained history across all games. Administrators can select **All users** for
backup and restore. A versioned manifest records source accounts, game identities,
runtime save directories, current snapshots, history metadata and file hashes.
Original binary bytes, including persistent data and signing keys, are stored
once per SHA-256 hash. Keep the ZIP intact rather than extracting it. Backup
files contain private progress and signing keys; they contain no account
passwords, roles, game assets or unsynced browser-only progress.

Import first verifies the entire ZIP in a worker, then shows a review before
writing saves. Personal imports always target the signed-in account. An admin
restore matches existing usernames and allows explicit account mappings; missing
users are created as viewers with random, unknown passwords. Set their passwords
through Users after restoring. Existing account passwords and roles stay intact.
Source user IDs are never used as destination IDs merely because they match.

Games match their stable directory-derived identity, never just a display title.
Missing games retain their saves and directory metadata in `SaveGameIdentity`,
which has no Game foreign key. They remain exportable and become available when
the corresponding game is installed under the same directory name. A changed
server root does not matter; a renamed game directory requires explicit mapping.
For example, restoring all saves into an empty library, installing games one and
two later and never installing game three retains all three games' saves. User
ownership remains attached to the reviewed destination accounts throughout.
Explicit mapping to a game with a different known runtime save directory remaps
that path prefix without changing file contents.

Existing current progress is kept by default while backup versions enter history.
An explicit replacement preserves the old current version first. If current
progress changes after review, the newer progress wins and the import reports
that the backup is available in history. Close affected games before restoring.
Imports commit in bounded per-version/per-game transactions; a partial failure
reports affected games rather than undoing successful records. Reimporting the
same package deduplicates its historical versions. Normal history retention
applies afterward; this is not an unlimited-history storage mode.

The `/api/v1/save-backups` routes create background tasks for exports and import
verification/application. Bulk export uses a consistent SQLite backup; a single
snapshot uses a bounded read transaction. ZIP I/O and verification run in Node
workers, and downloads stream natively without buffering the archive in browser
JavaScript. A short-lived, one-use download capability replaces JWTs in download
URLs. Job ownership and current administrator privileges are checked server-side.
Completed downloads and reviewed imports survive API restarts; interrupted work
is marked interrupted and can be started again. Import application is not blindly
replayed after a restart.

Temporary ZIPs, verified blobs and task records live under `/data/save-backups`
(`SAVE_BACKUP_PATH` can override this) and expire after 24 hours. Removing a
completed task removes only those temporary files, not restored saves. Ensure
space for the SQLite snapshot, ZIP and import staging. The supported limits are
16 GiB per ZIP, 128 MiB per snapshot, 4,096 files per snapshot, 200,000 unique
files, 10,000 game/account records and 50,000 historical versions. Exceeding a
limit fails the task with an error rather than silently dropping data.

## Separate upstream issue

The existing migration history lacks the Game `publishStatus`, `publishedAt`, and
`publishedVersion` columns present in the Prisma schema. Startup adds them only
in R2 mode. This predates save sync; the new migration intentionally does not
include an unrelated schema fix. The tests use the migrated baseline and id-only
game queries to verify save sync independently. Existing local deployment
permission overrides and Prisma repair steps should remain separate.
