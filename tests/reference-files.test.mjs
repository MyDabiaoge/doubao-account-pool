import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { prepareReferenceImages } from '../dist-electron/reference-files.js'
import { HttpError } from '../dist-electron/http-error.js'
import { MAX_REFERENCE_IMAGE_BYTES } from '../dist-electron/reference-images.js'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3])

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-reference-files-'))
  const uploadDir = path.join(root, 'uploads', '2026-11-10')
  return { root, uploadDir }
}

function upload(filename = 'a.png', bytes = png, contentType = 'image/png') {
  return { fieldName: 'referenceImage', filename, contentType, bytes }
}

test('prepares uploads before local paths and keeps every image', async () => {
  const { root, uploadDir } = workspace()
  try {
    const first = path.join(root, '本机-1.png')
    const second = path.join(root, 'local-2.png')
    fs.writeFileSync(first, png)
    fs.writeFileSync(second, png)

    const result = await prepareReferenceImages({
      requestId: 'req-order',
      uploadDir,
      uploads: [upload()],
      localPaths: [first, second],
      urls: []
    })

    assert.equal(result.length, 3)
    assert.match(result[0], /req-order-reference-1-a\.png$/)
    assert.equal(result[1], path.resolve(first))
    assert.equal(result[2], path.resolve(second))
    for (const file of result) assert.equal(fs.existsSync(file), true, file)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rejects more than ten images before writing uploads', async () => {
  const { root, uploadDir } = workspace()
  try {
    await assert.rejects(
      prepareReferenceImages({
        requestId: 'req-eleven',
        uploadDir,
        uploads: [upload()],
        localPaths: Array.from({ length: 10 }, (_, index) => `/missing-${index}.png`),
        urls: []
      }),
      error => error instanceof HttpError && error.statusCode === 400 && error.code === 'too_many_reference_images'
    )
    assert.equal(fs.existsSync(uploadDir), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('dedupes repeated local paths', async () => {
  const { root, uploadDir } = workspace()
  try {
    const file = path.join(root, 'same.png')
    fs.writeFileSync(file, png)
    const result = await prepareReferenceImages({
      requestId: 'req-dedupe',
      uploadDir,
      uploads: [],
      localPaths: [file, file],
      urls: []
    })
    assert.deepEqual(result, [path.resolve(file)])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rejects missing, empty, oversized and unsupported reference images', async () => {
  const { root, uploadDir } = workspace()
  try {
    await assert.rejects(
      prepareReferenceImages({ requestId: 'req-missing', uploadDir, uploads: [], localPaths: [path.join(root, 'nope.png')], urls: [] }),
      error => error instanceof HttpError && error.statusCode === 400 && error.code === 'reference_image_missing'
    )

    const empty = path.join(root, 'empty.png')
    fs.writeFileSync(empty, Buffer.alloc(0))
    await assert.rejects(
      prepareReferenceImages({ requestId: 'req-empty', uploadDir, uploads: [], localPaths: [empty], urls: [] }),
      error => error instanceof HttpError && error.statusCode === 400
    )

    const big = path.join(root, 'big.png')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, MAX_REFERENCE_IMAGE_BYTES + 1)
    await assert.rejects(
      prepareReferenceImages({ requestId: 'req-big', uploadDir, uploads: [], localPaths: [big], urls: [] }),
      error => error instanceof HttpError && error.statusCode === 413
    )

    await assert.rejects(
      prepareReferenceImages({ requestId: 'req-type', uploadDir, uploads: [upload('a.txt', png, 'text/plain')], localPaths: [], urls: [] }),
      error => error instanceof HttpError && error.statusCode === 400 && error.code === 'unsupported_reference_image'
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('downloads URLs, and one failed URL removes every file written for the request', async () => {
  const { root, uploadDir } = workspace()
  const server = http.createServer((request, response) => {
    if (request.url === '/ok.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) })
      response.end(png)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('missing')
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const result = await prepareReferenceImages({
      requestId: 'req-url-ok',
      uploadDir,
      uploads: [upload()],
      localPaths: [],
      urls: [`${origin}/ok.png`]
    })
    assert.equal(result.length, 2)
    assert.match(result[1], /req-url-ok-reference-2\.png$/)
    assert.equal(fs.existsSync(result[1]), true)

    fs.rmSync(uploadDir, { recursive: true, force: true })
    await assert.rejects(
      prepareReferenceImages({
        requestId: 'req-url-fail',
        uploadDir,
        uploads: [upload()],
        localPaths: [],
        urls: [`${origin}/ok.png`, `${origin}/missing.png`]
      }),
      error => error instanceof HttpError && error.statusCode === 422 && error.code === 'reference_image_download_failed'
    )
    const leftovers = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : []
    assert.deepEqual(leftovers, [])
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rejects non-http URL protocols without touching the file system', async () => {
  const { root, uploadDir } = workspace()
  try {
    await assert.rejects(
      prepareReferenceImages({ requestId: 'req-url', uploadDir, uploads: [], localPaths: [], urls: ['ftp://example.com/a.png'] }),
      error => error instanceof HttpError && error.statusCode === 400 && error.code === 'invalid_reference_image_url'
    )
    assert.equal(fs.existsSync(uploadDir), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
