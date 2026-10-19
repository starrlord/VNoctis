import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const NAME = '.vnm-offline-manifest.json';
const inside = (base, target) => target.startsWith(base + path.sep);
export default async function offlineRoutes(fastify) {
  const base = path.resolve(process.env.WEB_BUILDS_PATH || '/web-builds');
  const inventories = new Map();
  const game = (id) =>
    fastify.prisma.game.findUnique({
      where: { id },
      select: {
        id: true,
        directoryName: true,
        webBuildPath: true,
        buildStatus: true,
        builtAt: true,
      },
    });
  const protectedRoute = {
    preHandler: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!request.user?.userId)
        return reply.code(401).send({ message: 'Authentication required' });
    },
  };
  async function inventory(id) {
    const record = await game(id);
    if (
      !record?.webBuildPath ||
      !['built', 'stale'].includes(record.buildStatus) ||
      !record.builtAt
    )
      throw Object.assign(new Error('A completed local build is required'), {
        statusCode: 409,
      });
    const root = path.resolve(base, record.directoryName);
    if (!inside(base, root))
      throw Object.assign(new Error('Invalid build directory'), {
        statusCode: 400,
      });
    const resolvedBase = await realpath(base),
      resolvedRoot = await realpath(root);
    if (!inside(resolvedBase, resolvedRoot))
      throw Object.assign(new Error('Invalid build directory'), {
        statusCode: 400,
      });
    let manifest, identity;
    try {
      const filename = path.join(root, NAME);
      const info = await stat(filename);
      if (!info.isFile() || info.size > 32 * 1024 * 1024)
        throw new Error('Manifest too large');
      identity = `${info.mtimeMs}:${info.size}:${record.builtAt.toISOString()}`;
      const previous = inventories.get(root);
      if (previous?.identity === identity)
        return {
          root: resolvedRoot,
          record,
          manifest: previous.manifest,
          files: previous.files,
        };
      manifest = JSON.parse(await readFile(filename, 'utf8'));
    } catch {
      throw Object.assign(
        new Error('Rebuild this game to enable full offline preparation'),
        { statusCode: 409 }
      );
    }
    if (
      manifest.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(manifest.id) ||
      !Array.isArray(manifest.files) ||
      manifest.files.length > 200000
    )
      throw Object.assign(
        new Error('Invalid offline manifest; rebuild the game'),
        { statusCode: 409 }
      );
    const names = new Set();
    for (const item of manifest.files) {
      if (
        typeof item.path !== 'string' ||
        !item.path ||
        item.path.length > 2048 ||
        /[\\\x00-\x1f]/.test(item.path) ||
        item.path
          .split('/')
          .some(
            (part) =>
              !part || part === '.' || part === '..' || part.startsWith('.')
          ) ||
        names.has(item.path) ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        !/^[a-f0-9]{64}$/.test(item.hash)
      )
        throw Object.assign(new Error('Invalid offline asset inventory'), {
          statusCode: 409,
        });
      names.add(item.path);
    }
    if (!names.has('index.html'))
      throw Object.assign(new Error('Offline launch file is missing'), {
        statusCode: 409,
      });
    const files = new Map(manifest.files.map((file) => [file.path, file]));
    if (inventories.size >= 2)
      inventories.delete(inventories.keys().next().value);
    inventories.set(root, { identity, manifest, files });
    return { root: resolvedRoot, record, manifest, files };
  }
  // Build identity is public like the static assets; it contains no user data.
  fastify.get('/games/:gameId/cache-build', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const item = await game(request.params.gameId);
    if (!item?.webBuildPath)
      return reply.code(404).send({ message: 'Local build not found' });
    return {
      path: item.webBuildPath,
      version: item.builtAt?.toISOString(),
      status: item.buildStatus,
    };
  });
  fastify.get(
    '/games/:gameId/offline-manifest',
    protectedRoute,
    async (request) => {
      const { record, manifest } = await inventory(request.params.gameId);
      return {
        ...manifest,
        gameId: record.id,
        buildVersion: record.builtAt.toISOString(),
        path: record.webBuildPath,
      };
    }
  );
  fastify.get(
    '/games/:gameId/offline-file',
    protectedRoute,
    async (request, reply) => {
      const { root, record, manifest, files } = await inventory(
        request.params.gameId
      );
      if (
        request.query.manifest !== manifest.id ||
        request.query.build !== record.builtAt.toISOString()
      )
        return reply
          .code(409)
          .send({ message: 'Game build changed during preparation' });
      const file = files.get(request.query.path);
      if (!file)
        return reply.code(404).send({ message: 'Asset is not in this build' });
      const filename = await realpath(path.resolve(root, file.path));
      const info = await stat(filename);
      if (!inside(root, filename) || !info.isFile() || info.size !== file.size)
        return reply
          .code(409)
          .send({ message: 'Build asset changed; rebuild the game' });
      return reply
        .header('X-Content-Type-Options', 'nosniff')
        .type('application/octet-stream')
        .send(createReadStream(filename));
    }
  );
}
