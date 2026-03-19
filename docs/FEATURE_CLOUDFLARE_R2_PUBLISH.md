# Feature: Cloudflare R2 Publishing

Publish built web games to Cloudflare R2 object storage with a static public gallery.

---

## Overview

This feature enables admins to:
1. Configure Cloudflare R2 credentials in an admin settings modal
2. Publish individual built games to R2 with a single click
3. Auto-generate a static gallery page listing all published games
4. View publish status on game cards in the admin gallery

The published gallery is a standalone static site hosted on R2 (via Cloudflare's public bucket or R2 custom domain), playable without the VNoctis Manager backend.

---

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────────┐
│   vnm-ui    │────▶│   vnm-api    │────▶│  Cloudflare R2       │
│  (admin)    │     │  (publish)   │     │  (S3-compatible)     │
└─────────────┘     └──────────────┘     └──────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │ Static files │
                    │ - /games/{id}/index.html, *.wasm, etc.
                    │ - /covers/{id}.webp
                    │ - /index.html (gallery)
                    │ - /gallery.json (metadata)
                    └──────────────┘
```

### R2 Bucket Structure

```
your-bucket/
├── index.html              # Static gallery SPA
├── gallery.json            # Published games metadata
├── assets/                 # Gallery CSS/JS
│   ├── gallery.css
│   └── gallery.js
├── covers/                 # Cover images
│   └── {gameId}.webp
└── games/                  # Web builds
    └── {gameId}/
        ├── index.html
        ├── game.data
        ├── game.js
        ├── game.wasm
        └── ...
```

---

## Database Strategy

### Dual-Database Approach

R2-specific schema changes are isolated in a separate database file (`vnm-r2.db`) to avoid polluting the standard deployment with R2-only tables. The active database is selected at startup via the `VNM_R2_MODE` environment variable.

| Mode | Database File | Prisma Schema |
|------|--------------|---------------|
| `VNM_R2_MODE=false` (default) | `/data/vnm.db` | Base schema only |
| `VNM_R2_MODE=true` | `/data/vnm-r2.db` | Base schema + R2 additions |

**First-run initialization (R2 mode):** On startup, if `VNM_R2_MODE=true` and `vnm-r2.db` does not exist, the API copies the current `vnm.db` to `vnm-r2.db` before running migrations. This preserves the full existing library in the R2 database. All R2-specific migrations then run against the copy only.

```
Startup sequence (R2 mode, first run):
  /data/vnm.db  ──copy──▶  /data/vnm-r2.db  ──migrate──▶  R2 schema applied
```

If `vnm-r2.db` already exists, the copy step is skipped — only pending migrations are applied.

### Startup Logic (services/vnm-api/src/index.js)

```js
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_PATH ?? '/data';
const R2_MODE  = process.env.VNM_R2_MODE === 'true';

const BASE_DB = path.join(DATA_DIR, 'vnm.db');
const R2_DB   = path.join(DATA_DIR, 'vnm-r2.db');

if (R2_MODE && !fs.existsSync(R2_DB)) {
  logger.info('First R2 startup — copying vnm.db → vnm-r2.db');
  fs.copyFileSync(BASE_DB, R2_DB);
}

// DATABASE_URL must be set before Prisma client is instantiated
process.env.DATABASE_URL = R2_MODE
  ? `file:${R2_DB}`
  : `file:${BASE_DB}`;
```

### New `Setting` model (key-value store)

Added only to the R2 schema (migration `20260320000000_r2_publish`):

```prisma
model Setting {
  key       String   @id
  value     String                  // Encrypted for secrets
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

### New fields on `Game` model

```prisma
model Game {
  // ... existing fields ...

  publishStatus    String    @default("not_published")  // not_published|publishing|published|failed
  publishedAt      DateTime?                            // Last successful publish time
  publishedVersion String?                              // Hash of published web-build for cache invalidation
}
```

### New `PublishJob` model

```prisma
model PublishJob {
  id            String    @id @default(uuid())
  gameId        String
  status        String    @default("queued")    // queued|uploading|done|failed
  progress      Int       @default(0)           // 0-100 percentage
  filesTotal    Int       @default(0)
  filesUploaded Int       @default(0)
  error         String?
  startedAt     DateTime?
  completedAt   DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
}
```

### Migration File

The R2-specific models and fields land in a single migration applied only to `vnm-r2.db`:

```
services/vnm-api/prisma/migrations/
└── 20260320000000_r2_publish/
    └── migration.sql    # Adds Setting, PublishJob, Game publish fields
```

---

## Configuration Settings

### Environment Variable (Docker / .env)

| Variable | Default | Description |
|----------|---------|-------------|
| `VNM_R2_MODE` | `false` | Set to `true` to activate R2 mode. Switches the active database to `vnm-r2.db` and enables all R2 endpoints. |

When `VNM_R2_MODE=true`:
- `vnm-r2.db` is used (created from a copy of `vnm.db` on first run if absent)
- R2 API endpoints become available
- R2 settings UI is shown in the admin panel

When `VNM_R2_MODE=false` (default):
- `vnm.db` is used, R2 tables and endpoints do not exist

### Runtime Settings (stored in `Setting` table, R2 DB only)

Stored in the `Setting` table with encrypted values for secrets.

| Key | Description | Example |
|-----|-------------|---------|
| `r2_account_id` | Cloudflare account ID | `abc123def456` |
| `r2_access_key_id` | R2 API access key ID | `AKIAIOSFODNN7EXAMPLE` |
| `r2_secret_access_key` | R2 API secret (encrypted) | `wJalrXUtnFEMI/K7MDENG/...` |
| `r2_bucket_name` | Target bucket name | `vnoctis-public` |
| `r2_public_url` | Public URL for the bucket | `https://games.example.com` |
| `r2_custom_domain` | Optional custom domain | `games.example.com` |

---

## API Endpoints

### Settings (Admin only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/settings/r2` | Get R2 configuration (secrets masked) |
| `PUT` | `/api/v1/settings/r2` | Update R2 configuration |
| `POST` | `/api/v1/settings/r2/test` | Test R2 connection |

### Publishing (Admin only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/publish/:gameId` | Queue a game for publishing |
| `GET` | `/api/v1/publish/:jobId` | Get publish job status |
| `GET` | `/api/v1/publish/:jobId/progress` | SSE stream of upload progress |
| `DELETE` | `/api/v1/publish/:gameId` | Unpublish a game (remove from R2) |
| `POST` | `/api/v1/publish/gallery` | Regenerate static gallery |

### Library Changes

| Method | Endpoint | Changes |
|--------|----------|---------|
| `GET` | `/api/v1/library` | Add `publishStatus`, `publishedAt` to response |
| `GET` | `/api/v1/library/:gameId` | Add `publishStatus`, `publishedAt` to response |

---

## UI Components

### 1. R2 Settings Modal (`R2Settings.jsx`)

Admin-only modal (opened from the navbar R2 button) for configuring Cloudflare R2 credentials.

```jsx
// pages/R2Settings.jsx
- Feature toggle (enable/disable R2 publishing)
- Account ID input
- Access Key ID input
- Secret Access Key input (password field, show/hide toggle)
- Bucket Name input
- Public URL input (with validation)
- Custom Domain input (optional)
- "Test Connection" button → shows success/error toast
- "Save" button
```

**Validation:**
- All required fields must be filled when enabled
- Public URL must be a valid HTTPS URL
- Test connection before allowing save (optional but recommended)

### 2. GalleryCard Updates

Add publish status badge and publish button to `GalleryCard.jsx`:

```jsx
// components/gallery/GalleryCard.jsx additions

// Publish status badge (top-left, below favorite heart)
{game.buildStatus === 'built' && (
  <div className={`absolute top-12 left-2 z-10 px-2 py-0.5 rounded text-xs font-semibold ${
    game.publishStatus === 'published'
      ? 'bg-green-500/80 text-white'
      : game.publishStatus === 'publishing'
      ? 'bg-yellow-500/80 text-black animate-pulse'
      : 'bg-gray-500/60 text-white/80'
  }`}>
    {game.publishStatus === 'published' ? '✓ Published' :
     game.publishStatus === 'publishing' ? '↑ Publishing...' :
     '○ Not Published'}
  </div>
)}

// Publish button in hover overlay (next to play button)
{game.buildStatus === 'built' && onPublish && (
  <button
    onClick={(e) => { e.stopPropagation(); onPublish(game); }}
    disabled={game.publishStatus === 'publishing'}
    className="w-8 h-8 flex items-center justify-center rounded-full bg-blue-500 text-white hover:bg-blue-400 disabled:opacity-50 transition-colors shadow-lg"
    title={game.publishStatus === 'published' ? 'Republish to R2' : 'Publish to R2'}
  >
    <CloudUploadIcon className="w-4 h-4" />
  </button>
)}
```

### 3. GameCard Updates (Library View)

Similar publish status indicator for the library view cards:

```jsx
// components/GameCard.jsx additions

// Small publish indicator next to build status
{game.buildStatus === 'built' && (
  <span className={`ml-2 text-xs ${
    game.publishStatus === 'published' ? 'text-green-400' : 'text-gray-500'
  }`}>
    {game.publishStatus === 'published' ? '● R2' : '○ Local'}
  </span>
)}
```

### 4. Publish Progress Modal

Shows upload progress when publishing:

```jsx
// components/PublishProgressModal.jsx
- Game title and cover thumbnail
- Progress bar (0-100%)
- Files uploaded: X / Y
- Current file being uploaded
- Cancel button (if in progress)
- Close button (when done/failed)
- Error message display (if failed)
```

### 5. Admin Navbar Addition

Add R2 Settings button to admin navigation (opens modal):

```jsx
// In Navbar.jsx, admin menu section
<button onClick={onR2Settings}>
  <CloudIcon /> R2
</button>
```

---

## Publishing Flow

### Publish Game

1. **UI:** Admin clicks "Publish" on a built game card
2. **API:** `POST /api/v1/publish/:gameId`
   - Validate game exists and is built
   - Validate R2 is configured and enabled
   - Create `PublishJob` with status `queued`
   - Update `game.publishStatus = 'publishing'`
   - Return `202 { jobId }`
3. **Background Job:**
   - Enumerate files in `/web-builds/{gameId}/`
   - Upload each file to R2 `games/{gameId}/` with correct content-type
   - Upload cover image to R2 `covers/{gameId}.webp`
   - Update progress via SSE or polling
   - On success: `game.publishStatus = 'published'`, `game.publishedAt = now()`
   - On failure: `game.publishStatus = 'failed'`, store error
4. **Gallery Regeneration:**
   - After successful publish, regenerate `gallery.json` and `index.html`
   - Upload updated gallery files to R2

### Unpublish Game

1. **UI:** Admin clicks "Unpublish" in game detail modal
2. **API:** `DELETE /api/v1/publish/:gameId`
   - Delete all files in R2 `games/{gameId}/`
   - Delete cover from R2 `covers/{gameId}.webp`
   - Update `game.publishStatus = 'not_published'`
   - Regenerate gallery

### Gallery Regeneration

Triggered automatically after publish/unpublish, or manually via API.

1. Query all games with `publishStatus = 'published'`
2. Generate `gallery.json`:
   ```json
   {
     "generatedAt": "2024-03-19T10:00:00Z",
     "games": [
       {
         "id": "abc123...",
         "title": "Game Title",
         "developer": "Studio Name",
         "synopsis": "Short description...",
         "rating": 8.5,
         "releaseDate": "2024-01-15",
         "coverUrl": "/covers/abc123.webp",
         "playUrl": "/games/abc123/index.html",
         "tags": ["romance", "drama"]
       }
     ]
   }
   ```
3. Generate static `index.html` gallery page (embedded or fetches gallery.json)
4. Upload to R2 root

---

## Static Gallery Page

The static gallery is a self-contained HTML/CSS/JS page that:
- Displays published games in a Netflix-style grid
- Works without any backend (pure static files)
- Supports dark/light theme (respects system preference)
- Mobile responsive
- Links directly to playable game URLs

### Template Location

```
services/vnm-api/templates/
├── gallery.html       # Gallery page template
├── gallery.css        # Styles
└── gallery.js         # Vanilla JS for interactivity
```

### Features

- Grid of game cards with covers
- Click to play (opens game in new tab or same page)
- Search/filter by title (client-side)
- Sort by title, rating, release date
- Responsive: 1 col mobile, 2-3 cols tablet, 4-5 cols desktop

---

## Implementation Checklist

### Backend (vnm-api)

- [x] Add `VNM_R2_MODE` env var handling to `index.js` startup (copy DB if needed, set `DATABASE_URL`)
- [x] Add `Setting` and `PublishJob` models to Prisma schema
- [x] Add publish fields to `Game` model (`publishStatus`, `publishedAt`, `publishedVersion`)
- [x] Apply R2 schema via raw SQL in R2 mode (not via migration — keeps `vnm.db` clean)
- [x] Create encryption utility for secrets (`services/encryption.js`)
- [x] Create R2 client service (`services/r2Client.js`)
- [x] Create settings routes (`routes/settings.js`)
- [x] Create publish routes (`routes/publish.js`)
- [x] Create gallery generator service (`services/galleryGenerator.js`)
- [x] Add `r2Mode` to health endpoint response
- [x] Create static gallery template (`templates/gallery.html`)
- [x] Add `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `mime-types` to `package.json`

### Frontend (vnm-ui)

- [x] Create `R2Settings.jsx` page
- [x] Create `useSettings.js` hook
- [x] Create `usePublish.js` hook
- [x] Update `GalleryCard.jsx` with publish status badge and publish button
- [x] Update `GalleryRow.jsx` to thread `onPublish` / `r2Mode` props
- [x] Update `GameCard.jsx` with publish indicator
- [x] Create `PublishProgressModal.jsx` with SSE progress
- [x] Add R2 Settings button to admin navbar (opens modal)
- [x] R2 Settings renders as a modal (no dedicated route)
- [x] Add `put` method to `useApi.js`
- [x] Wire publish actions in `Library.jsx` and `Gallery.jsx`
- [x] Add publish button to `GameDetailModal.jsx`

### Configuration

- [x] Add R2 environment variable to `.env.example`:
  ```
  # Cloudflare R2 Publishing (optional)
  # Set to true to use vnm-r2.db (copied from vnm.db on first run) with R2 publish support
  VNM_R2_MODE=false
  ```
  Note: R2 credentials (account ID, keys, bucket) are stored in the database via the admin settings UI, not in `.env`.

---

## Security Considerations

1. **Secret Storage:** R2 secret access key is encrypted at rest in the database using AES-256-GCM with a key derived from `VNM_JWT_SECRET`
2. **Admin Only:** All R2 settings and publish endpoints require admin role
3. **Validation:** Bucket names and URLs are validated to prevent injection
4. **Rate Limiting:** Publish endpoints are rate-limited to prevent abuse
5. **CORS:** Static gallery files include appropriate CORS headers for SharedArrayBuffer (required for WebAssembly games)

---

## Dependencies

### Backend

```json
// package.json additions
"@aws-sdk/client-s3": "^3.x",
"@aws-sdk/lib-storage": "^3.x"  // For multipart uploads
```

R2 is S3-compatible, so we use the AWS SDK with a custom endpoint.

### R2 Client Configuration

```js
// services/r2Client.js
import { S3Client } from '@aws-sdk/client-s3';

export function createR2Client(config) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}
```

---

## Testing

### Manual Testing Checklist

1. **Settings:**
   - [ ] Can save R2 configuration
   - [ ] Test connection works with valid credentials
   - [ ] Test connection fails gracefully with invalid credentials
   - [ ] Secret is masked in GET response

2. **Publishing:**
   - [ ] Can publish a built game
   - [ ] Progress updates during upload
   - [ ] Published game is playable at R2 URL
   - [ ] Gallery is updated after publish
   - [ ] Can republish (updates existing files)
   - [ ] Can unpublish (removes from R2 and gallery)

3. **Static Gallery:**
   - [ ] Gallery loads without backend
   - [ ] All published games are listed
   - [ ] Games are playable from gallery
   - [ ] Search/filter works
   - [ ] Mobile responsive

---

## Future Enhancements

1. **Batch Publishing:** Publish multiple games at once
2. **CDN Purge:** Invalidate Cloudflare cache after publish
3. **Custom Gallery Themes:** Allow customizing gallery appearance
4. **Publish Scheduling:** Schedule publishes for specific times
5. **Access Control:** Password-protect the static gallery
6. **Analytics:** Track game plays via Cloudflare Analytics
