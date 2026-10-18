/**
 * "4 min ago" for the notebook list. Deliberately coarse: a classroom cares
 * whether a notebook was touched today or last week, not about seconds.
 */
export function timeAgo(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return ''
  const secs = Math.max(0, Math.round((now - ts) / 1000))
  if (secs < 45) return 'just now'

  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min ago`

  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`

  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`

  return new Date(ts).toLocaleDateString()
}
