import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  classifyBuild,
  createAppStoreConnectToken,
  findMatchingBuild,
  waitForAppStoreBuild,
} from './wait-for-app-store-build.mjs'

const preReleaseVersion = (id, version) => ({
  attributes: { version },
  id,
  type: 'preReleaseVersions',
})

const build = ({ id = 'build-1', number = '7', processingState = 'VALID', versionId = 'v1' } = {}) => ({
  attributes: { processingState, version: number },
  id,
  relationships: { preReleaseVersion: { data: { id: versionId } } },
  type: 'builds',
})

const buildDocument = (builds = []) => ({
  data: builds,
  included: [preReleaseVersion('v1', '1.2.3'), preReleaseVersion('v2', '2.0.0')],
})

test('creates an App Store Connect ES256 token with a raw P-256 signature', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })
  const token = createAppStoreConnectToken({
    issuerId: 'issuer',
    keyId: 'key',
    now: 1_800_000_000_000,
    privateKey,
  })
  const [header, payload, signature] = token.split('.')
  const claims = JSON.parse(Buffer.from(payload, 'base64url'))

  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), {
    alg: 'ES256',
    kid: 'key',
    typ: 'JWT',
  })
  assert.equal(claims.aud, 'appstoreconnect-v1')
  assert.equal(claims.exp - claims.iat, 600)
  assert.equal(Buffer.from(signature, 'base64url').length, 64)
  assert.equal(
    crypto.verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')),
    false,
    'DER verification must not accidentally accept the required P1363 signature',
  )
  assert.equal(
    crypto.verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { dsaEncoding: 'ieee-p1363', key: publicKey },
      Buffer.from(signature, 'base64url'),
    ),
    true,
  )
})

test('matches both the marketing version and build number', () => {
  const wrongVersion = build({ id: 'wrong-version', versionId: 'v2' })
  const wrongNumber = build({ id: 'wrong-number', number: '8' })
  const expected = build({ id: 'expected' })

  assert.equal(
    findMatchingBuild(buildDocument([wrongVersion, wrongNumber, expected]), '1.2.3', '7'),
    expected,
  )
})

test('requires both valid processing and internal beta availability', () => {
  assert.equal(classifyBuild(build({ processingState: 'PROCESSING' })).status, 'waiting')
  assert.equal(classifyBuild(build({ processingState: 'INVALID' })).status, 'failed')
  assert.equal(
    classifyBuild(build(), { attributes: { internalBuildState: 'READY_FOR_BETA_TESTING' } }).status,
    'waiting',
  )
  assert.equal(
    classifyBuild(build(), { attributes: { internalBuildState: 'IN_BETA_TESTING' } }).status,
    'ready',
  )
})

test('polls until the exact build is available to internal testers', async () => {
  let buildPoll = 0
  let clock = 0
  const logs = []
  const client = {
    async get(path) {
      if (path.startsWith('/v1/apps?')) return { data: [{ id: 'app-1' }] }
      if (path.startsWith('/v1/builds?')) {
        buildPoll += 1
        if (buildPoll === 1) return buildDocument()
        if (buildPoll === 2) return buildDocument([build({ processingState: 'PROCESSING' })])
        return buildDocument([build()])
      }
      if (path === '/v1/buildBetaDetails/build-1') {
        return { data: { attributes: { internalBuildState: 'IN_BETA_TESTING' } } }
      }
      throw new Error(`Unexpected path ${path}`)
    },
  }

  const result = await waitForAppStoreBuild({
    buildNumber: '7',
    bundleId: 'in.innei',
    client,
    intervalMs: 1000,
    logger: { log: (message) => logs.push(message) },
    marketingVersion: '1.2.3',
    now: () => clock,
    sleep: async (duration) => {
      clock += duration
    },
    timeoutMs: 5000,
  })

  assert.equal(result.buildId, 'build-1')
  assert.equal(result.processingState, 'VALID')
  assert.equal(result.internalBuildState, 'IN_BETA_TESTING')
  assert.equal(buildPoll, 3)
  assert.match(logs.at(-1), /available to internal TestFlight testers/)
})

test('rejects an invalid build immediately', async () => {
  const client = {
    async get(path) {
      if (path.startsWith('/v1/apps?')) return { data: [{ id: 'app-1' }] }
      return buildDocument([build({ processingState: 'INVALID' })])
    },
  }

  await assert.rejects(
    waitForAppStoreBuild({
      buildNumber: '7',
      bundleId: 'in.innei',
      client,
      marketingVersion: '1.2.3',
    }),
    /processing ended in INVALID/,
  )
})

test('retries a transient App Store Connect request failure', async () => {
  let appPoll = 0
  let buildPoll = 0
  let clock = 0
  const client = {
    async get(path) {
      if (path.startsWith('/v1/apps?')) {
        appPoll += 1
        if (appPoll === 1) throw new Error('fetch failed')
        return { data: [{ id: 'app-1' }] }
      }
      if (path.startsWith('/v1/builds?')) {
        buildPoll += 1
        if (buildPoll === 1) throw new Error('fetch failed')
        return buildDocument([build()])
      }
      return { data: { attributes: { internalBuildState: 'IN_BETA_TESTING' } } }
    },
  }

  const result = await waitForAppStoreBuild({
    buildNumber: '7',
    bundleId: 'in.innei',
    client,
    intervalMs: 1000,
    logger: { log: () => {} },
    marketingVersion: '1.2.3',
    now: () => clock,
    sleep: async (duration) => {
      clock += duration
    },
    timeoutMs: 5000,
  })

  assert.equal(appPoll, 2)
  assert.equal(buildPoll, 2)
  assert.equal(result.internalBuildState, 'IN_BETA_TESTING')
})
