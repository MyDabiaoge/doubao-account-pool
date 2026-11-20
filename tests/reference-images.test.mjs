import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalLocalPathKey,
  firstStringFromStoredPaths,
  isSupportedReferenceUpload,
  normalizeReferenceUrl,
  parseReferenceFieldValues,
  parseStoredReferenceImagePaths,
  planReferenceImageSources,
  referenceImagesForStorage,
  sanitizeFilename,
  sniffImageExtension,
  toReferenceStringList
} from '../dist-electron/reference-images.js'
import { HttpError } from '../dist-electron/http-error.js'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])

test('reference string lists accept single values and arrays, reject non-strings', () => {
  assert.deepEqual(toReferenceStringList(' a.png '), ['a.png'])
  assert.deepEqual(toReferenceStringList(['a.png', ' ', 'b.png']), ['a.png', 'b.png'])
  assert.deepEqual(toReferenceStringList(undefined), [])
  assert.throws(() => toReferenceStringList([1], 'referenceImages'), error => error instanceof HttpError && error.code === 'invalid_reference_image')
  assert.deepEqual(parseReferenceFieldValues(['["a.png","b.png"]', ' c.png ']), ['a.png', 'b.png', 'c.png'])
  assert.deepEqual(parseReferenceFieldValues(['[not json']), ['[not json'])
})

test('local path keys dedupe separators and case on Windows without changing stored values', () => {
  const upper = 'C:\\Images\\Ref.PNG'
  const lower = 'c:/images/ref.png'
  if (process.platform === 'win32') {
    assert.equal(canonicalLocalPathKey(upper), canonicalLocalPathKey(lower))
  } else {
    assert.notEqual(canonicalLocalPathKey(upper), canonicalLocalPathKey(lower))
  }
  assert.ok(canonicalLocalPathKey('参考图.png').includes('参考图.png'))
})

test('reference URLs accept only http and https', () => {
  assert.equal(normalizeReferenceUrl('https://example.com/a.png'), 'https://example.com/a.png')
  assert.equal(normalizeReferenceUrl('HTTP://example.com/a.png'), 'http://example.com/a.png')
  for (const invalid of ['ftp://example.com/a.png', 'javascript:alert(1)', 'not a url']) {
    assert.equal(normalizeReferenceUrl(invalid), null)
  }
})

test('source planning preserves order, dedupes and enforces the ten image limit', () => {
  const plan = planReferenceImageSources({
    uploadCount: 1,
    localPaths: ['/a.png', '/a.png', '/b.png'],
    urls: ['https://example.com/c.png', 'https://example.com/c.png']
  })
  assert.deepEqual(plan.localPaths, ['/a.png', '/b.png'])
  assert.deepEqual(plan.urls, ['https://example.com/c.png'])
  assert.equal(plan.total, 4)
  assert.equal(plan.duplicateCount, 2)

  assert.equal(planReferenceImageSources({ uploadCount: 0, localPaths: Array.from({ length: 10 }, (_, i) => `/f-${i}.png`), urls: [] }).total, 10)
  assert.throws(
    () => planReferenceImageSources({ uploadCount: 0, localPaths: Array.from({ length: 11 }, (_, i) => `/f-${i}.png`), urls: [] }),
    error => error instanceof HttpError && error.statusCode === 400 && error.code === 'too_many_reference_images'
  )
  assert.throws(
    () => planReferenceImageSources({ uploadCount: 0, localPaths: ['https://example.com/a.png'], urls: [] }),
    error => error instanceof HttpError && error.code === 'invalid_reference_image_path'
  )
  assert.throws(
    () => planReferenceImageSources({ uploadCount: 0, localPaths: [], urls: ['ftp://example.com/a.png'] }),
    error => error instanceof HttpError && error.code === 'invalid_reference_image_url'
  )
})

test('stored path parsing falls back safely and mirrors the first image', () => {
  assert.deepEqual(parseStoredReferenceImagePaths('["/a.png","/b.png"]', null), ['/a.png', '/b.png'])
  assert.deepEqual(parseStoredReferenceImagePaths('not-json', '/legacy.png'), ['/legacy.png'])
  assert.deepEqual(parseStoredReferenceImagePaths('{"a":1}', null), [])
  assert.deepEqual(parseStoredReferenceImagePaths(null, '/legacy.png'), ['/legacy.png'])
  assert.deepEqual(parseStoredReferenceImagePaths('["/a.png", 3, "/a.png"]', null), ['/a.png'])
  assert.equal(firstStringFromStoredPaths('["/first.png","/second.png"]'), '/first.png')
  assert.equal(firstStringFromStoredPaths('broken'), null)

  const storage = referenceImagesForStorage({ paths: ['/a.png', '/b.png', '/a.png'] })
  assert.deepEqual(storage.paths, ['/a.png', '/b.png'])
  assert.equal(storage.firstPath, '/a.png')
  assert.equal(storage.pathsJson, JSON.stringify(['/a.png', '/b.png']))
  assert.equal(referenceImagesForStorage({ legacyPath: '/legacy.png' }).firstPath, '/legacy.png')
  assert.equal(referenceImagesForStorage({}).pathsJson, null)

  const capped = referenceImagesForStorage({ paths: Array.from({ length: 11 }, (_, i) => `/f-${i}.png`) })
  assert.equal(capped.paths.length, 10)
})

test('image type detection uses filenames, content types and magic bytes', () => {
  assert.equal(sniffImageExtension(png), '.png')
  assert.equal(sniffImageExtension(Buffer.from([0xff, 0xd8, 0xff])), '.jpg')
  assert.equal(sniffImageExtension(Buffer.from('GIF89a')), '.gif')
  assert.equal(sniffImageExtension(Buffer.from('RIFF0000WEBP')), '.webp')
  assert.equal(sniffImageExtension(Buffer.from('BM')), '.bmp')
  assert.equal(sniffImageExtension(Buffer.from('plain')), null)
  assert.equal(isSupportedReferenceUpload('image/png', 'a.bin'), true)
  assert.equal(isSupportedReferenceUpload('application/octet-stream', 'a.PNG'), true)
  assert.equal(isSupportedReferenceUpload('', 'a.webp'), true)
  assert.equal(isSupportedReferenceUpload('text/plain', 'a.png'), false)
  assert.equal(isSupportedReferenceUpload('text/plain', 'a.txt'), false)
  assert.equal(sanitizeFilename('a/b\\c:d.png'), 'a_b_c_d.png')
  assert.equal(sanitizeFilename('  '), 'reference-image')
})
