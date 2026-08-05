import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import config from '../config/config.js';
import logger from '../utils/logger.js';

let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (s3Client) return s3Client;

  s3Client = new S3Client({
    endpoint: `${config.minio.useSSL ? 'https' : 'http'}://${config.minio.endpoint}:${config.minio.port}`,
    region: 'us-east-1', // MinIO requires a region but ignores it
    credentials: {
      accessKeyId: config.minio.accessKey,
      secretAccessKey: config.minio.secretKey,
    },
    forcePathStyle: true, // Required for MinIO
  });

  return s3Client;
}

export async function initMinio(): Promise<S3Client> {
  const client = getS3Client();

  // Ensure bucket exists
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.minio.bucket }));
    logger.info(`MinIO bucket "${config.minio.bucket}" exists`);
  } catch {
    // Create bucket if it doesn't exist
    await client.send(new CreateBucketCommand({ Bucket: config.minio.bucket }));
    logger.info(`MinIO bucket "${config.minio.bucket}" created`);
  }

  logger.info(`MinIO connected to ${config.minio.endpoint}:${config.minio.port}`);
  return client;
}

export function isMinioEnabled(): boolean {
  return config.minio.enabled;
}

// Artifact key format: memories/{memoryId}/{hash}-{filename}
function artifactKey(memoryId: number, filename: string): string {
  const hash = crypto.randomBytes(6).toString('hex');
  return `memories/${memoryId}/${hash}-${filename}`;
}

export interface ArtifactMetadata {
  memoryId: number;
  filename: string;
  contentType: string;
  size: number;
  key: string;
  uploadedAt: string;
}

export async function storeArtifact(
  memoryId: number,
  filename: string,
  content: Buffer,
  contentType: string
): Promise<ArtifactMetadata> {
  const client = getS3Client();
  const key = artifactKey(memoryId, filename);

  await client.send(new PutObjectCommand({
    Bucket: config.minio.bucket,
    Key: key,
    Body: content,
    ContentType: contentType,
    Metadata: {
      'memory-id': memoryId.toString(),
      'original-filename': filename,
    },
  }));

  logger.info(`Artifact stored: ${key} (${content.length} bytes)`);

  return {
    memoryId,
    filename,
    contentType,
    size: content.length,
    key,
    uploadedAt: new Date().toISOString(),
  };
}

export async function getArtifact(key: string): Promise<{ content: Buffer; metadata: ArtifactMetadata } | null> {
  const client = getS3Client();

  try {
    const response = await client.send(new GetObjectCommand({
      Bucket: config.minio.bucket,
      Key: key,
    }));

    const chunks: Uint8Array[] = [];
    // Handle the stream
    if (response.Body) {
      const body = response.Body as AsyncIterable<Uint8Array>;
      for await (const chunk of body) {
        chunks.push(chunk);
      }
    }
    const content = Buffer.concat(chunks);

    return {
      content,
      metadata: {
        memoryId: parseInt(response.Metadata?.['memory-id'] || '0', 10),
        filename: response.Metadata?.['original-filename'] || '',
        contentType: response.ContentType || 'application/octet-stream',
        size: content.length,
        key,
        uploadedAt: response.LastModified?.toISOString() || '',
      },
    };
  } catch (err: unknown) {
    const s3Err = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (s3Err.name === 'NoSuchKey' || s3Err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function getArtifactUrl(key: string, expiresIn: number = 3600): Promise<string> {
  const client = getS3Client();
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: config.minio.bucket,
    Key: key,
  }), { expiresIn });
}

export async function deleteArtifact(key: string): Promise<void> {
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({
    Bucket: config.minio.bucket,
    Key: key,
  }));
  logger.info(`Artifact deleted: ${key}`);
}

export async function listArtifacts(memoryId: number): Promise<ArtifactMetadata[]> {
  const client = getS3Client();
  const prefix = `memories/${memoryId}/`;

  const response = await client.send(new ListObjectsV2Command({
    Bucket: config.minio.bucket,
    Prefix: prefix,
  }));

  return (response.Contents || []).map(obj => ({
    memoryId,
    filename: obj.Key?.replace(prefix, '').replace(/^[a-f0-9]+-/, '') || '',
    contentType: 'application/octet-stream', // ListObjects doesn't return ContentType
    size: obj.Size || 0,
    key: obj.Key || '',
    uploadedAt: obj.LastModified?.toISOString() || '',
  }));
}

export async function getStorageStats(): Promise<{ totalObjects: number; totalSize: number }> {
  const client = getS3Client();
  let totalObjects = 0;
  let totalSize = 0;
  let continuationToken: string | undefined;

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: config.minio.bucket,
      ContinuationToken: continuationToken,
    }));

    totalObjects += response.KeyCount || 0;
    for (const obj of response.Contents || []) {
      totalSize += obj.Size || 0;
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return { totalObjects, totalSize };
}
