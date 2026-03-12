import { enrichGame, enrichGameById, enrichGameBySteamId } from '../services/enrichment.js';

/**
 * Metadata refresh route plugin.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function metadataRoutes(fastify) {
  // ── VNDB search ─────────────────────────────────────────

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

  // ── Steam search ────────────────────────────────────────

  /**
   * GET /metadata/steam/search?q=<text>
   *
   * Searches the locally-cached Steam app list for games matching a name.
   * Used by the MetadataEditModal autocomplete dropdown (Steam tab).
   *
   * Query params:
   *   q  - Search text (minimum 3 characters)
   *
   * Returns an array of Steam app objects:
   *   [{ appid, name, score }]
   */
  fastify.get('/metadata/steam/search', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const q = (request.query.q || '').trim();

    if (q.length < 3) {
      return reply.code(400).send({
        code: 'QUERY_TOO_SHORT',
        message: 'Search query must be at least 3 characters.',
      });
    }

    const steamClient = fastify.steamClient;

    if (!steamClient) {
      return reply.code(503).send({
        code: 'STEAM_CLIENT_UNAVAILABLE',
        message: 'Steam client is not configured.',
      });
    }

    try {
      const results = await steamClient.searchByName(q, 10);
      return results;
    } catch (err) {
      request.log.error({ err: err.message, q }, 'Steam search failed');
      return reply.code(500).send({
        code: 'STEAM_SEARCH_ERROR',
        message: err.message || 'Steam search failed.',
      });
    }
  });

  // ── Metadata refresh (VNDB + Steam) ─────────────────────

  /**
   * POST /metadata/:gameId/refresh
   *
   * Re-fetches metadata for a game from VNDB or Steam.
   *
   * Optional body:
   *   { vndbId: "v12345" }    - Force-link to a VNDB entry.
   *   { steamAppId: "12345" } - Force-link to a Steam app.
   *
   * Smart source resolution when body is empty (e.g. "Refresh Metadata" button):
   *   1. body.steamAppId → enrich from Steam
   *   2. body.vndbId     → enrich from VNDB
   *   3. game.steamAppId → re-fetch from Steam
   *   4. game.vndbId     → re-fetch from VNDB
   *   5. none            → search VNDB by extracted title (legacy fallback)
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
    const steamClient = fastify.steamClient;
    const coversPath = fastify.coversPath;
    const screenshotsPath = fastify.screenshotsPath;

    try {
      const body = request.body || {};
      let updated;

      // ── Priority 1: explicit steamAppId in body ────────
      if (body.steamAppId) {
        // Validate: must be numeric string
        if (!/^\d+$/.test(String(body.steamAppId))) {
          return reply.code(400).send({
            code: 'INVALID_STEAM_APP_ID',
            message: 'steamAppId must be a numeric value.',
          });
        }

        if (!steamClient) {
          return reply.code(503).send({
            code: 'STEAM_CLIENT_UNAVAILABLE',
            message: 'Steam client is not configured.',
          });
        }

        updated = await enrichGameBySteamId(
          body.steamAppId,
          game,
          fastify.prisma,
          steamClient,
          coversPath,
          screenshotsPath,
          request.log
        );
        return updated;
      }

      // ── Priority 2: explicit vndbId in body ────────────
      if (body.vndbId) {
        if (!vndbClient) {
          return reply.code(503).send({
            code: 'VNDB_CLIENT_UNAVAILABLE',
            message: 'VNDB client is not configured.',
          });
        }

        updated = await enrichGameById(
          body.vndbId,
          game,
          fastify.prisma,
          vndbClient,
          coversPath,
          screenshotsPath,
          request.log
        );
        return updated;
      }

      // ── Priority 3: no body — smart source resolution ──
      // Check stored steamAppId first, then vndbId
      if (game.steamAppId && steamClient) {
        updated = await enrichGameBySteamId(
          game.steamAppId,
          game,
          fastify.prisma,
          steamClient,
          coversPath,
          screenshotsPath,
          request.log
        );
        return updated;
      }

      if (game.vndbId && vndbClient) {
        updated = await enrichGameById(
          game.vndbId,
          game,
          fastify.prisma,
          vndbClient,
          coversPath,
          screenshotsPath,
          request.log
        );
        return updated;
      }

      // ── Priority 4: no IDs stored — search VNDB by title
      if (!vndbClient) {
        return reply.code(503).send({
          code: 'VNDB_CLIENT_UNAVAILABLE',
          message: 'VNDB client is not configured.',
        });
      }

      updated = await enrichGame(
        game,
        fastify.prisma,
        vndbClient,
        coversPath,
        screenshotsPath,
        request.log
      );
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
