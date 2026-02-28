/**
 * Node-side ghost cursor helpers.
 * Injects the browser bundle and forwards mouse action events to the page overlay.
 *
 * Two injection strategies:
 * 1. One-shot: page.evaluate() — used by enableGhostCursor() for single pages
 * 2. Persistent: Page.addScriptToEvaluateOnNewDocument — used by
 *    addGhostCursorInitScript() so the cursor survives MPA navigations.
 *    Chrome re-runs the script on every new document automatically.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page, MouseActionEvent } from '@xmorse/playwright-core'
import { getCDPSessionForPage, type ICDPSession } from './cdp-session.js'

export interface GhostCursorClientOptions {
  style?: 'minimal' | 'dot' | 'screenstudio'
  color?: string
  size?: number
  zIndex?: number
  easing?: string
  minDurationMs?: number
  maxDurationMs?: number
  speedPxPerMs?: number
}

interface GhostCursorBrowserApi {
  enable: (options?: GhostCursorClientOptions) => void
  disable: () => void
  applyMouseAction: (event: MouseActionEvent) => void
  isEnabled: () => boolean
}

let ghostCursorCode: string | null = null

function getGhostCursorCode(): string {
  if (ghostCursorCode) {
    return ghostCursorCode
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  const bundlePath = path.join(currentDir, '..', 'dist', 'ghost-cursor-client.js')
  ghostCursorCode = fs.readFileSync(bundlePath, 'utf-8')
  return ghostCursorCode
}

async function ensureGhostCursorInjected(options: { page: Page }): Promise<void> {
  const { page } = options
  const hasGhostCursor = await page.evaluate(() => {
    return Boolean((globalThis as { __playwriterGhostCursor?: unknown }).__playwriterGhostCursor)
  })

  if (hasGhostCursor) {
    return
  }

  const code = getGhostCursorCode()
  await page.evaluate(code)
}

export async function enableGhostCursor(options: {
  page: Page
  cursorOptions?: GhostCursorClientOptions
}): Promise<void> {
  const { page, cursorOptions } = options
  await ensureGhostCursorInjected({ page })

  await page.evaluate(
    ({ optionsFromNode }) => {
      const api = (globalThis as { __playwriterGhostCursor?: GhostCursorBrowserApi }).__playwriterGhostCursor
      api?.enable(optionsFromNode)
    },
    { optionsFromNode: cursorOptions },
  )
}

export async function disableGhostCursor(options: { page: Page }): Promise<void> {
  const { page } = options
  await page.evaluate(() => {
    const api = (globalThis as { __playwriterGhostCursor?: GhostCursorBrowserApi }).__playwriterGhostCursor
    api?.disable()
  })
}

/**
 * Register the ghost cursor bundle as a persistent init script via CDP
 * Page.addScriptToEvaluateOnNewDocument. Chrome re-runs this on every new
 * document (navigation), so the cursor survives MPA page loads.
 *
 * The script auto-enables when the DOM is ready (DOMContentLoaded or
 * requestAnimationFrame fallback) so the cursor is visible immediately
 * on each new page.
 *
 * Returns the CDP identifier needed to remove it later.
 */
export async function addGhostCursorInitScript(options: {
  page: Page
  cursorOptions?: GhostCursorClientOptions
}): Promise<{ cdp: ICDPSession; identifier: string }> {
  const { page, cursorOptions } = options
  const cdp = await getCDPSessionForPage({ page })
  const code = getGhostCursorCode()

  // Wrap the bundle: inject, then auto-enable once DOM is ready.
  // DOMContentLoaded may have already fired if the script runs late,
  // so check document.readyState first.
  const optionsJson = JSON.stringify(cursorOptions ?? {})
  const wrappedCode = `
${code}
;(function() {
  function autoEnable() {
    var api = globalThis.__playwriterGhostCursor;
    if (api) {
      var opts = ${optionsJson};
      api.enable(Object.keys(opts).length ? opts : undefined);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoEnable, { once: true });
  } else {
    requestAnimationFrame(autoEnable);
  }
})();
`

  const result = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: wrappedCode,
  })

  return { cdp, identifier: result.identifier }
}

/**
 * Remove a previously registered ghost cursor init script.
 */
export async function removeGhostCursorInitScript(options: {
  cdp: ICDPSession
  identifier: string
}): Promise<void> {
  const { cdp, identifier } = options
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
}

export async function applyGhostCursorMouseAction(options: {
  page: Page
  event: MouseActionEvent
}): Promise<void> {
  const { page, event } = options

  await page.evaluate(
    ({ serializedEvent }) => {
      const api = (globalThis as { __playwriterGhostCursor?: GhostCursorBrowserApi }).__playwriterGhostCursor
      if (!api) {
        return
      }

      // Ensure cursor is enabled (may be a freshly injected init script
      // where DOMContentLoaded hasn't fired yet)
      if (!api.isEnabled()) {
        api.enable()
      }
      api.applyMouseAction(serializedEvent)
    },
    { serializedEvent: event },
  )
}
