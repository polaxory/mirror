// The ONLY file under api/_lib that touches the outside world.
//
// Sacred space: engine.js and cohort.js are pure and must stay that way, so all
// persistence is quarantined here behind one small interface:
//
//   readRecords()        -> array of cohort records (possibly empty)
//   recordWallet(rec)    -> fire-and-forget; never throws, never blocks a response
//   storeStatus()        -> which backend is live, for the seams
//
// Backends, chosen automatically:
//   * Redis over REST  — if KV_REST_API_URL + KV_REST_API_TOKEN are set. These are
//                        exactly the names Vercel KV injects, and Upstash uses the
//                        same REST shape, so either works with no code change and
//                        no SDK.
//   * Memory           — dev and tests. Per-process, lost on restart.
//
// Absence of a backend is a supported state, not an error: the app runs on priors
// and the interface says so. A free deployment must never break because nobody
// provisioned a database.

const URL_ = process.env.KV_REST_API_URL
const TOKEN = process.env.KV_REST_API_TOKEN
const HAS_REDIS = Boolean(URL_ && TOKEN)

const KEY_RECORDS = 'polaxory:cohort:records'
const KEY_SEEN = 'polaxory:cohort:seen'
const MAX_RECORDS = 5000

// Ladder inputs change slowly; recomputing them per request would be wasteful and
// would hammer the free tier. Serverless instances are reused, so a short in-process
// cache absorbs almost all of the read traffic.
const CACHE_TTL_MS = 5 * 60 * 1000
let cache = { at: 0, records: null }

const mem = { records: [], seen: new Set() }

// ---------- Redis REST

async function redis(commands) {
  const isPipeline = Array.isArray(commands[0])
  const res = await fetch(`${URL_}${isPipeline ? '/pipeline' : ''}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  })
  if (!res.ok) throw new Error(`kv ${res.status}`)
  return res.json()
}

// ---------- public interface

export function storeStatus() {
  return {
    backend: HAS_REDIS ? 'redis' : 'memory',
    durable: HAS_REDIS,
    note: HAS_REDIS
      ? 'Cohort persists across requests and deploys.'
      : 'No cohort store configured — percentiles fall back to research-derived priors. Set KV_REST_API_URL and KV_REST_API_TOKEN to accumulate a measured cohort.',
  }
}

export async function readRecords({ force = false } = {}) {
  const now = Date.now()
  if (!force && cache.records && now - cache.at < CACHE_TTL_MS) return cache.records

  let records = []
  if (HAS_REDIS) {
    try {
      const out = await redis(['LRANGE', KEY_RECORDS, '0', String(MAX_RECORDS - 1)])
      const raw = out?.result || []
      records = raw
        .map((s) => { try { return JSON.parse(s) } catch { return null } })
        .filter(Boolean)
    } catch {
      // A read failure degrades to priors rather than failing the request.
      records = cache.records || []
    }
  } else {
    records = mem.records
  }

  cache = { at: now, records }
  return records
}

// Dedupe by wallet hash so one wallet scanned fifty times counts once and cannot
// drag the cohort toward itself. Returns { admitted } for the caller's telemetry;
// callers must not await this on the critical path.
export async function recordWallet(rec) {
  if (!rec || !rec.h) return { admitted: false, reason: 'no record' }
  try {
    if (HAS_REDIS) {
      const added = await redis(['SADD', KEY_SEEN, rec.h])
      if (added?.result !== 1) return { admitted: false, reason: 'already in cohort' }
      await redis([
        ['LPUSH', KEY_RECORDS, JSON.stringify(rec)],
        ['LTRIM', KEY_RECORDS, '0', String(MAX_RECORDS - 1)],
      ])
    } else {
      if (mem.seen.has(rec.h)) return { admitted: false, reason: 'already in cohort' }
      mem.seen.add(rec.h)
      mem.records.unshift(rec)
      if (mem.records.length > MAX_RECORDS) mem.records.length = MAX_RECORDS
    }
    // A new member invalidates the cached ladder inputs.
    cache = { at: 0, records: null }
    return { admitted: true }
  } catch (e) {
    return { admitted: false, reason: 'store unavailable' }
  }
}

// ---------- wallet profile cache
//
// A holder scan profiles dozens of wallets, and a wallet's realized history changes
// slowly, so re-fetching it per scan wastes the rate limit and the function budget.
//
// Keyed by the SAME salted hash the cohort uses, never by address. The cache does
// need to look a wallet up, but it only ever does so with the address already in
// hand — so hashing costs nothing and means the store still holds no addresses.
// A short TTL keeps this a performance cache of public data rather than a dossier.
const PROFILE_TTL_SEC = 6 * 60 * 60
const memProfiles = new Map()

export async function readProfile(hash) {
  if (!hash) return null
  try {
    if (HAS_REDIS) {
      const out = await redis(['GET', `polaxory:profile:${hash}`])
      if (!out?.result) return null
      return JSON.parse(out.result)
    }
    const hit = memProfiles.get(hash)
    if (!hit) return null
    if (Date.now() - hit.at > PROFILE_TTL_SEC * 1000) { memProfiles.delete(hash); return null }
    return hit.value
  } catch {
    return null
  }
}

export async function writeProfile(hash, value) {
  if (!hash || !value) return false
  try {
    if (HAS_REDIS) {
      await redis(['SET', `polaxory:profile:${hash}`, JSON.stringify(value), 'EX', String(PROFILE_TTL_SEC)])
      return true
    }
    memProfiles.set(hash, { at: Date.now(), value })
    return true
  } catch {
    return false
  }
}

// Test seam. Not used in production paths.
export function __resetMemory() {
  mem.records = []
  mem.seen = new Set()
  memProfiles.clear()
  cache = { at: 0, records: null }
}
