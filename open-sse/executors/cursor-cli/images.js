/**
 * Cursor CLI image safety.
 *
 * Validates, decodes, and encodes images for the Cursor Agent API using the
 * existing 9router shared outbound URL guard and strict bounds.
 */

// 1 MiB per image match OmniRoute's limit
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_IMAGES = 12;

const MAX_IMAGE_MIB = MAX_IMAGE_BYTES / (1024 * 1024);

/**
 * Decode a base64 image data URI. Returns { data, mimeType } or throws a
 * client-safe 400 error.
 */
export function decodeCursorCliDataUri(dataUri) {
  if (typeof dataUri !== "string") {
    throw Object.assign(
      new Error("Image data URI must be a string"),
      { status: 400, clientError: true }
    );
  }

  const comma = dataUri.indexOf(",");
  if (comma < 0) {
    throw Object.assign(
      new Error("Image data URI is malformed"),
      { status: 400, clientError: true }
    );
  }

  const header = dataUri.slice(5, comma); // strip "data:"
  const payload = dataUri.slice(comma + 1);
  const isBase64 = /;base64/i.test(header);
  const mimeType = (header.split(";")[0] || "").trim().toLowerCase() || "application/octet-stream";

  if (!mimeType.startsWith("image/")) {
    throw Object.assign(
      new Error("Image data URI must have an image/* media type"),
      { status: 400, clientError: true }
    );
  }

  if (!isBase64) {
    throw Object.assign(
      new Error("Image data URI must be base64-encoded"),
      { status: 400, clientError: true }
    );
  }

  // Pre-check payload before decode
  if (payload.length > MAX_IMAGE_BYTES * 2) {
    throw Object.assign(
      new Error(`Image input is too large (max ${MAX_IMAGE_MIB} MiB)`),
      { status: 400, clientError: true }
    );
  }

  const normalized = payload.replace(/\s/g, "");

  let data;
  try {
    data = Buffer.from(normalized, "base64");
  } catch {
    throw Object.assign(
      new Error("Image data URI contains invalid base64 data"),
      { status: 400, clientError: true }
    );
  }

  if (normalized.length > 0 && data.length === 0) {
    throw Object.assign(
      new Error("Image data URI contains invalid base64 data"),
      { status: 400, clientError: true }
    );
  }

  if (data.length > MAX_IMAGE_BYTES) {
    throw Object.assign(
      new Error(`Image input is too large (max ${MAX_IMAGE_MIB} MiB)`),
      { status: 400, clientError: true }
    );
  }

  return { data, mimeType };
}

/**
 * Extract images from OpenAI content blocks.
 * Supports both `image_url` (data: URIs and http(s) URLs) and OMP internal
 * `image` type blocks.
 */
export function extractCursorCliImages(content) {
  if (!Array.isArray(content)) return [];

  const images = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    // OpenAI image_url
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string"
        ? part.image_url
        : part.image_url?.url;
      if (url) images.push({ type: "image_url", url });
      continue;
    }

    // OMP internal image shape
    if (part.type === "image") {
      const data = part.data ?? part.source?.data;
      const mimeType = part.mimeType ?? part.media_type ?? part.source?.media_type;
      if (typeof data === "string" && mimeType) {
        images.push({ type: "image", data, mimeType });
      }
    }
  }

  // Enforce image count limit
  if (images.length > MAX_IMAGES) {
    throw Object.assign(
      new Error(`Too many images (max ${MAX_IMAGES})`),
      { status: 400, clientError: true }
    );
  }

  return images;
}

/**
 * Decode all images from OpenAI content into usable byte buffers with MIME types.
 * Safe — all images validated, capped, and no remote URLs fetched without guard.
 */
export function decodeCursorCliImages(content) {
  const images = extractCursorCliImages(content);
  if (images.length === 0) return [];

  const decoded = [];
  for (const img of images) {
    if (img.type === "image_url" && img.url.startsWith("data:")) {
      decoded.push(decodeCursorCliDataUri(img.url));
    } else if (img.type === "image") {
      decoded.push(decodeCursorCliDataUri(
        `data:${img.mimeType};base64,${img.data}`
      ));
    }
    // Remote URLs are intentionally not fetched here — use shared outbound guard
  }

  return decoded;
}
