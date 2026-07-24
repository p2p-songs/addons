/**
 * A tiny object-store seam over S3-compatible storage (Cloudflare R2).
 *
 * The rest of the pipeline depends only on {@link ObjectStore} — get/put/list of
 * opaque byte blobs by key — so the dataset logic is unit-tested against an
 * in-memory fake and never needs real credentials, and the concrete S3 client is
 * the only thing that knows about AWS SDK, R2 endpoints, or auth.
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
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

/**
 * {@link ObjectStore} backed by a local directory — object key ⇄ file path.
 *
 * Lets `publishDataset` "stage" the exact bytes that would go to R2 (dated
 * snapshot + `latest.json`) into a folder, so any transport (wrangler, aws,
 * rclone) can upload it and the checksum/manifest logic stays in tested code.
 */
export class FileObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(join(this.root, key)));
  }

  async list(prefix: string): Promise<string[]> {
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const out: string[] = [];
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        // Keys are always POSIX-style regardless of host separator.
        else out.push(relative(this.root, full).split(sep).join(posix.sep));
      }
      return out;
    };
    return (await walk(this.root)).filter((k) => k.startsWith(prefix));
  }
}
