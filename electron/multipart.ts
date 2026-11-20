import type { IncomingMessage } from "node:http";
import type { DoubaoModel, GenerateRequestBody } from "./types.js";
import { HttpError } from "./http-error.js";
import {
  MAX_GENERATE_REQUEST_BYTES,
  MAX_REFERENCE_IMAGE_BYTES,
  parseReferenceFieldValues
} from "./reference-images.js";

export interface MultipartFilePart {
  fieldName: string;
  filename: string;
  contentType?: string;
  bytes: Buffer;
}

export interface MultipartParseResult {
  fields: Record<string, string[]>;
  files: MultipartFilePart[];
}

export interface ParsedGenerateBody {
  body: GenerateRequestBody;
  files: MultipartFilePart[];
}

export async function readBufferBody(
  request: IncomingMessage,
  maxBytes = MAX_GENERATE_REQUEST_BYTES
): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw new HttpError("请求体过大", 413, "payload_too_large");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      request.resume();
      throw new HttpError("请求体过大", 413, "payload_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function parseMultipartParts(buffer: Buffer, contentType: string): MultipartParseResult {
  const boundary = parseBoundary(contentType);
  if (!boundary) throw new HttpError("multipart boundary is required", 400, "invalid_multipart");
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string[]> = {};
  const files: MultipartFilePart[] = [];

  for (const rawPart of splitBuffer(buffer, delimiter)) {
    let part = rawPart;
    if (part.length === 0 || part.subarray(0, 2).toString() === "--") continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;

    const headers = parsePartHeaders(part.subarray(0, headerEnd).toString("utf8"));
    const body = part.subarray(headerEnd + 4);
    const disposition = parseContentDisposition(headers["content-disposition"] || "");
    if (!disposition.name) continue;

    if (disposition.filename !== undefined) {
      // Empty file inputs (filename="" and no bytes) are ignored rather than
      // converted into a bogus text field.
      if (body.length === 0) continue;
      if (body.length > MAX_REFERENCE_IMAGE_BYTES) {
        throw new HttpError(`参考图过大：${disposition.filename}`, 413, "reference_image_too_large");
      }
      files.push({
        fieldName: disposition.name,
        filename: disposition.filename || "reference-image",
        contentType: headers["content-type"],
        bytes: body
      });
      continue;
    }

    const value = body.toString("utf8");
    fields[disposition.name] = [...(fields[disposition.name] || []), value];
  }

  return { fields, files };
}

export function parseMultipartGenerateRequest(buffer: Buffer, contentType: string): ParsedGenerateBody {
  const { fields, files } = parseMultipartParts(buffer, contentType);
  const localPaths = [
    ...parseReferenceFieldValues(fields.referenceImages || [], "referenceImages"),
    ...parseReferenceFieldValues(fields.referenceImagePath || [], "referenceImagePath")
  ];
  const urls = [
    ...parseReferenceFieldValues(fields.referenceImageUrls || [], "referenceImageUrls"),
    ...parseReferenceFieldValues(fields.referenceImageUrl || [], "referenceImageUrl")
  ];

  return {
    files,
    body: {
      accountId: lastField(fields, "accountId"),
      model: lastField(fields, "model") as DoubaoModel | undefined,
      aspectRatio: lastField(fields, "aspectRatio") || null,
      durationSeconds: lastField(fields, "durationSeconds") ?? lastField(fields, "duration") ?? null,
      prompt: lastField(fields, "prompt") || "",
      removeWatermark: parseOptionalBoolean(lastField(fields, "removeWatermark")),
      callbackUrl: lastField(fields, "callbackUrl") || null,
      source: lastField(fields, "source") || "multipart-api",
      referenceImagePath: localPaths[0] ?? null,
      referenceImageUrl: urls[0] ?? null,
      referenceImages: localPaths,
      referenceImageUrls: urls
    }
  };
}

export function firstField(fields: Record<string, string[]>, name: string): string | undefined {
  return fields[name]?.[0];
}

export function lastField(fields: Record<string, string[]>, name: string): string | undefined {
  const values = fields[name];
  return values && values.length ? values[values.length - 1] : undefined;
}

export function parseOptionalBoolean(value: string | undefined) {
  if (value == null || value === "") return undefined;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function parseBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = (match?.[1] || match?.[2] || "").trim();
  return boundary || null;
}

function splitBuffer(buffer: Buffer, delimiter: Buffer) {
  const parts: Buffer[] = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    if (index > start) parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

function parsePartHeaders(value: string) {
  const headers: Record<string, string> = {};
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value: string): { name?: string; filename?: string } {
  const result: { name?: string; filename?: string } = {};
  for (const item of value.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim().toLowerCase();
    const rawValue = item.slice(separator + 1).trim();
    if (key === "name") result.name = unquote(rawValue);
    if (key === "filename") result.filename = unquote(rawValue);
    if (key === "filename*") {
      const encoded = rawValue.replace(/^[^']*'[^']*'/, "");
      try {
        result.filename = decodeURIComponent(encoded);
      } catch {
        result.filename = encoded;
      }
    }
  }
  return result;
}

function unquote(value: string) {
  return value.replace(/^"|"$/g, "");
}
