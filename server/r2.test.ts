import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileStore, resolveConfig } from "./r2.js";

const dirs: string[] = [];
const fresh = async () => {
  const dir = await mkdtemp(join(tmpdir(), "dot-lib-store-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("resolveConfig", () => {
  test("a file:// BLOB_URL is a directory store", () => {
    expect(resolveConfig({ BLOB_URL: pathToFileURL("/srv/blobs").href })).toEqual({ backend: "file", dir: "/srv/blobs" });
  });
  test("an s3:// BLOB_URL keeps its bucket and prefix", () => {
    const c = resolveConfig({ BLOB_URL: "s3://b/p", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s" });
    expect(c).toMatchObject({ backend: "s3", bucket: "b", prefix: "p/" });
  });
  test("nothing configured is an error", () => {
    expect(() => resolveConfig({})).toThrow(/R2_BUCKET/);
  });
});

describe("fileStore", () => {
  test("put, get, list and delete", async () => {
    const dir = await fresh();
    const s = fileStore(dir);
    expect(await s.listKeys("books/")).toEqual([]);
    expect(await s.getObjectBuffer("books/a/meta.json")).toBeNull();
    await s.putObject("books/a/meta.json", '{"id":"a"}', "application/json");
    await s.putObject("books/b/cover", new Uint8Array([1, 2]), "image/png");
    expect(await s.listKeys("books/")).toEqual(["books/a/meta.json", "books/b/cover"]);
    expect((await s.getObjectBuffer("books/a/meta.json"))?.toString()).toBe('{"id":"a"}');
    await s.deleteObject("books/a/meta.json");
    expect(await s.listKeys("books/")).toEqual(["books/b/cover"]);
    expect(await Bun.file(join(dir, "books", "a")).exists()).toBe(false);
    await s.deleteObject("books/b/cover");
    expect(await readdir(dir)).toEqual([]);
  });

  test("a multipart upload is assembled in part order and leaves nothing behind", async () => {
    const dir = await fresh();
    const s = fileStore(dir);
    const id = await s.createMultipart("books/x/book.epub", "application/epub+zip");
    const e2 = await s.uploadPart("books/x/book.epub", id, 2, Buffer.from("world"));
    const e1 = await s.uploadPart("books/x/book.epub", id, 1, Buffer.from("hello "));
    // the staging area is not part of the library
    expect(await s.listKeys("")).toEqual([]);
    await s.completeMultipart("books/x/book.epub", id, [
      { PartNumber: 2, ETag: e2 },
      { PartNumber: 1, ETag: e1 },
    ]);
    expect((await s.getObjectBuffer("books/x/book.epub"))?.toString()).toBe("hello world");
    expect(await s.listKeys("")).toEqual(["books/x/book.epub"]);
    expect(await Bun.file(join(dir, ".uploads", id)).exists()).toBe(false);
  });

  test("abort drops the staged parts", async () => {
    const s = fileStore(await fresh());
    const id = await s.createMultipart("books/y/book.pdf", "application/pdf");
    await s.uploadPart("books/y/book.pdf", id, 1, Buffer.from("x"));
    await s.abortMultipart("books/y/book.pdf", id);
    await expect(s.completeMultipart("books/y/book.pdf", id, [{ PartNumber: 1, ETag: "" }])).rejects.toThrow();
  });

  test("keys cannot leave the store or reach the staging area", async () => {
    const s = fileStore(await fresh());
    await expect(s.putObject("../escape", "x", "text/plain")).rejects.toThrow(/bad object key/);
    await expect(s.getObjectBuffer(".uploads/x")).rejects.toThrow(/bad object key/);
    await expect(s.uploadPart("books/z/book.epub", "../../etc", 1, Buffer.from("x"))).rejects.toThrow(/bad uploadId/);
  });
});
