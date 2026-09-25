import sharp from "sharp";

const MAX_INPUT_BYTES = 30 * 1024 * 1024;

function sourceBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError("image bytes must be a Buffer or Uint8Array");
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${field} must be a positive integer`);
  return number;
}

function optionalCrop(value, sourceWidth, sourceHeight) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("crop must be an object");
  const normalizedLeft = Number(value.left ?? value.x);
  const normalizedTop = Number(value.top ?? value.y);
  if (!Number.isSafeInteger(normalizedLeft) || normalizedLeft < 0
    || !Number.isSafeInteger(normalizedTop) || normalizedTop < 0) {
    throw new TypeError("crop origin must be a non-negative integer");
  }
  const width = positiveInteger(value.width, "crop.width");
  const height = positiveInteger(value.height, "crop.height");
  if (normalizedLeft + width > sourceWidth || normalizedTop + height > sourceHeight) {
    throw new RangeError("crop is outside the source image");
  }
  return Object.freeze({ left: normalizedLeft, top: normalizedTop, width, height });
}

function imageOptions(options) {
  const value = options || {};
  const maxWidth = positiveInteger(value.maxWidth ?? 1600, "maxWidth");
  const maxHeight = positiveInteger(value.maxHeight ?? 1600, "maxHeight");
  const thumbnailWidth = positiveInteger(value.thumbnailWidth ?? 480, "thumbnailWidth");
  const thumbnailHeight = positiveInteger(value.thumbnailHeight ?? 480, "thumbnailHeight");
  const quality = Number(value.quality ?? 82);
  const thumbnailQuality = Number(value.thumbnailQuality ?? 72);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new TypeError("quality must be between 1 and 100");
  if (!Number.isInteger(thumbnailQuality) || thumbnailQuality < 1 || thumbnailQuality > 100) {
    throw new TypeError("thumbnailQuality must be between 1 and 100");
  }
  return { maxWidth, maxHeight, thumbnailWidth, thumbnailHeight, quality, thumbnailQuality, crop: value.crop ?? null };
}

async function renderWebp(input, crop, { width, height, quality }) {
  let pipeline = sharp(input, { failOn: "error", limitInputPixels: 64_000_000 });
  if (crop) pipeline = pipeline.extract(crop);
  const rendered = await pipeline
    .rotate()
    .resize({ width, height, fit: "inside", withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });
  return Object.freeze({
    bytes: rendered.data,
    width: rendered.info.width,
    height: rendered.info.height,
    mimeType: "image/webp"
  });
}

/**
 * Uses Sharp for the only supported raster work: verified pixel crop,
 * bounded resize, and a thumbnail. It does not read a device or take a
 * screenshot; callers provide already-obtained bytes.
 */
export async function createImageDerivatives(bytes, options = {}) {
  const input = sourceBytes(bytes);
  if (input.byteLength === 0 || input.byteLength > MAX_INPUT_BYTES) {
    throw new RangeError("image bytes exceed the supported input size");
  }
  const settings = imageOptions(options);
  const metadata = await sharp(input, { failOn: "error", limitInputPixels: 64_000_000 }).metadata();
  const sourceWidth = positiveInteger(metadata.width, "source image width");
  const sourceHeight = positiveInteger(metadata.height, "source image height");
  const crop = optionalCrop(settings.crop, sourceWidth, sourceHeight);
  const image = await renderWebp(input, crop, {
    width: settings.maxWidth,
    height: settings.maxHeight,
    quality: settings.quality
  });
  const thumbnail = await renderWebp(input, crop, {
    width: settings.thumbnailWidth,
    height: settings.thumbnailHeight,
    quality: settings.thumbnailQuality
  });
  return Object.freeze({
    source: Object.freeze({
      width: sourceWidth,
      height: sourceHeight,
      format: metadata.format || null,
      mimeType: metadata.format ? `image/${metadata.format === "jpg" ? "jpeg" : metadata.format}` : null
    }),
    crop,
    image,
    thumbnail
  });
}
