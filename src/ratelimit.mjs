// Sim reports its window on every response:
//   x-ratelimit-limit: 60
//   x-ratelimit-remaining: N
//   x-ratelimit-reset: <ISO timestamp>
// and answers 429 with Retry-After: 1, which is wrong — the real reset is the
// timestamp. This limiter keeps calls under the window instead of collecting 429s.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createRateLimiter(log = () => {}) {
  let remaining = null
  let resetAt = 0
  let waiting = null

  const resetIn = () => Math.max(0, resetAt - Date.now())

  async function before() {
    if (remaining === null) return
    if (remaining > 0) {
      remaining--
      return
    }
    if (!waiting) {
      const ms = resetIn() + 300
      log(`rate limit: waiting ${Math.ceil(ms / 1000)}s for the window to reset`)
      waiting = sleep(ms).then(() => {
        waiting = null
        remaining = null
      })
    }
    await waiting
  }

  function note(res, data) {
    const rem = Number(res.headers.get('x-ratelimit-remaining'))
    if (!Number.isNaN(rem)) remaining = rem
    const raw =
      (data && data.error && data.error.details && data.error.details.retryAfter) ||
      res.headers.get('x-ratelimit-reset')
    const at = raw ? Date.parse(raw) : NaN
    if (!Number.isNaN(at)) resetAt = at
  }

  async function waitForReset() {
    const ms = resetIn() + 300
    if (ms > 0) {
      log(`rate limit: waiting ${Math.ceil(ms / 1000)}s for the reset`)
      await sleep(ms)
    }
    remaining = null
  }

  function state() {
    return { remaining, resetAt: resetAt ? new Date(resetAt).toISOString() : null, waitMs: resetIn() }
  }

  return { before, note, waitForReset, state }
}
