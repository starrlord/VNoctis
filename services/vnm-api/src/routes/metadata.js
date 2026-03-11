import { enrichGame, enrichGameById } from '../services/enrichment.js';

/**
 * Metadata refresh route plugin.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function metadataRoutes(fastify) {
  /**
   * GET /metadata/vndb/search?q=<text>
   *
   * Searches VNDB for visual novels matching a title string.
   * Used by the MetadataEditModal autocomplete dropdown.
   *
   * Query params:
   *   q  - Search text (minimum 3 characters)
   *
   * Returns an array of slim VN objects:
   *   [{ id, title, alttitle, developer, released }]
   */
  fastify.get('/metadata/vndb/search', async (request, reply) => {
    const q = (request.query.q || '').trim();

    if (q.length < 3) {
      return reply.code(400).send({
        code: 'QUERY_TOO_SHORT',
        message: 'Search query must be at least 3 characters.',
      });
    }

    const vndbClient = fastify.vndbClient;

    if (!vndbClient) {
      return reply.code(503).send({
        code: 'VNDB_CLIENT_UNAVAILABLE',
        message: 'VNDB client is not configured.',
      });
    }

    try {
      const results = await vndbClient.searchByTitle(q);

      // Return a slim payload for the dropdown
      const slim = results.map((vn) => ({
        id: vn.id,
        title: vn.title || '',
        alttitle: vn.alttitle || '',
        developer: vn.developers?.[0]?.name || '',
        released: vn.released || '',
      }));

      return slim;
    } catch (err) {
      request.log.error({ err: err.message, q }, 'VNDB search failed');
      return reply.code(500).send({
        code: 'VNDB_SEARCH_ERROR',
        message: err.message || 'VNDB search failed.',
      });
    }
  });

  /**
   * POST /metadata/:gameId/refresh
   *
   * Re-fetches VNDB metadata for a game.
   *
   * Optional body: { vndbId: "v12345" }
   *   - If vndbId is provided, force-links the game to that VNDB entry.
   *   - If omitted, searches VNDB by the game's extracted title.
   *
   * Returns the updated game object.
   */
  fastify.post('/metadata/:gameId/refresh', async (request, reply) => {
    const { gameId } = request.params;

    if (!gameId || gameId.length !== 32) {
      return reply.code(400).send({
        code: 'INVALID_GAME_ID',
        message: 'gameId must be a 32-character hex string.',
      });
    }

    // Verify game exists
    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      return reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
    }

    const vndbClient = fastify.vndbClient;
    const coversPath = fastify.coversPath;
    const screenshotsPath = fastify.screenshotsPath;

    if (!vndbClient) {
      return reply.code(503).send({
        code: 'VNDB_CLIENT_UNAVAILABLE',
        message: 'VNDB client is not configured.',
      });
    }

    try {
      const body = request.body || {};
      let updated;

      // Determine the VNDB ID to use: explicit body override, or existing game vndbId
      const vndbId = body.vndbId || game.vndbId;

      if (vndbId) {
        // Refresh by VNDB ID (bypasses the 'manual' metadataSource guard,
        // so explicit user-initiated refreshes always work even after edits)
        updated = await enrichGameById(
          vndbId,
          game,
          fastify.prisma,
          vndbClient,
          coversPath,
          screenshotsPath,
          request.log
        );
      } else {
        // No VNDB ID — search by extracted title
        updated = await enrichGame(
          game,
          fastify.prisma,
          vndbClient,
          coversPath,
          screenshotsPath,
          request.log
        );
      }

      return updated;
    } catch (err) {
      request.log.error({ err: err.message, gameId }, 'Metadata refresh failed');
      return reply.code(500).send({
        code: 'ENRICHMENT_ERROR',
        message: err.message || 'Metadata refresh failed.',
      });
    }
  });
}
