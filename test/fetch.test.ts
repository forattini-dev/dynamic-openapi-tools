import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchWithRetry } from '../src/utils/fetch.js'

const mockFetch = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('fetchWithRetry', () => {
  it('returns response on successful fetch', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await fetchWithRetry('https://api.test.com')
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it('retries on retryable status codes', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('', { status: 503, headers: {} }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await fetchWithRetry('https://api.test.com', undefined, {
      retries: 2,
      retryDelay: 10,
      retryOn: [503],
    })

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('returns last response after exhausting retries on retryable status', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))

    const res = await fetchWithRetry('https://api.test.com', undefined, {
      retries: 1,
      retryDelay: 10,
      retryOn: [503],
    })

    // After exhausting retries, returns the last response
    expect(res.status).toBe(503)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('retries on fetch errors', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network failed'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await fetchWithRetry('https://api.test.com', undefined, {
      retries: 2,
      retryDelay: 10,
    })

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry mutating requests by default', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await fetchWithRetry('https://api.test.com', { method: 'POST' }, {
      retries: 2,
      retryDelay: 10,
      retryOn: [503],
    })

    expect(res.status).toBe(503)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('retries mutating requests when retryPolicy is all', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await fetchWithRetry('https://api.test.com', { method: 'POST' }, {
      retries: 2,
      retryDelay: 10,
      retryOn: [503],
      retryPolicy: 'all',
    })

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('throws after all retries exhausted on errors', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))

    await expect(
      fetchWithRetry('https://api.test.com', undefined, {
        retries: 1,
        retryDelay: 10,
      })
    ).rejects.toThrow('fail 2')
  })

  it('respects Retry-After header (seconds)', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': '1' } })
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await fetchWithRetry('https://api.test.com', undefined, {
      retries: 2,
      retryDelay: 10,
      retryOn: [429],
    })

    expect(res.status).toBe(200)
  })

  it('handles non-numeric Retry-After (date)', async () => {
    const futureDate = new Date(Date.now() + 2000).toUTCString()
    mockFetch
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': futureDate } })
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await fetchWithRetry('https://api.test.com', undefined, {
      retries: 2,
      retryDelay: 10,
      retryOn: [429],
    })

    expect(res.status).toBe(200)
  })

  it('handles invalid Retry-After value', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': 'invalid-value' } })
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await fetchWithRetry('https://api.test.com', undefined, {
      retries: 2,
      retryDelay: 10,
      retryOn: [429],
    })

    expect(res.status).toBe(200)
  })

  it('passes request init options', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok'))

    await fetchWithRetry('https://api.test.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"test":true}',
    })

    const [, init] = mockFetch.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"test":true}')
  })

  it('handles AbortError with timeout message', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    mockFetch
      .mockRejectedValueOnce(abortError)
      .mockRejectedValueOnce(abortError)

    await expect(
      fetchWithRetry('https://api.test.com', undefined, {
        retries: 1,
        retryDelay: 10,
        timeout: 5000,
      })
    ).rejects.toThrow('timed out')
  })

  it('does not retry when retryPolicy is none', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network failed'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    await expect(
      fetchWithRetry('https://api.test.com', undefined, {
        retries: 2,
        retryDelay: 10,
        retryPolicy: 'none',
      })
    ).rejects.toThrow('Network failed')

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
