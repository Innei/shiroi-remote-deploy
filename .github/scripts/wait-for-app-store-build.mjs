import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const API_ORIGIN = 'https://api.appstoreconnect.apple.com'
const TERMINAL_PROCESSING_STATES = new Set(['FAILED', 'INVALID'])
const TERMINAL_INTERNAL_STATES = new Set(['BETA_REVIEW_REJECTED', 'EXPIRED'])

const base64url = (value) => Buffer.from(value).toString('base64url')

export function createAppStoreConnectToken({
  issuerId,
  keyId,
  now = Date.now(),
  privateKey,
}) {
  const issuedAt = Math.floor(now / 1000)
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      aud: 'appstoreconnect-v1',
      exp: issuedAt + 600,
      iat: issuedAt,
      iss: issuerId,
    }),
  )
  const signingInput = `${header}.${payload}`
  const signature = crypto
    .sign('sha256', Buffer.from(signingInput), {
      dsaEncoding: 'ieee-p1363',
      key: privateKey,
    })
    .toString('base64url')

  return `${signingInput}.${signature}`
}

export function findMatchingBuild(document, marketingVersion, buildNumber) {
  const versions = new Map(
    (document.included ?? [])
      .filter((resource) => resource.type === 'preReleaseVersions')
      .map((resource) => [resource.id, resource.attributes?.version]),
  )

  return (document.data ?? []).find((build) => {
    const versionId = build.relationships?.preReleaseVersion?.data?.id
    return (
      String(build.attributes?.version) === String(buildNumber) &&
      versions.get(versionId) === marketingVersion
    )
  })
}

export function classifyBuild(build, betaDetail) {
  const processingState = build.attributes?.processingState ?? 'UNKNOWN'
  const internalBuildState = betaDetail?.attributes?.internalBuildState ?? 'UNKNOWN'

  if (TERMINAL_PROCESSING_STATES.has(processingState)) {
    return {
      message: `App Store processing ended in ${processingState}`,
      status: 'failed',
    }
  }

  if (processingState !== 'VALID') {
    return {
      message: `App Store processing state is ${processingState}`,
      status: 'waiting',
    }
  }

  if (internalBuildState === 'IN_BETA_TESTING') {
    return {
      message: 'Build is valid and available to internal TestFlight testers',
      status: 'ready',
    }
  }

  if (TERMINAL_INTERNAL_STATES.has(internalBuildState)) {
    return {
      message: `TestFlight internal build state ended in ${internalBuildState}`,
      status: 'failed',
    }
  }

  return {
    message: `Build is valid; TestFlight internal state is ${internalBuildState}`,
    status: 'waiting',
  }
}

export function createAppStoreClient({ fetchImpl = fetch, issuerId, keyId, privateKey }) {
  return {
    async get(path, now = Date.now()) {
      const token = createAppStoreConnectToken({ issuerId, keyId, now, privateKey })
      const response = await fetchImpl(new URL(path, API_ORIGIN), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      })
      const text = await response.text()
      let body

      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        body = { raw: text }
      }

      if (!response.ok) {
        const error = new Error(
          `App Store Connect returned ${response.status}: ${JSON.stringify(body.errors ?? body)}`,
        )
        error.status = response.status
        throw error
      }

      return body
    },
  }
}

const query = (path, params) => `${path}?${new URLSearchParams(params)}`

export async function waitForAppStoreBuild({
  buildNumber,
  bundleId,
  client,
  intervalMs = 30_000,
  logger = console,
  marketingVersion,
  now = Date.now,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  timeoutMs = 45 * 60_000,
}) {
  const startedAt = now()
  let app
  let lastMessage = ''
  while (now() - startedAt <= timeoutMs) {
    try {
      if (!app) {
        const apps = await client.get(
          query('/v1/apps', { 'filter[bundleId]': bundleId, limit: '1' }),
          now(),
        )
        app = apps.data?.[0]
        if (!app) {
          const error = new Error(`No App Store Connect app found for bundle ${bundleId}`)
          error.terminal = true
          throw error
        }
      }

      const builds = await client.get(
        query('/v1/builds', {
          'filter[app]': app.id,
          include: 'preReleaseVersion',
          limit: '50',
          sort: '-uploadedDate',
        }),
        now(),
      )
      const build = findMatchingBuild(builds, marketingVersion, buildNumber)

      if (!build) {
        lastMessage = `Waiting for ${marketingVersion} (${buildNumber}) to appear in App Store Connect`
      } else {
        const processingState = build.attributes?.processingState ?? 'UNKNOWN'
        let betaDetail

        if (processingState === 'VALID') {
          const details = await client.get(`/v1/buildBetaDetails/${build.id}`, now())
          betaDetail = details.data
        }

        const result = classifyBuild(build, betaDetail)
        lastMessage = `${marketingVersion} (${buildNumber}): ${result.message}`

        if (result.status === 'ready') {
          logger.log(lastMessage)
          return {
            buildId: build.id,
            buildNumber: String(buildNumber),
            internalBuildState: betaDetail.attributes.internalBuildState,
            marketingVersion,
            processingState,
          }
        }

        if (result.status === 'failed') {
          const error = new Error(lastMessage)
          error.terminal = true
          throw error
        }
      }
    } catch (error) {
      const permanentHttpFailure =
        error.status >= 400 && error.status < 500 && ![404, 429].includes(error.status)

      if (permanentHttpFailure || error.terminal) {
        throw error
      }

      lastMessage = `Transient App Store Connect error: ${error.message}`
    }

    logger.log(lastMessage)
    await sleep(intervalMs)
  }

  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 60_000)} minutes: ${lastMessage || 'build was not ready'}`,
  )
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positiveIntegerEnvironment(name, fallback) {
  const raw = process.env[name] ?? String(fallback)
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

async function main() {
  const client = createAppStoreClient({
    issuerId: requiredEnvironment('ASC_ISSUER_ID'),
    keyId: requiredEnvironment('ASC_KEY_ID'),
    privateKey: requiredEnvironment('ASC_API_KEY_P8'),
  })
  const result = await waitForAppStoreBuild({
    buildNumber: requiredEnvironment('BUILD_NUMBER'),
    bundleId: requiredEnvironment('APP_BUNDLE_ID'),
    client,
    intervalMs: positiveIntegerEnvironment('ASC_POLL_INTERVAL_SECONDS', 30) * 1000,
    marketingVersion: requiredEnvironment('MARKETING_VERSION'),
    timeoutMs: positiveIntegerEnvironment('ASC_WAIT_TIMEOUT_SECONDS', 2700) * 1000,
  })

  console.log(
    `Confirmed TestFlight ${result.marketingVersion} (${result.buildNumber}): ` +
      `${result.processingState} / ${result.internalBuildState}`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
