/**
 * Per-user favorites route plugin.
 *
 * Provides endpoints to list, add, and remove games from a user's favorites.
 * All endpoints require authentication (request.user.userId from JWT).
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} opts
 */
export default async function favoritesRoutes(fastify, opts) {
  /**
   * GET /favorites
   *
   * Returns the current user's favorited game IDs.
   */
  fastify.get('/favorites', async (request, reply) => {
    const { userId } = request.user;

    const favorites = await fastify.prisma.userFavorite.findMany({
      where: { userId },
      select: { gameId: true },
    });

    return { gameIds: favorites.map(f => f.gameId) };
  });

  /**
   * POST /favorites/:gameId
   *
   * Add a game to the current user's favorites (idempotent via upsert).
   * Returns 404 if the game does not exist.
   */
  fastify.post('/favorites/:gameId', async (request, reply) => {
    const { userId } = request.user;
    const { gameId } = request.params;

    // Verify the game exists
    const game = await fastify.prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });

    if (!game) {
      reply.code(404).send({
        code: 'GAME_NOT_FOUND',
        message: `Game with id "${gameId}" not found.`,
      });
      return;
    }

    await fastify.prisma.userFavorite.upsert({
      where: {
        userId_gameId: { userId, gameId },
      },
      create: { userId, gameId },
      update: {},
    });

    return { favorited: true };
  });

  /**
   * DELETE /favorites/:gameId
   *
   * Remove a game from the current user's favorites.
   */
  fastify.delete('/favorites/:gameId', async (request, reply) => {
    const { userId } = request.user;
    const { gameId } = request.params;

    await fastify.prisma.userFavorite.deleteMany({
      where: { userId, gameId },
    });

    return { favorited: false };
  });
}
