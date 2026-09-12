import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";

import type { S3Target } from "../config.js";
import { log } from "../logger.js";

const clients = new Map<string, S3Client>();

export function s3(target: S3Target): S3Client {
  const key = `${target.endpoint}|${target.accessKeyId}|${target.region}`;
  let client = clients.get(key);
  if (!client) {
    client = new S3Client({
      endpoint: target.endpoint,
      region: target.region === "auto" ? "us-east-1" : target.region,
      forcePathStyle: target.forcePathStyle,
      credentials: { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey },
    });
    clients.set(key, client);
  }
  return client;
}

export function destroyS3Clients(): void {
  for (const client of clients.values()) client.destroy();
  clients.clear();
}

export interface ObjectRef {
  key: string;
  size: number;
  lastModified: Date | undefined;
}

/**
 * Streams every object under a prefix. MinIO paginates at 1000 keys; buckets with
 * millions of event blobs are normal, so callers consume this lazily rather than
 * building one giant array.
 */
export async function* listObjects(target: S3Target, prefixOverride?: string): AsyncGenerator<ObjectRef> {
  let continuationToken: string | undefined;
  const prefix = prefixOverride ?? target.prefix;
  do {
    const page = await s3(target).send(
      new ListObjectsV2Command({
        Bucket: target.bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );
    for (const obj of (page.Contents ?? []) as _Object[]) {
      if (!obj.Key) continue;
      yield { key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified };
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}

/** DeleteObjects accepts at most 1000 keys per call. */
export const DELETE_BATCH_SIZE = 1000;

export async function deleteObjects(target: S3Target, keys: string[]): Promise<{ deleted: number; errors: string[] }> {
  if (keys.length === 0) return { deleted: 0, errors: [] };
  let deleted = 0;
  const errors: string[] = [];

  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const chunk = keys.slice(i, i + DELETE_BATCH_SIZE);
    const response = await s3(target).send(
      new DeleteObjectsCommand({
        Bucket: target.bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    deleted += chunk.length - (response.Errors?.length ?? 0);
    for (const err of response.Errors ?? []) {
      errors.push(`${err.Key}: ${err.Code} ${err.Message}`);
    }
  }
  if (errors.length) log.warn("some objects could not be deleted", errors.slice(0, 5));
  return { deleted, errors };
}

export async function pingS3(target: S3Target): Promise<{ ok: boolean; error?: string }> {
  try {
    await s3(target).send(new ListObjectsV2Command({ Bucket: target.bucket, MaxKeys: 1 }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
