import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";

// Bounded for existing Buffer-based Sharp/storage adapters. Never silently
// buffer arbitrarily large media, and never trust claimed MIME for delivery.
export async function readMediaInput(input, { maxBytes = 30 * 1024 * 1024, signal } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes is invalid");
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  const chunks = [];
  let size = 0;
  const append = chunk => {
    signal?.throwIfAborted();
    if (!(chunk instanceof Uint8Array)) throw new TypeError("media stream must contain bytes");
    size += chunk.byteLength;
    if (size > maxBytes) throw new RangeError("media exceeds byte limit");
    const copy = Buffer.from(chunk);
    hash.update(copy);
    chunks.push(copy);
  };
  if (input instanceof Uint8Array) append(input);
  else {
    if (!input || typeof input[Symbol.asyncIterator] !== "function") throw new TypeError("bytes or byte stream required");
    const abort = () => input.destroy?.(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const chunk of input) append(chunk);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  if (!size) throw new TypeError("empty media is not supported");
  signal?.throwIfAborted();
  const bytes = Buffer.concat(chunks, size);
  const detected = await fileTypeFromBuffer(bytes);
  return Object.freeze({ bytes, sha256: hash.digest("hex"), byteSize: size,
    mimeType: detected?.mime?.split(";")[0] ?? "application/octet-stream",
    extension: detected?.ext ?? null, detected: Boolean(detected) });
}
