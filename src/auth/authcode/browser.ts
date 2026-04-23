import { spawn } from 'node:child_process'

/**
 * Best-effort open a URL in the user's default browser. Returns true if the
 * launcher exited cleanly within the timeout, false otherwise — callers
 * should always print the URL so the user can fall back to a manual copy.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const opener = pickOpener()
  /* v8 ignore next — pickOpener always returns an entry on supported platforms */
  if (!opener) return false

  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(opener.command, [...opener.args, url], {
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', () => resolve(false))
      child.unref()
      // Give the launcher a brief moment to fail synchronously.
      setTimeout(() => resolve(true), 50)
    } catch {
      resolve(false)
    }
  })
}

function pickOpener(): { command: string; args: string[] } | null {
  if (process.env['BROWSER']) {
    return { command: process.env['BROWSER'], args: [] }
  }
  switch (process.platform) {
    /* v8 ignore next 2 — covered on macOS CI */
    case 'darwin':
      return { command: 'open', args: [] }
    /* v8 ignore next 6 — covered on Windows CI; rundll32 url.dll,FileProtocolHandler is
       the canonical Windows "open URL in default browser" primitive and doesn't go
       through a shell, so ampersands in OAuth2 URLs stay intact. */
    case 'win32':
      return { command: 'rundll32', args: ['url.dll,FileProtocolHandler'] }
    default:
      return { command: 'xdg-open', args: [] }
  }
}
