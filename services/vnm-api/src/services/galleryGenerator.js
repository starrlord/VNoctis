import { readFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '../../templates/gallery.html');

/**
 * Queries all published games and builds the gallery.json payload.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} publicUrl  Base public URL for the R2 bucket (no trailing slash)
 * @returns {Promise<object>}
 */
export async function buildGalleryJson(prisma, publicUrl) {
  const games = await prisma.game.findMany({
    where: { publishStatus: 'published' },
    orderBy: { vndbRating: 'desc' },
  });

  const base = publicUrl.replace(/\/$/, '');

  return {
    generatedAt: new Date().toISOString(),
    games: games.map((g) => {
      let tags = [];
      try { tags = JSON.parse(g.tags); } catch { /* ignore */ }
      const tagNames = tags
        .filter((t) => !t.spoiler)
        .map((t) => t.name)
        .slice(0, 8);

      return {
        id: g.id,
        title: g.vndbTitle || g.extractedTitle || g.directoryName,
        originalTitle: g.vndbTitleOriginal || null,
        developer: g.developer || null,
        synopsis: g.synopsis ? g.synopsis.slice(0, 500) : null,
        rating: g.vndbRating || null,
        releaseDate: g.releaseDate ? g.releaseDate.toISOString().split('T')[0] : null,
        lengthMinutes: g.lengthMinutes || null,
        coverUrl: g.coverPath
          ? `${base}/covers/${g.id}${extname(g.coverPath).toLowerCase() || '.webp'}`
          : null,
        playUrl: `${base}/games/${g.id}/index.html`,
        tags: tagNames,
        publishedAt: g.publishedAt ? g.publishedAt.toISOString() : null,
      };
    }),
  };
}

/**
 * Generates the static gallery HTML by injecting gallery data into the template.
 *
 * @param {object} galleryJson  Output of buildGalleryJson()
 * @returns {string}  Complete HTML string
 */
export function buildGalleryHTML(galleryJson) {
  const template = readFileSync(TEMPLATE_PATH, 'utf-8');
  const escaped = JSON.stringify(galleryJson)
    .replace(/<\/script>/gi, '<\\/script>');
  return template.replace('__GALLERY_DATA__', escaped);
}
