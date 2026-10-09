# Retained game downloads

VNoctis retains the game engine, startup archive and complete assets requested
during normal play. Later launches reuse these bytes, including after restarting
the browser. Games still start Ren'Py afresh. This does not pre-download unvisited
assets or provide a complete offline VNoctis interface.

Signed-in users can open **Your dashboard** from the library or gallery navigation.
The dashboard lists retained games and their sizes in this browser, with removal
for one game or all games. Storage is shared by accounts using the same browser
profile; each device/browser has its own downloads. Removal only touches VNoctis
game asset caches, preserving IndexedDB saves, save uploads and authentication.
An optional button requests persistent storage where the browser supports it.
The browser can still remove ordinary retained data under storage pressure.

Caching requires HTTPS (or localhost) and service-worker/Cache API support.
Games remain playable through the original loader when caching cannot start.
Storage failures produce a dismissible notice rather than blocking normal loading.
The feature currently applies to local `/web-builds/` games launched through the
VNoctis player; separately hosted R2 gallery games need their own integration.

## Build identity and storage boundaries

Existing `Game.builtAt` timestamps identify completed builds, including web ZIP
imports and mark-playable actions. No new database migration is needed. The player
combines that timestamp with the source URL to create a build-specific virtual
URL and worker scope under `/web-builds/.vnm-cache/<game>/<build>/`. The worker
maps those URLs to existing read-only game files; it does not modify generated
games or overlap their original Ren'Py worker scopes.

Cache Storage names begin `vnm-game-assets-v1-` and `vnm-game-info-v1-`. The latter
holds titles, decoded byte counts and a small pause marker. Cache misses bypass
ordinary HTTP caching and check `/api/v1/games/<id>/cache-build` before and after
the fetch. That public endpoint returns only the version, public web-build URL
and build status; it exposes no user/save data. A replacement in progress or a
different build identity cannot supply new files to the old browser build.
ZIP scanning marks the game as building before replacing files and publishes its
new timestamp only on success. Old cached assets remain usable in an already
running older game. Unused older builds are removed automatically on subsequent
launches; a build still running in another tab is retained until it is unused.

Only successful complete bodies are retained. Cached complete media files can
serve byte ranges. A 206 response is treated as complete only when Content-Range
covers the entire file; other partial responses are passed through without being
misrepresented as full cached files. Interrupted writes do not create valid entries.
The existing Ren'Py offline catalog receipt and clear-download controls remain
compatible. Removing downloads pauses surviving workers and drains writes before
deletion, so a game open in another tab cannot immediately recreate the removed data.

See `tools/cache-test/README.md` for the real-game byte-transfer acceptance test
and isolated worker failure tests. Desktop Chrome has been tested with a real
Ren'Py game and a mobile-width dashboard; real Safari/mobile validation remains.
