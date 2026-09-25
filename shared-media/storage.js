import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const MEDIA_STORAGE_METHODS = Object.freeze([
  "put",
  "read",
  "exists",
  "publicRef"
]);

export function normalizeStorageKey(value) {
  if (typeof value !== "string") throw new TypeError("storage key must be a string");
  const key = value.trim();
  if (!key || key.length > 512 || key.startsWith("/") || key.includes("\\")
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)
    || key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError("storage key is invalid");
  }
  return key;
}

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError("media bytes must be a Buffer or Uint8Array");
}

export function assertMediaStorage(storage) {
  if (!storage || typeof storage !== "object") throw new TypeError("media storage adapter is required");
  for (const method of MEDIA_STORAGE_METHODS) {
    if (typeof storage[method] !== "function") throw new TypeError(`media storage.${method} is required`);
  }
  return storage;
}

function publicReference(base, key) {
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * A small persistent adapter used for local tests and controlled local
 * storage. It never maps a storage key outside its configured root and never
 * overwrites an existing object.
 */
export function createLocalFilesystemMediaStorage({ rootDirectory, publicBaseUrl = null } = {}) {
  if (typeof rootDirectory !== "string" || !path.isAbsolute(rootDirectory)) {
    throw new TypeError("rootDirectory must be an absolute path");
  }
  if (publicBaseUrl !== null && (typeof publicBaseUrl !== "string" || !publicBaseUrl.trim())) {
    throw new TypeError("publicBaseUrl must be a non-empty string or null");
  }
  const root = path.resolve(rootDirectory);

  function targetFor(key) {
    const normalizedKey = normalizeStorageKey(key);
    const target = path.resolve(root, ...normalizedKey.split("/"));
    const relative = path.relative(root, target);
    if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === "..") {
      throw new TypeError("storage key resolves outside rootDirectory");
    }
    return { key: normalizedKey, target };
  }

  async function put(key, bytes) {
    const target = targetFor(key);
    const content = asBytes(bytes);
    await mkdir(path.dirname(target.target), { recursive: true });
    const temporary = `${target.target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: "wx" });
      try {
        // A same-directory hard link publishes the completed temporary file
        // only when the target does not already exist. Unlike rename, this
        // cannot replace another object in the race between existence check
        // and publication.
        await link(temporary, target.target);
      } catch (error) {
        if (error?.code === "EEXIST") {
          const duplicate = new Error("storage key already exists");
          duplicate.code = "MEDIA_STORAGE_KEY_EXISTS";
          throw duplicate;
        }
        throw error;
      }
      await unlink(temporary).catch(() => {});
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return Object.freeze({
      key: target.key,
      byteSize: content.byteLength,
      publicRef: publicReference(publicBaseUrl, target.key)
    });
  }

  async function read(key) {
    const target = targetFor(key);
    return readFile(target.target);
  }

  async function exists(key) {
    const target = targetFor(key);
    try {
      const details = await stat(target.target);
      return details.isFile();
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  return Object.freeze({
    put,
    read,
    exists,
    publicRef(key) {
      return publicReference(publicBaseUrl, normalizeStorageKey(key));
    }
  });
}
