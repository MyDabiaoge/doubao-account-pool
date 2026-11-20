import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./http-error.js";
import type { MultipartFilePart } from "./multipart.js";
import {
  MAX_REFERENCE_IMAGE_BYTES,
  canonicalLocalPathKey,
  extensionFromContentType,
  isSupportedReferenceUpload,
  planReferenceImageSources,
  sanitizeFilename,
  sniffImageExtension
} from "./reference-images.js";

interface PrepareReferenceImagesInput {
  requestId: string;
  uploadDir: string;
  uploads: MultipartFilePart[];
  localPaths: string[];
  urls: string[];
  fetchImpl?: typeof fetch;
}

export async function prepareReferenceImages(input: PrepareReferenceImagesInput): Promise<string[]> {
  for (const upload of input.uploads) {
    if (upload.bytes.length === 0) {
      throw new HttpError(`参考图为空：${upload.filename}`, 400, "reference_image_missing");
    }
    if (upload.bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
      throw new HttpError(`参考图过大：${upload.filename}`, 413, "reference_image_too_large");
    }
    if (!isSupportedReferenceUpload(upload.contentType, upload.filename)) {
      throw new HttpError(`参考图格式不受支持：${upload.filename}`, 400, "unsupported_reference_image");
    }
  }

  const plan = planReferenceImageSources({
    uploadCount: input.uploads.length,
    localPaths: input.localPaths,
    urls: input.urls
  });

  const resolvedLocalPaths: string[] = [];
  for (const localPath of plan.localPaths) {
    const resolved = path.resolve(localPath);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) {
      throw new HttpError(`参考图不存在、不是文件或为空：${resolved}`, 400, "reference_image_missing");
    }
    if (stat.size > MAX_REFERENCE_IMAGE_BYTES) {
      throw new HttpError(`参考图过大：${resolved}`, 413, "reference_image_too_large");
    }
    resolvedLocalPaths.push(resolved);
  }

  const writtenFiles: string[] = [];
  try {
    const savedUploads: string[] = [];
    for (const [offset, upload] of input.uploads.entries()) {
      const saved = await saveUploadedFile({
        requestId: input.requestId,
        index: offset + 1,
        uploadDir: input.uploadDir,
        upload
      });
      savedUploads.push(saved);
      writtenFiles.push(saved);
    }

    const downloads = await downloadAll({
      requestId: input.requestId,
      startIndex: savedUploads.length + 1,
      urls: plan.urls,
      uploadDir: input.uploadDir,
      fetchImpl: input.fetchImpl || fetch
    });
    writtenFiles.push(...downloads);

    const combined = dedupeByCanonicalPath([...savedUploads, ...resolvedLocalPaths, ...downloads]);
    if (combined.length > 10) {
      throw new HttpError("最多支持 10 张参考图", 400, "too_many_reference_images");
    }
    return combined;
  } catch (error) {
    await Promise.allSettled(writtenFiles.map(file => fs.rm(file, { force: true })));
    throw error;
  }
}

async function downloadAll(input: {
  requestId: string;
  startIndex: number;
  urls: string[];
  uploadDir: string;
  fetchImpl: typeof fetch;
}) {
  const settled = await Promise.allSettled(input.urls.map((url, offset) =>
    downloadReferenceUrl({
      requestId: input.requestId,
      index: input.startIndex + offset,
      url,
      uploadDir: input.uploadDir,
      fetchImpl: input.fetchImpl
    })
  ));
  const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (failure) {
    const downloaded = settled
      .filter((item): item is PromiseFulfilledResult<string> => item.status === "fulfilled")
      .map(item => item.value);
    await Promise.allSettled(downloaded.map(file => fs.rm(file, { force: true })));
    throw failure.reason;
  }
  return settled.map(item => (item as PromiseFulfilledResult<string>).value);
}

async function saveUploadedFile(input: {
  requestId: string;
  index: number;
  uploadDir: string;
  upload: MultipartFilePart;
}) {
  await fs.mkdir(input.uploadDir, { recursive: true });
  const safeName = sanitizeFilename(input.upload.filename);
  const extension = path.extname(safeName)
    || sniffImageExtension(input.upload.bytes)
    || extensionFromContentType(input.upload.contentType)
    || "";
  const filename = `${input.requestId}-reference-${input.index}-${safeName}${extension && !path.extname(safeName) ? extension : ""}`;
  const target = path.join(input.uploadDir, filename);
  await fs.writeFile(target, input.upload.bytes);
  return target;
}

async function downloadReferenceUrl(input: {
  requestId: string;
  index: number;
  url: string;
  uploadDir: string;
  fetchImpl: typeof fetch;
}) {
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new HttpError(
      `参考图下载失败：${input.url}（${error instanceof Error ? error.message : "网络错误"}）`,
      422,
      "reference_image_download_failed"
    );
  }
  if (!response.ok) {
    throw new HttpError(
      `参考图下载失败：${input.url}（HTTP ${response.status}）`,
      422,
      "reference_image_download_failed"
    );
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REFERENCE_IMAGE_BYTES) {
    throw new HttpError(`参考图过大：${input.url}`, 413, "reference_image_too_large");
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new HttpError(`参考图为空：${input.url}`, 400, "reference_image_missing");
  }
  if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new HttpError(`参考图过大：${input.url}`, 413, "reference_image_too_large");
  }

  const contentType = response.headers.get("content-type") || undefined;
  const urlExtension = path.extname(new URL(input.url).pathname).toLowerCase();
  const extension = sniffImageExtension(bytes)
    || extensionFromContentType(contentType)
    || (/^\.(png|jpe?g|webp|gif|bmp)$/.test(urlExtension) ? urlExtension : null);
  if (!extension && !isSupportedReferenceUpload(contentType, urlExtension)) {
    throw new HttpError(`参考图格式不受支持：${input.url}`, 422, "unsupported_reference_image");
  }

  await fs.mkdir(input.uploadDir, { recursive: true });
  const target = path.join(
    input.uploadDir,
    `${input.requestId}-reference-${input.index}${extension || ""}`
  );
  await fs.writeFile(target, bytes);
  return target;
}

function dedupeByCanonicalPath(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = canonicalLocalPathKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
