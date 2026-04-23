import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface LoopbackCallback {
  code?: string
  state?: string
  error?: string
  errorDescription?: string
}

export interface CaptureOptions {
  port: number
  host?: string
  path?: string
  timeoutMs?: number
  successBody?: string
  errorBody?: string
}

/**
 * Listen on `host:port` and wait for the OAuth2 redirect. Resolves once a
 * request hits `path` with either a `code` or an `error` query param, or
 * rejects on timeout. The server always closes itself before returning.
 */
export function captureCallback(options: CaptureOptions): Promise<LoopbackCallback> {
  const host = options.host ?? '127.0.0.1'
  const callbackPath = options.path ?? '/callback'
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
  const successBody =
    options.successBody ??
    '<html><body><h1>Login complete</h1><p>You can close this tab and return to your terminal.</p></body></html>'
  const errorBody =
    options.errorBody ??
    '<html><body><h1>Login failed</h1><p>See your terminal for details.</p></body></html>'

  return new Promise<LoopbackCallback>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${host}:${options.port}`)
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
        return
      }

      const params = url.searchParams
      const code = params.get('code') ?? undefined
      const state = params.get('state') ?? undefined
      const error = params.get('error') ?? undefined
      const errorDescription = params.get('error_description') ?? undefined

      if (error) {
        res.writeHead(400, {
          'Content-Type': 'text/html; charset=utf-8',
          Connection: 'close',
        })
        res.end(errorBody)
      } else {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          Connection: 'close',
        })
        res.end(successBody)
      }

      clearTimeout(timeout)
      const result: LoopbackCallback = {}
      if (code !== undefined) result.code = code
      if (state !== undefined) result.state = state
      if (error !== undefined) result.error = error
      if (errorDescription !== undefined) result.errorDescription = errorDescription
      // Close idle keep-alive sockets so the server shuts down promptly.
      server.closeAllConnections?.()
      server.close(() => resolve(result))
    })

    const timeout = setTimeout(() => {
      server.close(() => reject(new Error(`OAuth2 callback timed out after ${timeoutMs}ms`)))
    }, timeoutMs)

    server.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    server.listen(options.port, host)
  })
}
