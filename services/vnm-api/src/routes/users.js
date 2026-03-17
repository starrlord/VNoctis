import bcrypt from 'bcrypt';

/** Valid roles for user accounts */
const VALID_ROLES = ['admin', 'viewer'];

/** Username validation: 3-32 chars, alphanumeric + underscores */
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,32}$/;

/** UUID v4 format validation */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimum password length */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate a userId parameter and send a 400 response if invalid.
 * @returns {boolean} true if invalid (response already sent), false if valid
 */
function isInvalidUserId(userId, reply) {
  if (!userId || !UUID_REGEX.test(userId)) {
    reply.code(400).send({
      code: 'INVALID_USER_ID',
      message: 'userId must be a valid UUID.',
    });
    return true;
  }
  return false;
}

/**
 * User management route plugin (admin-only).
 *
 * Provides CRUD endpoints for managing user accounts.
 * All endpoints are admin-gated via the middleware in index.js.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} opts
 */
export default async function usersRoutes(fastify, opts) {
  /**
   * GET /users
   *
   * Lists all users with their favorite counts.
   */
  fastify.get('/users', async (request, reply) => {
    const users = await fastify.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        role: true,
        createdAt: true,
        _count: { select: { favorites: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return users.map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      favoriteCount: u._count.favorites,
    }));
  });

  /**
   * POST /users
   *
   * Creates a new user account with validation.
   */
  fastify.post('/users', async (request, reply) => {
    const { username, password, role = 'viewer' } = request.body || {};

    // Validate username
    if (!username || !USERNAME_REGEX.test(username)) {
      reply.code(400).send({
        code: 'INVALID_USERNAME',
        message: 'Username must be 3-32 characters, alphanumeric and underscores only.',
      });
      return;
    }

    // Validate password
    if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
      reply.code(400).send({
        code: 'INVALID_PASSWORD',
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
      return;
    }

    // Validate role
    if (!VALID_ROLES.includes(role)) {
      reply.code(400).send({
        code: 'INVALID_ROLE',
        message: `Role must be one of: ${VALID_ROLES.join(', ')}`,
      });
      return;
    }

    // Check username uniqueness
    const existing = await fastify.prisma.user.findUnique({
      where: { username },
    });

    if (existing) {
      reply.code(409).send({
        code: 'USERNAME_TAKEN',
        message: `Username "${username}" is already taken.`,
      });
      return;
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    const user = await fastify.prisma.user.create({
      data: { username, passwordHash, role },
      select: { id: true, username: true, role: true, createdAt: true },
    });

    reply.code(201);
    return user;
  });

  /**
   * PATCH /users/:userId
   *
   * Updates a user's role. Cannot demote the last admin.
   */
  fastify.patch('/users/:userId', async (request, reply) => {
    const { userId } = request.params;
    if (isInvalidUserId(userId, reply)) return;
    const { role } = request.body || {};

    // Validate role
    if (!role || !VALID_ROLES.includes(role)) {
      reply.code(400).send({
        code: 'INVALID_ROLE',
        message: `Role must be one of: ${VALID_ROLES.join(', ')}`,
      });
      return;
    }

    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      reply.code(404).send({
        code: 'USER_NOT_FOUND',
        message: `User with id "${userId}" not found.`,
      });
      return;
    }

    // Prevent demoting the last admin
    if (user.role === 'admin' && role !== 'admin') {
      const adminCount = await fastify.prisma.user.count({
        where: { role: 'admin' },
      });

      if (adminCount <= 1) {
        reply.code(400).send({
          code: 'LAST_ADMIN',
          message: 'Cannot demote the last admin user.',
        });
        return;
      }
    }

    const updated = await fastify.prisma.user.update({
      where: { id: userId },
      data: { role },
      select: { id: true, username: true, role: true },
    });

    return updated;
  });

  /**
   * DELETE /users/:userId
   *
   * Deletes a user account. Cannot delete yourself or the last admin.
   */
  fastify.delete('/users/:userId', async (request, reply) => {
    const { userId } = request.params;
    if (isInvalidUserId(userId, reply)) return;

    // Cannot delete yourself
    if (userId === request.user.userId) {
      reply.code(400).send({
        code: 'CANNOT_DELETE_SELF',
        message: 'You cannot delete your own account.',
      });
      return;
    }

    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      reply.code(404).send({
        code: 'USER_NOT_FOUND',
        message: `User with id "${userId}" not found.`,
      });
      return;
    }

    // Cannot delete the last admin
    if (user.role === 'admin') {
      const adminCount = await fastify.prisma.user.count({
        where: { role: 'admin' },
      });

      if (adminCount <= 1) {
        reply.code(400).send({
          code: 'LAST_ADMIN',
          message: 'Cannot delete the last admin user.',
        });
        return;
      }
    }

    await fastify.prisma.user.delete({
      where: { id: userId },
    });

    reply.code(204).send();
  });

  /**
   * POST /users/:userId/reset-password
   *
   * Resets a user's password (admin action).
   */
  fastify.post('/users/:userId/reset-password', async (request, reply) => {
    const { userId } = request.params;
    if (isInvalidUserId(userId, reply)) return;
    const { password } = request.body || {};

    // Validate password
    if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
      reply.code(400).send({
        code: 'INVALID_PASSWORD',
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
      return;
    }

    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      reply.code(404).send({
        code: 'USER_NOT_FOUND',
        message: `User with id "${userId}" not found.`,
      });
      return;
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    await fastify.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    return { success: true };
  });
}
