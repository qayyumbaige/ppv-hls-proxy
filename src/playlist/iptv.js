import { USER_AGENT, getAllApiBases } from '../env.js'
import { embedFromSource } from '../embed/context.js'
import { resolveEmbedStreamUrl } from '../embed/decrypt.js'

/**
 * Events with a start time but no end time are treated as live for this long
 * after kickoff, so stale entries don't sit in the playlist forever.
 */
const DEFAULT_LIVE_WINDOW_SECS = 4 * 3600

async function fetchAllStreams() {
  const bases = getAllApiBases()
  let lastError = null

  for (const base of bases) {
    try {
      const res = await fetch(`${base}/streams`, {
        headers: { 'User-Agent': USER_AGENT },
      })
      if (!res.ok) {
        lastError = `HTTP ${res.status} from ${base}`
        continue
      }
      const data = await res.json()
      if (!data?.success || !data?.streams) {
        lastError = data?.error || 'invalid response'
        continue
      }
      return data.streams
    } catch (e) {
      lastError = e.message
      continue
    }
  }
  throw new Error(lastError || 'all API domains failed')
}

async function fetchStreamMeta(uri) {
  const bases = getAllApiBases()
  let lastError = null

  for (const base of bases) {
    try {
      const res = await fetch(`${base}/streams/${uri}`, {
        headers: { 'User-Agent': USER_AGENT },
      })
      if (!res.ok) {
        if (res.status === 404) throw new Error(`not found: ${uri}`)
        lastError = `upstream ${res.status} from ${base}`
        continue
      }
      const json = await res.json()
      if (!json?.success || !json?.data) {
        if (json?.statusCode === 404 || json?.status_code === 404) {
          throw new Error(`not found: ${uri}`)
        }
        lastError = json?.error || 'empty payload'
        continue
      }
      return json.data
    } catch (e) {
      lastError = e.message
      if (e.message.startsWith('not found:')) throw e
      continue
    }
  }
  throw new Error(lastError || 'all API domains failed')
}

function escAttr(s) {
  return String(s || '').replace(/"/g, "'")
}

/** Normalise a raw timestamp into epoch *seconds* (handles ms + ISO strings). */
function toEpochSeconds(raw) {
  if (raw === null || raw === undefined || raw === '') return 0
  let n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    const t = Date.parse(raw)
    if (!Number.isNaN(t)) n = Math.floor(t / 1000)
    else return 0
  }
  if (n > 1e12) n = Math.floor(n / 1000) // ms → secs
  return Math.floor(n)
}

/** Pull start/end times off a stream, tolerating several field spellings. */
function getSchedule(stream) {
  const start =
    toEpochSeconds(stream.starts_at) ||
    toEpochSeconds(stream.start_time) ||
    toEpochSeconds(stream.startTime) ||
    toEpochSeconds(stream.start) ||
    toEpochSeconds(stream.date)

  const end =
    toEpochSeconds(stream.ends_at) ||
    toEpochSeconds(stream.end_time) ||
    toEpochSeconds(stream.endTime) ||
    toEpochSeconds(stream.end)

  return { start, end }
}

/**
 * Classify a stream's state:
 * - "live"     → airing right now (or 24/7)
 * - "upcoming" → has a start time in the future
 * - null       → finished / expired / no usable schedule
 */
function classifyStream(stream, now) {
  if (stream.always_live) return 'live'

  const { start, end } = getSchedule(stream)
  if (!start) return null

  if (start > now) return 'upcoming'
  if (end && end < now) return null
  if (end) return 'live'
  return now - start <= DEFAULT_LIVE_WINDOW_SECS ? 'live' : null
}

function formatEventTime(startSecs, { includeDate = false } = {}) {
  const start = Number(startSecs) || 0
  if (!start) return ''
  const d = new Date(start * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  if (!includeDate) return time
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return `${date} ${time}`
}

function buildLabel(stream, name, state) {
  const { start } = getSchedule(stream)
  if (state === 'live') {
    const when = formatEventTime(start, { includeDate: false })
    return when ? `Live @ ${when} — ${name}` : `Live — ${name}`
  }
  const when = formatEventTime(start, { includeDate: true })
  return when ? `Upcoming @ ${when} — ${name}` : `Upcoming — ${name}`
}

function cleanCategory(cat) {
  const name = String(cat.category || cat.category_name || '').trim()
  if (!name || name === '(?)' || name.toLowerCase() === 'uncategorized') return ''
  return name
}

/** The /streams index often omits schedule fields — fetch detail if missing. */
async function enrichWithSchedule(stream) {
  const { start } = getSchedule(stream)
  if (start) return stream
  if (!stream.uri_name) return stream
  try {
    const meta = await fetchStreamMeta(stream.uri_name)
    return { ...meta, ...stream } // index fields win (iframe, substreams)
  } catch {
    return stream
  }
}

/**
 * Generate an M3U8 playlist that includes BOTH live and upcoming events.
 * Labels:
 *   Live     → "Live @ 14:30 UTC — Title"
 *   Upcoming → "Upcoming @ 2026-10-03 20:00 UTC — Title"
 *
 * @param {string} origin - This server's origin, e.g. http://192.168.1.10:3000
 * @param {string} [categoryFilter] - Optional category name to filter by
 * @returns {Promise<string>} M3U8 playlist text
 */
export async function generatePlaylist(origin, categoryFilter) {
  const categories = await fetchAllStreams()
  const now = Math.floor(Date.now() / 1000)

  const lines = ['#EXTM3U']

  for (const cat of categories) {
    const catName = cleanCategory(cat)
    if (!catName) continue

    if (categoryFilter && catName.toLowerCase() !== categoryFilter.toLowerCase()) continue

    for (const rawStream of cat.streams || []) {
      const stream = await enrichWithSchedule(rawStream)

      const name = stream.name || 'Unknown'
      const uri = stream.uri_name || ''
      if (!uri || !stream.iframe) continue

      const state = classifyStream(stream, now)
      if (!state) continue // finished / expired only

      const logo = stream.poster || ''
      const group = catName
      const label = buildLabel(stream, name, state)
      const id = `${state}-${uri.replace(/\//g, '-')}`

      lines.push(
        `#EXTINF:-1 tvg-id="${escAttr(id)}" tvg-name="${escAttr(label)}" tvg-logo="${escAttr(logo)}" group-title="${escAttr(group)}",${label}`,
      )
      lines.push(`${origin}/live/${uri}.m3u8`)

      for (const sub of stream.substreams || []) {
        if (!sub.iframe || !sub.uri_name) continue
        const subTitle = `${name} — ${sub.source_tag || sub.uri_name}`
        const subLabel = buildLabel(stream, subTitle, state)
        const subId = `${state}-${sub.uri_name.replace(/\//g, '-')}`

        lines.push(
          `#EXTINF:-1 tvg-id="${escAttr(subId)}" tvg-name="${escAttr(subLabel)}" tvg-logo="${escAttr(logo)}" group-title="${escAttr(group)}",${subLabel}`,
        )
        lines.push(`${origin}/live/${sub.uri_name}.m3u8`)
      }
    }
  }

  return lines.join('\n') + '\n'
}

async function findSubstream(uri) {
  const categories = await fetchAllStreams()
  for (const cat of categories) {
    for (const stream of cat.streams || []) {
      for (const sub of stream.substreams || []) {
        if (sub.uri_name === uri && sub.iframe) return sub
      }
    }
  }
  return null
}

export async function resolveLiveChannel(uri) {
  let data = null
  try {
    data = await fetchStreamMeta(uri)
  } catch (err) {
    const sub = await findSubstream(uri)
    if (!sub) throw err
    const embed = embedFromSource({ data: sub.iframe })
    const streamUrl = await resolveEmbedStreamUrl(embed)
    return { streamUrl, embed }
  }

  const source = (data.sources || []).find((s) => s.default)
  if (!source?.data) throw new Error('no default embed source')

  const embed = embedFromSource(source)
  const streamUrl = await resolveEmbedStreamUrl(embed)

  return { streamUrl, embed }
}