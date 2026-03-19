import { S3Client, HeadBucketCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, statSync } from 'node:fs';
import { lookup as mimeLookup } from 'mime-types';
import { decrypt } from './encryption.js';

// Setting keys used in the DB
export const SETTING_KEYS = {
  ACCOUNT_ID: 'r2_account_id',
  ACCESS_KEY_ID: 'r2_access_key_id',
  SECRET_ACCESS_KEY: 'r2_secret_access_key',
  BUCKET_NAME: 'r2_bucket_name',
  PUBLIC_URL: 'r2_public_url',
  API_TOKEN: 'r2_api_token',
};

/**
 * Loads R2 configuration from the Setting table.
 * Decrypts the secret access key using the provided JWT secret as the encryption key.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} jwtSecret  The JWT secret used to encrypt/decrypt credentials
 * @returns {Promise<{accountId, accessKeyId, secretAccessKey, bucketName, publicUrl} | null>}
 */
export async function getR2Config(prisma, jwtSecret) {
  const settings = await prisma.setting.findMany({
    where: {
      key: { in: Object.values(SETTING_KEYS) },
    },
  });

  const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));

  const accountId = map[SETTING_KEYS.ACCOUNT_ID];
  const accessKeyId = map[SETTING_KEYS.ACCESS_KEY_ID];
  const encryptedSecret = map[SETTING_KEYS.SECRET_ACCESS_KEY];
  const bucketName = map[SETTING_KEYS.BUCKET_NAME];
  const publicUrl = map[SETTING_KEYS.PUBLIC_URL];
  const encryptedApiToken = map[SETTING_KEYS.API_TOKEN];

  if (!accountId || !accessKeyId || !encryptedSecret || !bucketName || !publicUrl) {
    return null;
  }

  let secretAccessKey;
  try {
    secretAccessKey = decrypt(encryptedSecret, jwtSecret);
  } catch {
    return null;
  }

  let apiToken = null;
  if (encryptedApiToken) {
    try {
      apiToken = decrypt(encryptedApiToken, jwtSecret);
    } catch {
      // leave null if decryption fails
    }
  }

  return { accountId, accessKeyId, secretAccessKey, bucketName, publicUrl, apiToken };
}

/**
 * Creates an S3Client configured for Cloudflare R2.
 *
 * @param {{ accountId: string, accessKeyId: string, secretAccessKey: string }} config
 * @returns {S3Client}
 */
export function createR2Client({ accountId, accessKeyId, secretAccessKey }) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

/**
 * Tests the R2 connection by issuing a HeadBucket request.
 * Throws if the connection or credentials are invalid.
 *
 * @param {S3Client} client
 * @param {string} bucketName
 */
export async function testR2Connection(client, bucketName) {
  await client.send(new HeadBucketCommand({ Bucket: bucketName }));
}

/**
 * Uploads a single local file to R2.
 * Uses @aws-sdk/lib-storage for automatic multipart on large files.
 *
 * @param {S3Client} client
 * @param {string} bucketName
 * @param {string} r2Key          Destination key in R2 (e.g. "games/abc123/index.html")
 * @param {string} localPath      Absolute local file path
 * @param {(loaded: number, total: number) => void} [onProgress]
 */
export async function uploadFile(client, bucketName, r2Key, localPath, onProgress) {
  const contentType = mimeLookup(localPath) || 'application/octet-stream';
  const { size } = statSync(localPath);

  const upload = new Upload({
    client,
    params: {
      Bucket: bucketName,
      Key: r2Key,
      Body: createReadStream(localPath),
      ContentType: contentType,
    },
  });

  if (onProgress) {
    upload.on('httpUploadProgress', (progress) => {
      onProgress(progress.loaded ?? 0, size);
    });
  }

  await upload.done();
}

/**
 * Deletes all objects in R2 whose keys begin with the given prefix.
 *
 * @param {S3Client} client
 * @param {string} bucketName
 * @param {string} prefix
 */
export async function deleteR2Prefix(client, bucketName, prefix) {
  let continuationToken;
  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects = (list.Contents ?? []).map((obj) => ({ Key: obj.Key }));
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: objects },
        })
      );
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * Deletes a single R2 object by key.
 *
 * @param {S3Client} client
 * @param {string} bucketName
 * @param {string} key
 */
export async function deleteR2Object(client, bucketName, key) {
  await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}
