import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DOUBAO_DURATION_MAX_SECONDS,
  DOUBAO_DURATION_MIN_SECONDS,
  normalizeDoubaoDurationSeconds
} from '../dist-electron/generation-options.js'

test('normalizes supported Doubao video durations', () => {
  assert.equal(DOUBAO_DURATION_MIN_SECONDS, 4)
  assert.equal(DOUBAO_DURATION_MAX_SECONDS, 15)
  assert.equal(normalizeDoubaoDurationSeconds(4), 4)
  assert.equal(normalizeDoubaoDurationSeconds(10), 10)
  assert.equal(normalizeDoubaoDurationSeconds(15), 15)
  assert.equal(normalizeDoubaoDurationSeconds('12'), 12)
  assert.equal(normalizeDoubaoDurationSeconds(' 8 '), 8)
  assert.equal(normalizeDoubaoDurationSeconds('10.0'), 10)

  assert.equal(normalizeDoubaoDurationSeconds(undefined), null)
  assert.equal(normalizeDoubaoDurationSeconds(null), null)
  assert.equal(normalizeDoubaoDurationSeconds(''), null)
  assert.equal(normalizeDoubaoDurationSeconds('auto'), null)
  assert.equal(normalizeDoubaoDurationSeconds(3), null)
  assert.equal(normalizeDoubaoDurationSeconds(16), null)
  assert.equal(normalizeDoubaoDurationSeconds(10.5), null)
  assert.equal(normalizeDoubaoDurationSeconds('1e1'), null)
  assert.equal(normalizeDoubaoDurationSeconds(true), null)
})
