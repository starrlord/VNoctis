/**
 * Enhanced health-check route plugin.
 *
 * Returns detailed service health including database connectivity,
 * builder reachability, and library statistics.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function healthRoutes(fastify) {
  fastify.get('/health', async (request, reply) => {
    const startTime = Date.now();

    // ── Database check ──────────────────────────────────
    let dbStatus = 'connected';
    let totalGames = 0;
    let builtGames = 0;
    let unmatchedGames = 0;

    try {
      const [total, built, unmatched] = await Promise.all([
        fastify.prisma.game.count(),
        fastify.prisma.game.count({ where: { webBuildPath: { not: null } } }),
        fastify.prisma.game.count({ where: { vndbId: null } }),
      ]);
      totalGames = total;
      builtGames = built;
      unmatchedGames = unmatched;
    } catch (err) {
      dbStatus = 'disconnected';
      request.log.error(
        { err: err.message, event: 'health_db_check_failed' },
        'Database health check failed'
      );
    }

    // ── Builder check ───────────────────────────────────
    let builderStatus = 'unreachable';
    let builderSdkVersion = null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const builderUrl = fastify.builderUrl || 'http://vnm-builder:3002';
      const res = await fetch(`${builderUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        builderStatus = 'reachable';
        builderSdkVersion = data.sdkVersion || null;
      }
    } catch {
      // Builder unreachable — degraded but not a failure
    }

    // ── Response ────────────────────────────────────────
    const statusCode = dbStatus === 'disconnected' ? 503 : 200;
    const overallStatus = dbStatus === 'disconnected' ? 'degraded' : 'ok';

    reply.code(statusCode).send({
      status: overallStatus,
      service: 'vnm-api',
      version: '1.0.0',
      uptime: Math.round(process.uptime() * 100) / 100,
      timestamp: new Date().toISOString(),
      r2Mode: process.env.VNM_R2_MODE === 'true',
      database: dbStatus,
      builder: {
        status: builderStatus,
        sdkVersion: builderSdkVersion,
      },
      library: {
        totalGames,
        builtGames,
        unmatchedGames,
      },
    });
  });
}
