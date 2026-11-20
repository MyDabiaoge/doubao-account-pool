import path from "node:path";
import { HttpError } from "./http-error.js";

export const MAX_REFERENCE_IMAGES = 10;
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_GENERATE_REQUEST_BYTES = 100 * 1024 * 1024;

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export function toReferenceStringList(value: unknown, fieldName = "referenceImages"): string[] {
  if (value == null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") {
      throw new HttpError(`${fieldName} 必须是字符串数组`, 400, "invalid_reference_image");
    }
    const trimmed = item.trim();
    if (trimmed) result.push(trimmed);
  }
  return result;
}

export function parseReferenceFieldValues(values: string[], fieldName = "referenceImages"): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        result.push(...toReferenceStringList(parsed, fieldName));
        continue;
      } catch {
        // Not a JSON array after all; keep it as a literal value.
      }
    }
    result.push(trimmed);
  }
  return result;
}

export function canonicalLocalPathKey(value: string): string {
  const resolved = path.resolve(value).normalize("NFC");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function normalizeReferenceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function dedupeStrings(values: string[], keyOf: (value: string) => string) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function assertLocalPath(value: string) {
  if (/^https?:\/\//i.test(value)) {
    throw new HttpError(`referenceImages 只接受本机路径，URL 请使用 referenceImageUrls：${value}`, 400, "invalid_reference_image_path");
  }
  if (value.includes("\0")) {
    throw new HttpError("参考图路径包含非法字符", 400, "invalid_reference_image");
  }
}

export function planReferenceImageSources(input: {
  uploadCount: number;
  localPaths: string[];
  urls: string[];
}): { localPaths: string[]; urls: string[]; total: number; duplicateCount: number } {
  for (const localPath of input.localPaths) assertLocalPath(localPath);

  const localPaths = dedupeStrings(input.localPaths, canonicalLocalPathKey);
  const normalizedUrls: string[] = [];
  for (const rawUrl of input.urls) {
    const url = normalizeReferenceUrl(rawUrl);
    if (!url) {
      throw new HttpError(`参考图 URL 不是有效的 http/https 地址：${rawUrl}`, 400, "invalid_reference_image_url");
    }
    normalizedUrls.push(url);
  }
  const urls = dedupeStrings(normalizedUrls, value => value);

  const total = input.uploadCount + localPaths.length + urls.length;
  if (total > MAX_REFERENCE_IMAGES) {
    throw new HttpError(
      `最多支持 ${MAX_REFERENCE_IMAGES} 张参考图，合并去重后为 ${total} 张`,
      400,
      "too_many_reference_images"
    );
  }

  return {
    localPaths,
    urls,
    total,
    duplicateCount: Math.max(0,
      input.localPaths.length + input.urls.length - localPaths.length - urls.length
    )
  };
}

export function parseStoredReferenceImagePaths(
  rawJson: string | null | undefined,
  legacyPath: string | null | undefined
): string[] {
  const legacy = typeof legacyPath === "string" ? legacyPath.trim() : "";
  let paths: string[] = [];
  if (typeof rawJson === "string" && rawJson.trim()) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        paths = parsed
          .filter((item): item is string => typeof item === "string")
          .map(item => item.trim())
          .filter(Boolean);
      }
    } catch {
      paths = [];
    }
  }
  if (!paths.length && legacy) paths = [legacy];
  return dedupeStrings(paths, canonicalLocalPathKey).slice(0, MAX_REFERENCE_IMAGES);
}

export function referenceImagesForStorage(input: {
  paths?: unknown;
  legacyPath?: unknown;
}): { paths: string[]; firstPath: string | null; pathsJson: string | null } {
  const values = Array.isArray(input.paths)
    ? input.paths.filter((item): item is string => typeof item === "string")
    : [];
  if (typeof input.legacyPath === "string") values.push(input.legacyPath);
  const paths = dedupeStrings(
    values.map(item => item.trim()).filter(Boolean),
    canonicalLocalPathKey
  ).slice(0, MAX_REFERENCE_IMAGES);
  return {
    paths,
    firstPath: paths[0] ?? null,
    pathsJson: paths.length ? JSON.stringify(paths) : null
  };
}

export function firstStringFromStoredPaths(rawJson: string | null | undefined): string | null {
  return parseStoredReferenceImagePaths(rawJson, null)[0] ?? null;
}

export function extensionFromContentType(contentType?: string): string | null {
  if (!contentType) return null;
  const value = contentType.toLowerCase();
  if (value.includes("jpeg")) return ".jpg";
  if (value.includes("png")) return ".png";
  if (value.includes("webp")) return ".webp";
  if (value.includes("gif")) return ".gif";
  if (value.includes("bmp")) return ".bmp";
  return null;
}

export function sniffImageExtension(buffer: Buffer): string | null {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return ".png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return ".gif";
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return ".bmp";
  return null;
}

export function isSupportedReferenceUpload(contentType?: string, filename?: string): boolean {
  const type = (contentType || "").toLowerCase().trim();
  if (type.startsWith("image/")) return true;
  const extension = path.extname(filename || "").toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) return false;
  return type === "" || type === "application/octet-stream";
}

export function sanitizeFilename(value: string): string {
  const cleaned = value.replace(/[/\\?%*:|"<>]/g, "_").trim();
  return cleaned.slice(0, 120) || "reference-image";
}
