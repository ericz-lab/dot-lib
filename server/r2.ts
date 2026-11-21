import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { mkdir, readdir, readFile, rm, rename, writeFile, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Object storage client. The bucket and credentials come from the ai-space
// storage contract when the app runs inside an ai-space workspace, and from
// the legacy R2_* variables otherwise:
//
//   BLOB_URL=s3://bucket/prefix/   plus S3_ENDPOINT / S3_REGION /
//   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY, all written by ai-space into
//   ~/.ai-space/data/dot-lib/space.env from the `storage.blobs` declaration
//   in space.yaml (see ai-space docs/storage.md).
//
//   BLOB_URL=file:///…/blobs   a directory store, what ai-space hands over where
//   the space has no bucket (`storage.blobs.fallback: file`), e.g. the
//   installation package on a machine without S3. Objects are files at
//   <dir>/<key>; multipart uploads are staged under <dir>/.uploads/.
//
//   R2_BUCKET + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY and R2_ENDPOINT or
//   R2_ACCOUNT_ID, the pre-ai-space configuration.
//
// Every key this module sees is relative to the store: `books/<id>/meta.json`.
// The prefix from BLOB_URL is added on the way out and stripped on the way in,
// so the rest of the server never knows about it.

interface S3Config {
  backend: "s3";
  bucket: string;
  prefix: string;
  endpoint: string | undefined;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface FileConfig {
  backend: "file";
  dir: string;
}

type StoreConfig = S3Config | FileConfig;

export function resolveConfig(env: Record<string, string | undefined> = process.env): StoreConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`Missing required env var ${name}`);
    return v;
  };
  const blobUrl = env.BLOB_URL?.trim();
  if (blobUrl?.startsWith("file://")) return { backend: "file", dir: fileURLToPath(blobUrl) };
  if (blobUrl) {
    const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(blobUrl.trim());
    if (!m) throw new Error(`BLOB_URL must look like s3://bucket/prefix/ or file:///dir, got ${blobUrl}`);
    const prefix = m[2] ? m[2].replace(/\/?$/, "/") : "";
    return {
      backend: "s3",
      bucket: m[1],
      prefix,
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION || "auto",
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    };
  }
  // R2_ENDPOINT overrides the default Cloudflare endpoint — useful for MinIO or
  // another S3-compatible store. When unset, R2_ACCOUNT_ID is required.
  return {
    backend: "s3",
    bucket: required("R2_BUCKET"),
    prefix: "",
    endpoint: env.R2_ENDPOINT || `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    region: "auto",
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  };
}

export interface UploadedPart {
  PartNumber: number;
  ETag: string;
}

/** The store operations the server uses; every key is relative to the store root. */
export interface Store {
  putObject(key: string, body: Buffer | Uint8Array | string, contentType: string): Promise<void>;
  getObjectBuffer(key: string): Promise<Buffer | null>;
  deleteObject(key: string): Promise<void>;
  /** Every key under a prefix, relative to the store. */
  listKeys(under: string): Promise<string[]>;
  // Big books can't be pushed in one request: a slow client hits Cloudflare's
  // 100s origin timeout, and buffering the whole file would blow the server's
  // small heap. Each part is its own short request instead.
  createMultipart(key: string, contentType: string): Promise<string>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer | Uint8Array): Promise<string>;
  completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export function s3Store(config: S3Config): Store {
  const { bucket, prefix } = config;
  const r2 = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  /** Full object key inside the bucket. */
  const k = (key: string): string => prefix + key;
  return {
    async putObject(key, body, contentType) {
      await r2.send(new PutObjectCommand({ Bucket: bucket, Key: k(key), Body: body, ContentType: contentType }));
    },
    async getObjectBuffer(key) {
      try {
        const res = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: k(key) }));
        const stream = res.Body as Readable;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      }
    },
    async deleteObject(key) {
      await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: k(key) }));
    },
    async listKeys(under) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const res = await r2.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: k(under), ContinuationToken: token })
        );
        for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key.slice(prefix.length));
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async createMultipart(key, contentType) {
      const res = await r2.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: k(key), ContentType: contentType })
      );
      if (!res.UploadId) throw new Error("R2 did not return an UploadId");
      return res.UploadId;
    },
    async uploadPart(key, uploadId, partNumber, body) {
      const res = await r2.send(
        new UploadPartCommand({ Bucket: bucket, Key: k(key), UploadId: uploadId, PartNumber: partNumber, Body: body })
      );
      if (!res.ETag) throw new Error("R2 did not return an ETag for the part");
      return res.ETag;
    },
    async completeMultipart(key, uploadId, parts) {
      await r2.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: k(key),
          UploadId: uploadId,
          MultipartUpload: { Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber) },
        })
      );
    },
    async abortMultipart(key, uploadId) {
      await r2.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: k(key), UploadId: uploadId }));
    },
  };
}

const UPLOADS = ".uploads";
const uploadIdPattern = /^[0-9a-f-]{36}$/;

/** A directory store: the object `books/<id>/meta.json` is the file `<dir>/books/<id>/meta.json`. */
export function fileStore(dir: string): Store {
  const path = (key: string): string => {
    const p = join(dir, key);
    const rel = relative(dir, p);
    if (!rel || rel.startsWith("..") || rel.split(sep)[0] === UPLOADS) throw new Error(`bad object key ${key}`);
    return p;
  };
  const staging = (uploadId: string): string => {
    if (!uploadIdPattern.test(uploadId)) throw new Error("bad uploadId");
    return join(dir, UPLOADS, uploadId);
  };
  // Write to a temporary name and rename, so a reader never sees half an object.
  const write = async (target: string, body: Buffer | Uint8Array | string) => {
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, target);
  };
  return {
    async putObject(key, body) {
      await write(path(key), body);
    },
    async getObjectBuffer(key) {
      try {
        return await readFile(path(key));
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "ENOENT") return null;
        throw err;
      }
    },
    async deleteObject(key) {
      await rm(path(key), { force: true });
    },
    async listKeys(under) {
      const base = join(dir, under);
      let entries: string[];
      try {
        entries = await readdir(base, { recursive: true });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "ENOENT") return [];
        throw err;
      }
      const keys: string[] = [];
      for (const entry of entries.sort()) {
        if (entry.endsWith(".tmp")) continue;
        const key = (under.replace(/\/?$/, "/") + entry.split(sep).join("/")).replace(/^\//, "");
        if (key.split("/")[0] === UPLOADS) continue;
        if ((await Bun.file(join(dir, key)).stat()).isFile()) keys.push(key);
      }
      return keys;
    },
    async createMultipart(key) {
      path(key);
      const uploadId = randomUUID();
      await mkdir(staging(uploadId), { recursive: true });
      return uploadId;
    },
    async uploadPart(key, uploadId, partNumber, body) {
      path(key);
      if (!Number.isInteger(partNumber) || partNumber < 1) throw new Error("bad part number");
      await writeFile(join(staging(uploadId), String(partNumber)), body);
      return `"${new Bun.CryptoHasher("md5").update(body).digest("hex")}"`;
    },
    async completeMultipart(key, uploadId, parts) {
      const target = path(key);
      const dirOfParts = staging(uploadId);
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.${randomUUID()}.tmp`;
      const out = await open(tmp, "w");
      try {
        for (const part of [...parts].sort((a, b) => a.PartNumber - b.PartNumber)) {
          if (!Number.isInteger(part.PartNumber) || part.PartNumber < 1) throw new Error("bad part number");
          await out.write(await readFile(join(dirOfParts, String(part.PartNumber))));
        }
      } catch (err) {
        await out.close();
        await rm(tmp, { force: true });
        throw err;
      }
      await out.close();
      await rename(tmp, target);
      await rm(dirOfParts, { recursive: true, force: true });
    },
    async abortMultipart(key, uploadId) {
      path(key);
      await rm(staging(uploadId), { recursive: true, force: true });
    },
  };
}

export function openStore(config: StoreConfig = resolveConfig()): Store {
  return config.backend === "file" ? fileStore(config.dir) : s3Store(config);
}

// Opened on first use, so importing this module (a test of fileStore) needs no configuration;
// the server touches the store at startup anyway (see index.ts).
let opened: Store | undefined;
const store = (): Store => (opened ??= openStore());
/** Open the store now, so a missing configuration stops the server at startup. */
export const ensureStore = (): void => void store();

export const putObject: Store["putObject"] = (...a) => store().putObject(...a);
export const getObjectBuffer: Store["getObjectBuffer"] = (...a) => store().getObjectBuffer(...a);
export const deleteObject: Store["deleteObject"] = (...a) => store().deleteObject(...a);
export const listKeys: Store["listKeys"] = (...a) => store().listKeys(...a);
export const createMultipart: Store["createMultipart"] = (...a) => store().createMultipart(...a);
export const uploadPart: Store["uploadPart"] = (...a) => store().uploadPart(...a);
export const completeMultipart: Store["completeMultipart"] = (...a) => store().completeMultipart(...a);
export const abortMultipart: Store["abortMultipart"] = (...a) => store().abortMultipart(...a);

export async function getJson<T>(key: string): Promise<T | null> {
  const buf = await getObjectBuffer(key);
  if (!buf) return null;
  return JSON.parse(buf.toString("utf-8")) as T;
}

export async function putJson(key: string, value: unknown): Promise<void> {
  await putObject(key, JSON.stringify(value), "application/json");
}
