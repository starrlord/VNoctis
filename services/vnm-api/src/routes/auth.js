import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

/**
 * Dummy hash used for timing-safe comparison when a user is not found.
 * Prevents timing-based user enumeration by ensuring bcrypt.compare()
 * always runs regardless of whether the username exists.
 */
const DUMMY_HASH = '$2b$12$K4v1Qx0YpSGz1tQ0ZzVxQeJfGqK8vLzHxMzHn6b4C5pP7q8Rr0Wmu';

/**
 * Authentication routes plugin.
 *
 * Provides login, logout, and session inspection endpoints.
 * Uses database-backed multi-user authentication with bcrypt.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} opts
 */
export default async function authRoutes(fastify, opts) {
  /**
   * POST /auth/login
   *
   * Authenticates a user against the database and returns a signed JWT.
   */
  fastify.post('/auth/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const { username, password } = request.body || {};

    if (!username || !password) {
      reply.code(401).send({
        code: 'UNAUTHORIZED',
        message: 'Invalid username or password',
      });
      return;
    }

    const user = await fastify.prisma.user.findUnique({
      where: { username: String(username) },
    });

    if (!user) {
      // Perform a dummy compare to prevent timing-based user enumeration
      await bcrypt.compare(String(password), DUMMY_HASH);

      const ip = request.ip || request.headers['x-forwarded-for'] || 'unknown';
      request.log.warn({ ip }, 'Failed login attempt');
      reply.code(401).send({
        code: 'UNAUTHORIZED',
        message: 'Invalid username or password',
      });
      return;
    }

    const passwordMatch = await bcrypt.compare(String(password), user.passwordHash);

    if (!passwordMatch) {
      const ip = request.ip || request.headers['x-forwarded-for'] || 'unknown';
      request.log.warn({ ip }, 'Failed login attempt');
      reply.code(401).send({
        code: 'UNAUTHORIZED',
        message: 'Invalid username or password',
      });
      return;
    }

    const ttlDays = parseInt(process.env.VNM_SESSION_TTL_DAYS, 10) || 30;
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      fastify.jwtSecret,
      { expiresIn: `${ttlDays}d` }
    );

    return { token };
  });

  /**
   * POST /auth/logout
   *
   * Placeholder for future server-side token invalidation.
   * The client is responsible for discarding the token.
   */
  fastify.post('/auth/logout', async (request, reply) => {
    reply.code(204).send();
  });

  /**
   * GET /auth/me
   *
   * Returns the authenticated user's identity from a valid JWT.
   */
  fastify.get('/auth/me', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.code(401).send({
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
      });
      return;
    }

    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, fastify.jwtSecret);
      return {
        userId: decoded.userId,
        username: decoded.username,
        role: decoded.role,
      };
    } catch (err) {
      reply.code(401).send({
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
      });
    }
  });
}
