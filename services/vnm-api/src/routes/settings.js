import { encrypt, decrypt } from '../services/encryption.js';
import { SETTING_KEYS, getR2Config, createR2Client, testR2Connection } from '../services/r2Client.js';
import { ensureBucket, getZoneId, ensureCustomDomain, ensureRewriteRule } from '../services/cloudflareApi.js';

const SECRET_MASK = '••••••••••••••••';

/**
 * R2 settings routes (all admin-only, enforced by index.js middleware).
 * Only registered when VNM_R2_MODE=true.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function settingsRoutes(fastify) {
  const jwtSecret = fastify.jwtSecret;

  /**
   * GET /settings/r2
   * Returns the current R2 configuration with the secret access key masked.
   */
  fastify.get('/settings/r2', async (request, reply) => {
    const rows = await fastify.prisma.setting.findMany({
      where: { key: { in: Object.values(SETTING_KEYS) } },
    });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    return {
      accountId: map[SETTING_KEYS.ACCOUNT_ID] || '',
      accessKeyId: map[SETTING_KEYS.ACCESS_KEY_ID] || '',
      secretAccessKey: map[SETTING_KEYS.SECRET_ACCESS_KEY] ? SECRET_MASK : '',
      bucketName: map[SETTING_KEYS.BUCKET_NAME] || '',
      publicUrl: map[SETTING_KEYS.PUBLIC_URL] || '',
      apiToken: map[SETTING_KEYS.API_TOKEN] ? SECRET_MASK : '',
    };
  });

  /**
   * PUT /settings/r2
   * Saves R2 configuration. Encrypts the secret access key at rest.
   * If secretAccessKey is the mask sentinel, leave the stored secret unchanged.
   */
  fastify.put('/settings/r2', {
    schema: {
      body: {
        type: 'object',
        required: ['accountId', 'accessKeyId', 'bucketName', 'publicUrl'],
        properties: {
          accountId: { type: 'string', minLength: 1 },
          accessKeyId: { type: 'string', minLength: 1 },
          secretAccessKey: { type: 'string' },
          bucketName: { type: 'string', minLength: 1 },
          publicUrl: { type: 'string', minLength: 1 },
          apiToken: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { accountId, accessKeyId, secretAccessKey, bucketName, publicUrl, apiToken } = request.body;

    // Validate publicUrl is https
    try {
      const url = new URL(publicUrl);
      if (url.protocol !== 'https:') throw new Error();
    } catch {
      return reply.code(400).send({ code: 'INVALID_URL', message: 'publicUrl must be a valid HTTPS URL.' });
    }

    const upserts = [
      { key: SETTING_KEYS.ACCOUNT_ID, value: accountId },
      { key: SETTING_KEYS.ACCESS_KEY_ID, value: accessKeyId },
      { key: SETTING_KEYS.BUCKET_NAME, value: bucketName },
      { key: SETTING_KEYS.PUBLIC_URL, value: publicUrl.replace(/\/$/, '') },
    ];

    // Only update secret if a new value was provided (not the mask)
    if (secretAccessKey && secretAccessKey !== SECRET_MASK) {
      const encrypted = encrypt(secretAccessKey, jwtSecret);
      upserts.push({ key: SETTING_KEYS.SECRET_ACCESS_KEY, value: encrypted });
    }

    // Only update apiToken if a new value was provided (not the mask)
    if (apiToken && apiToken !== SECRET_MASK) {
      const encrypted = encrypt(apiToken, jwtSecret);
      upserts.push({ key: SETTING_KEYS.API_TOKEN, value: encrypted });
    }

    const now = new Date();
    for (const { key, value } of upserts) {
      await fastify.prisma.setting.upsert({
        where: { key },
        update: { value, updatedAt: now },
        create: { key, value },
      });
    }

    reply.code(204).send();
  });

  /**
   * POST /settings/r2/test
   * Tests the R2 connection with the provided (or stored) credentials.
   */
  fastify.post('/settings/r2/test', async (request, reply) => {
    const { accountId, accessKeyId, secretAccessKey, bucketName } = request.body ?? {};

    let resolvedSecret = secretAccessKey;

    // If the caller sent the mask, load the stored secret from the DB
    if (!resolvedSecret || resolvedSecret === SECRET_MASK) {
      const stored = await fastify.prisma.setting.findUnique({
        where: { key: SETTING_KEYS.SECRET_ACCESS_KEY },
      });
      if (!stored) {
        return reply.code(400).send({ code: 'NO_SECRET', message: 'No stored secret access key found.' });
      }
      try {
        resolvedSecret = decrypt(stored.value, jwtSecret);
      } catch {
        return reply.code(500).send({ code: 'DECRYPT_ERROR', message: 'Failed to decrypt stored secret.' });
      }
    }

    if (!accountId || !accessKeyId || !bucketName) {
      return reply.code(400).send({ code: 'MISSING_FIELDS', message: 'accountId, accessKeyId, and bucketName are required.' });
    }

    try {
      const client = createR2Client({ accountId, accessKeyId, secretAccessKey: resolvedSecret });
      await testR2Connection(client, bucketName);
      return { success: true, message: 'Connection successful.' };
    } catch (err) {
      return reply.code(400).send({ code: 'CONNECTION_FAILED', message: err.message || 'Could not connect to R2.' });
    }
  });

  /**
   * POST /settings/r2/setup
   * Connects the custom domain and creates the URL rewrite rule using the Cloudflare REST API.
   */
  fastify.post('/settings/r2/setup', async (request, reply) => {
    const config = await getR2Config(fastify.prisma, jwtSecret);
    if (!config) {
      return reply.code(400).send({ code: 'NOT_CONFIGURED', message: 'Save R2 credentials first.' });
    }
    if (!config.apiToken) {
      return reply.code(400).send({ code: 'NO_API_TOKEN', message: 'Cloudflare API Token is required for domain setup.' });
    }

    const hostname = new URL(config.publicUrl).hostname;
    const errors = [];
    let bucketStatus = 'failed';
    let domainStatus = 'failed';
    let ruleStatus = 'failed';

    // 1. Ensure bucket exists
    try {
      bucketStatus = await ensureBucket(config.apiToken, config.accountId, config.bucketName);
    } catch (err) {
      errors.push(`Bucket: ${err.message}`);
      return reply.send({ bucketStatus, domainStatus, ruleStatus, errors });
    }

    // 2. Get zone ID
    let zoneId;
    try {
      zoneId = await getZoneId(config.apiToken, hostname);
    } catch (err) {
      return reply.send({ bucketStatus, domainStatus: 'failed', ruleStatus: 'failed', errors: [err.message] });
    }

    // 3. Ensure custom domain
    try {
      domainStatus = await ensureCustomDomain(config.apiToken, config.accountId, config.bucketName, hostname);
    } catch (err) {
      errors.push(`Domain: ${err.message}`);
    }

    // 4. Ensure rewrite rule
    try {
      ruleStatus = await ensureRewriteRule(config.apiToken, zoneId, hostname);
    } catch (err) {
      errors.push(`Rewrite rule: ${err.message}`);
    }

    return { bucketStatus, domainStatus, ruleStatus, errors };
  });
}
