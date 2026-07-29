export const isNum = (x) => x !== null && x !== undefined && Number.isFinite(x)

export const sol = (x, { sign = true, dp } = {}) => {
  if (!isNum(x)) return '—'
  const d = dp ?? (Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2)
  const s = sign && x > 0 ? '+' : ''
  return `${s}${x.toFixed(d)}`
}

export const pct = (x, dp = 0) => (isNum(x) ? `${(x * 100).toFixed(dp)}%` : '—')

export const num = (x, dp = 2) => (isNum(x) ? x.toFixed(dp) : '—')

// Profit factor is capped at 10 inside the engine for bootstrap stability.
export const pfmt = (x) => (!isNum(x) ? '—' : x >= 10 ? '>10' : x.toFixed(2))

export const dur = (min) => {
  if (!isNum(min)) return '—'
  if (min < 1) return '<1m'
  if (min < 90) return `${Math.round(min)}m`
  if (min < 60 * 36) return `${(min / 60).toFixed(1)}h`
  return `${(min / 1440).toFixed(1)}d`
}

export const ratio = (x) => (isNum(x) ? (x >= 10 ? `${Math.round(x)}x` : `${x.toFixed(1)}x`) : '—')

export const ci = (obj, f = num) =>
  obj && isNum(obj.lo) && isNum(obj.hi) ? `${f(obj.lo)} to ${f(obj.hi)}` : null

export const ciPct = (obj) =>
  obj && isNum(obj.lo) && isNum(obj.hi) ? `${pct(obj.lo)}–${pct(obj.hi)}` : null

export const shortMint = (m) => (typeof m === 'string' && m.length > 12 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m)

export const shortAddr = (a) =>
  typeof a === 'string' && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || ''

export const when = (ts) => {
  if (!isNum(ts)) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export const STATUS_GLYPH = {
  good: '▲',
  warning: '◆',
  serious: '▼',
  critical: '▼',
  neutral: '●',
}
