import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseMultipartGenerateRequest,
  parseMultipartParts,
  readBufferBody
} from '../dist-electron/multipart.js'
import { HttpError } from '../dist-electron/http-error.js'
import { MAX_REFERENCE_IMAGE_BYTES } from '../dist-electron/reference-images.js'

const boundary = '----fixture-boundary'
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3])

function buildPart({ name, filename, filenameStar, contentType, value }) {
  const headers = [`Content-Disposition: form-data; name="${name}";${filenameStar ? ` filename*=UTF-8''${filenameStar}` : filename !== undefined ? ` filename="${filename}"` : ''}`]
  if (contentType) headers.push(`Content-Type: ${contentType}`)
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '')
  return Buffer.concat([Buffer.from(`${headers.join('\r\n')}\r\n\r\n`), body, Buffer.from('\r\n')])
}

function buildMultipart(parts) {
  return Buffer.concat([
    ...parts.map(part => Buffer.concat([Buffer.from(`--${boundary}\r\n`), buildPart(part)])),
    Buffer.from(`--${boundary}--\r\n`)
  ])
}

function contentType() {
  return `multipart/form-data; boundary=${boundary}`
}

test('multipart collects every reference image file instead of only the first', () => {
  const parsed = parseMultipartGenerateRequest(buildMultipart([
    { name: 'prompt', value: '参考图中的人物，生成10秒动画' },
    { name: 'referenceImage', filename: '第一张.png', contentType: 'image/png', value: png },
    { name: 'referenceImage', filename: 'second.png', contentType: 'image/png', value: png }
  ]), contentType())

  assert.equal(parsed.body.prompt, '参考图中的人物，生成10秒动画')
  assert.equal(parsed.files.length, 2)
  assert.equal(parsed.files[0].filename, '第一张.png')
  assert.equal(parsed.files[1].filename, 'second.png')
  assert.deepEqual(parsed.files[0].bytes, png)
  assert.deepEqual(parsed.files[1].bytes, png)
})

test('multipart accepts numbered file fields and all ten reference images', () => {
  const parts = Array.from({ length: 10 }, (_, index) => ({
    name: `referenceImage${index + 1}`,
    filename: `ref-${index + 1}.png`,
    contentType: 'image/png',
    value: png
  }))
  const parsed = parseMultipartGenerateRequest(buildMultipart(parts), contentType())
  assert.equal(parsed.files.length, 10)
  assert.deepEqual(parsed.files.map(file => file.fieldName), parts.map(part => part.name))
})

test('multipart preserves repeated path and URL fields plus JSON array fields', () => {
  const parsed = parseMultipartGenerateRequest(buildMultipart([
    { name: 'prompt', value: 'fixture' },
    { name: 'referenceImagePath', value: '/images/a.png' },
    { name: 'referenceImagePath', value: '/images/b.png' },
    { name: 'referenceImages', value: '["/images/c.png","/images/d.png"]' },
    { name: 'referenceImageUrl', value: 'https://example.com/e.png' },
    { name: 'referenceImageUrls', value: '["https://example.com/f.png"]' }
  ]), contentType())

  assert.deepEqual(parsed.body.referenceImages, [
    '/images/c.png', '/images/d.png', '/images/a.png', '/images/b.png'
  ])
  assert.deepEqual(parsed.body.referenceImageUrls, [
    'https://example.com/f.png', 'https://example.com/e.png'
  ])
  assert.equal(parsed.body.referenceImagePath, '/images/c.png')
  assert.equal(parsed.body.referenceImageUrl, 'https://example.com/f.png')
})

test('multipart reads durationSeconds and its duration alias', () => {
  const seconds = parseMultipartGenerateRequest(buildMultipart([
    { name: 'prompt', value: 'fixture' },
    { name: 'durationSeconds', value: '12' }
  ]), contentType())
  assert.equal(seconds.body.durationSeconds, '12')

  const alias = parseMultipartGenerateRequest(buildMultipart([
    { name: 'prompt', value: 'fixture' },
    { name: 'duration', value: '7' }
  ]), contentType())
  assert.equal(alias.body.durationSeconds, '7')

  const omitted = parseMultipartGenerateRequest(buildMultipart([
    { name: 'prompt', value: 'fixture' }
  ]), contentType())
  assert.equal(omitted.body.durationSeconds, null)
})

test('multipart decodes RFC 5987 filenames and ignores empty file inputs', () => {
  const parsed = parseMultipartGenerateRequest(buildMultipart([
    { name: 'referenceImage', filenameStar: '%E5%8F%82%E8%80%83.png', contentType: 'image/png', value: png },
    { name: 'referenceImage', filename: '', value: '' },
    { name: 'prompt', value: 'fixture' }
  ]), contentType())

  assert.equal(parsed.files.length, 1)
  assert.equal(parsed.files[0].filename, '参考.png')
})

test('multipart rejects missing boundaries and oversized images', () => {
  assert.throws(
    () => parseMultipartParts(buildMultipart([{ name: 'prompt', value: 'fixture' }]), 'multipart/form-data'),
    error => error instanceof HttpError && error.statusCode === 400
  )

  const oversized = Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES + 1)
  assert.throws(
    () => parseMultipartParts(buildMultipart([
      { name: 'referenceImage', filename: 'big.png', contentType: 'image/png', value: oversized }
    ]), contentType()),
    error => error instanceof HttpError && error.statusCode === 413 && error.code === 'reference_image_too_large'
  )
})

test('readBufferBody enforces a maximum request size', async () => {
  const tooLargeByHeader = {
    headers: { 'content-length': '20' },
    resume() {},
    async *[Symbol.asyncIterator]() { yield Buffer.alloc(20) }
  }
  await assert.rejects(
    readBufferBody(tooLargeByHeader, 10),
    error => error instanceof HttpError && error.statusCode === 413 && error.code === 'payload_too_large'
  )

  const tooLargeWhileStreaming = {
    headers: {},
    resume() {},
    async *[Symbol.asyncIterator]() { yield Buffer.alloc(6); yield Buffer.alloc(6) }
  }
  await assert.rejects(
    readBufferBody(tooLargeWhileStreaming, 10),
    error => error instanceof HttpError && error.statusCode === 413
  )

  const ok = {
    headers: {},
    resume() {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('abc'); yield Buffer.from('def') }
  }
  assert.equal((await readBufferBody(ok, 10)).toString('utf8'), 'abcdef')
})
