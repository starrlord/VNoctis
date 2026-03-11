import { access } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createReadStream } from 'node:fs';

/** Map file extensions to MIME types for cover images. */
const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

/**
 * Cover image serving route plugin.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function coversRoutes(fastify) {
  const coversDir = process.env.COVERS_PATH || '/covers';

  /**
   * GET /covers/:gameId
   * Serves the cached cover image file for a game.
   */
  fastify.get('/covers/:gameId', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    // Look up the game to find its coverPath
    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
      select: { coverPath: true },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    if (!game.coverPath) {
      return reply.code(404).send({
        code: 'COVER_NOT_FOUND',
        message: 'No cover image available for this game.',
      });
    }

    // Resolve the cover file path
    const coverFile = game.coverPath.startsWith('/')
      ? game.coverPath
      : join(coversDir, game.coverPath);

    try {
      await access(coverFile);
    } catch {
      return reply.code(404).send({
        code: 'COVER_NOT_FOUND',
        message: 'Cover image file not found on disk.',
      });
    }

    const ext = extname(coverFile).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';

    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(createReadStream(coverFile));
  });
}
