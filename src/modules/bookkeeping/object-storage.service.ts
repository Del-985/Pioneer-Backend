import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http-error.js';

let client: S3Client | null = null;

function requireStorageConfig() {
  if (
    !env.OBJECT_STORAGE_BUCKET ||
    !env.OBJECT_STORAGE_ACCESS_KEY_ID ||
    !env.OBJECT_STORAGE_SECRET_ACCESS_KEY
  ) {
    throw new HttpError(
      503,
      'OBJECT_STORAGE_NOT_CONFIGURED',
      'Bookkeeping attachment object storage is not configured.'
    );
  }

  return {
    bucket: env.OBJECT_STORAGE_BUCKET,
    region: env.OBJECT_STORAGE_REGION,
    endpoint: env.OBJECT_STORAGE_ENDPOINT,
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE,
    expiresIn: env.OBJECT_STORAGE_PRESIGN_SECONDS,
  };
}

function storageClient() {
  if (client) return client;
  const config = requireStorageConfig();
  const clientConfig: S3ClientConfig = {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  };
  if (config.endpoint) clientConfig.endpoint = config.endpoint;
  client = new S3Client(clientConfig);
  return client;
}

export function isObjectStorageConfigured() {
  return Boolean(
    env.OBJECT_STORAGE_BUCKET &&
    env.OBJECT_STORAGE_ACCESS_KEY_ID &&
    env.OBJECT_STORAGE_SECRET_ACCESS_KEY
  );
}

export async function createUploadUrl(input: {
  storageKey: string;
  contentType: string;
  byteSize: number;
}) {
  const config = requireStorageConfig();
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: input.storageKey,
    ContentType: input.contentType,
    ContentLength: input.byteSize,
  });
  return getSignedUrl(storageClient(), command, { expiresIn: config.expiresIn });
}

export async function createDownloadUrl(storageKey: string) {
  const config = requireStorageConfig();
  const command = new GetObjectCommand({ Bucket: config.bucket, Key: storageKey });
  return getSignedUrl(storageClient(), command, { expiresIn: config.expiresIn });
}
