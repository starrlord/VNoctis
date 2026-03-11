import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';

/**
 * Authentication routes plugin.
 *
 * Provides login, logout, and session inspection endpoints.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} opts
 */
export default async function authRoutes(fastify, opts) {
  /**
   * POST /auth/login
   *
   * Authenticates the admin user and returns a signed JWT.
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

    const expectedUser = process.env.VNM_ADMIN_USER || 'admin';
    const expectedPass = process.env.VNM_ADMIN_PASSWORD;

    // Constant-time comparison for both username and password
    const userBuf = Buffer.from(String(username));
    const expectedUserBuf = Buffer.from(expectedUser);
    const passBuf = Buffer.from(String(password));
    const expectedPassBuf = Buffer.from(expectedPass);

    const usernameMatch =
      userBuf.length === expectedUserBuf.length &&
      timingSafeEqual(userBuf, expectedUserBuf);

    const passwordMatch =
      passBuf.length === expectedPassBuf.length &&
      timingSafeEqual(passBuf, expectedPassBuf);

    if (!usernameMatch || !passwordMatch) {
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
      { username: expectedUser },
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
      return { username: decoded.username };
    } catch (err) {
      reply.code(401).send({
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
      });
    }
  });
}
