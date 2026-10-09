# Game loading and caching test bed

This runs the current branch's real UI, API and Nginx, with one existing Ren'Py
web build. It does not rebuild or modify the copied game. The API database,
logs and reports live under ignored `test-data/cache-test/`. Dedicated browser
profiles live under the system temporary directory's `vnm-cache-test/` folder
(override with `CACHE_TEST_PROFILE_ROOT`). Production data and your normal browser profile are
not used. No builder runs; the seed registers a minimal placeholder source
project so the API scanner retains the existing web build.
The seed also supplies three publish columns missing from upstream's normal-mode
migrations but present in its Prisma model, only in this disposable database.

Put the complete web build in `test-data/Abnormal-0990.1-pc/` at the repository
root, including its `game/` files. Set `CACHE_GAME_DIRECTORY` to use a different
folder directly under `test-data/`.

From the repository root, start the test instance:

```sh
sudo docker compose -f tools/cache-test/compose.yml up -d --build
```

On Windows, use Docker Desktop's `docker` executable directly (no `sudo`).
Open http://localhost:3180 and sign in with `cache-test` /
`local-cache-test-only`. The instance binds only to the local computer.

Install the isolated measurement tool and run it:

```sh
npm --prefix tools/cache-test ci
npm --prefix tools/cache-test test
npm --prefix tools/cache-test run test:worker
sudo docker compose -f tools/cache-test/compose.yml exec -T vnm-api node /cache-test/scanner.test.cjs
```

Windows uses installed Chrome by default. Elsewhere set `CHROME_PATH` to a
Chrome executable, or install Playwright's Chromium from this tool's directory
with `npx playwright install chromium`. Set `CACHE_TEST_VISIBLE=1` for a visible
test browser. These tests always create their own browser profile.

Each run creates a fresh profile and measures cold launch, reopening via the
React player, opening a new tab, and fully closing/restarting Chrome with the
same profile. Reports include browser cache indicators, service-worker cache
entries, storage estimates, screenshots, readiness times, and the actual game
response bytes sent by Nginx. A service-worker response alone does not prove
that the network was avoided: check `serverBodyBytes` and `serverLargeFiles`.
The readiness marker is the game's own removal of its presplash plus the
Emscripten runtime starting; screenshots allow verification of the menu.

Do not enable DevTools' **Disable cache**, intercept requests, clear browser
storage between phases, or use a new origin/port between phases. Those would
invalidate the measurements. Full offline-download mode is not activated.

The browser harness now asserts zero game-file response bytes on every warm
launch, reuses a progressive image byte-for-byte, checks a regular viewer's
mobile dashboard, removes downloads while preserving IndexedDB save/outbox
data, and simulates a replacement build through the isolated database. It
checks that the replacement downloads once and becomes reusable, then checks
removal of all downloads. The replacement test changes the build identity;
it does not run the Ren'Py builder or alter the read-only copied game.
Worker tests cover failed and interrupted responses, quota failures, media
ranges, in-progress/changed builds, paused surviving tabs, unused older-build
cleanup and the existing Ren'Py offline controls. Actual mobile-browser checks
supplement desktop automation; a narrow desktop viewport does not test Safari.

Ensure the browser-profile drive has several GB free. Chrome can report a large
storage quota while blob/cache writes still fail because the drive is nearly
full. Earlier runs hit this on the game drive; using the system drive allowed
the large archive writes to succeed. Reports contain the profile location.

## Initial baseline

Measured on `loader-optimize`, October 7, 2026, with the copied Abnormal 0.990.1
build and installed Chrome. Nginx's response-body counts were:

| Launch | Game bytes sent by server | Startup to menu marker |
| --- | ---: | ---: |
| Clean profile | 189,622,857 | 12.59 s |
| Same tab reopened | 165,862,337 | 11.57 s |
| New tab | 165,856,974 | 11.90 s |
| Full browser restart | 165,856,974 | 11.68 s |

Every reopen transferred `game.zip` (143,917,159 bytes) and `renpy.wasm`
(21,939,815 bytes) again with HTTP 200. The game's service-worker cache existed
but had zero entries. All four launches reached the main menu, with no page
errors. This confirms repeated downloads, independent of engine startup time.
Raw measurements and screenshots are in the ignored run directory
`test-data/cache-test/results/2026-10-08T05-09-07-160Z/` (UTC timestamp).

## Result with automatic caching

The real game downloads about 190 MB on a clean launch. Same-tab reopening,
new-tab reopening and full browser restart each serve **zero game-file bytes**
from Nginx. Removing downloads or changing the build identity causes a fresh
download; subsequent launches reuse it. Ren'Py still initializes on every
launch, so this change reduces network traffic rather than preserving a running
game session. Initial successful full-suite report:
`test-data/cache-test/results/2026-10-08T05-56-14-683Z/report.json`.

Stop the local instance (keeps its disposable database and reports):

```sh
sudo docker compose -f tools/cache-test/compose.yml down
```
