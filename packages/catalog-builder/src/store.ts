/**
 * A tiny object-store seam over S3-compatible storage (Cloudflare R2).
 *
 * The rest of the pipeline depends only on {@link ObjectStore} — get/put/list of
 * opaque byte blobs by key — so the dataset logic is unit-tested against an
 * in-memory fake and never needs real credentials, and the concrete S3 client is
 * the only thing that knows about AWS SDK, R2 endpoints, or auth.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Object keys under `prefix` (unsorted). */
  list(prefix: string): Promise<string[]>;
}

export interface S3Options {
  /** e.g. `https://<account>.r2.cloudflarestorage.com` */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** {@link ObjectStore} backed by S3-compatible storage. R2 wants `region: "auto"`. */
export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(opts: S3Options) {
    this.bucket = opts.bucket;
    this.s3 = new S3Client({
      region: "auto",
      endpoint: opts.endpoint,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`empty body for ${key}`);
    return res.Body.transformToByteArray();
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
}
