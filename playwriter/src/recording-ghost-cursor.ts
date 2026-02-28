/**
 * Encapsulates ghost cursor lifecycle for recording sessions.
 * Keeps onMouseAction chaining/restoration isolated from executor logic.
 *
 * Uses Page.addScriptToEvaluateOnNewDocument so the cursor persists across
 * MPA navigations — Chrome re-runs the init script on every new document.
 */

import type { BrowserContext, Page } from '@xmorse/playwright-core'
import type { ICDPSession } from './cdp-session.js'
import {
  addGhostCursorInitScript,
  applyGhostCursorMouseAction,
  disableGhostCursor,
  enableGhostCursor,
  removeGhostCursorInitScript,
  type GhostCursorClientOptions,
} from './ghost-cursor.js'

interface RecordingGhostCursorLogger {
  error: (...args: unknown[]) => void
}

interface RecordingTargetOptions {
  page?: Page
  sessionId?: string
}

interface InitScriptHandle {
  cdp: ICDPSession
  identifier: string
}

export class RecordingGhostCursorController {
  private readonly previousMouseActionByPage = new WeakMap<Page, Page['onMouseAction']>()
  private readonly cursorApplyQueueByPage = new WeakMap<Page, Promise<void>>()
  private readonly initScriptByPage = new WeakMap<Page, InitScriptHandle>()
  private readonly logger: RecordingGhostCursorLogger

  constructor(options: { logger: RecordingGhostCursorLogger }) {
    this.logger = options.logger
  }

  resolveRecordingTargetPage(options: {
    context: BrowserContext
    defaultPage: Page
    target?: RecordingTargetOptions
  }): Page {
    const { context, defaultPage, target } = options

    if (target?.page) {
      return target.page
    }

    if (target?.sessionId) {
      const pageForSession = context.pages().find((candidatePage) => {
        return candidatePage.sessionId() === target.sessionId
      })

      if (pageForSession) {
        return pageForSession
      }
    }

    return defaultPage
  }

  async enableForRecording(options: { page: Page }): Promise<void> {
    const { page } = options

    try {
      // Register persistent init script so cursor survives MPA navigations
      const handle = await addGhostCursorInitScript({ page })
      this.initScriptByPage.set(page, handle)

      // Also enable on the current page immediately (init script only runs
      // on future navigations, not the current document)
      await enableGhostCursor({ page })

      if (!this.previousMouseActionByPage.has(page)) {
        this.previousMouseActionByPage.set(page, page.onMouseAction)
      }

      const previousMouseAction = this.previousMouseActionByPage.get(page)
      page.onMouseAction = async (event) => {
        const pendingCursorApply = this.cursorApplyQueueByPage.get(page) || Promise.resolve()
        const nextCursorApply = pendingCursorApply
          .then(async () => {
            await applyGhostCursorMouseAction({ page, event })
          })
          .catch((error) => {
            this.logger.error('[playwriter] Failed to apply ghost cursor action', error)
          })
        this.cursorApplyQueueByPage.set(page, nextCursorApply)

        if (!previousMouseAction) {
          return
        }

        await previousMouseAction(event)
      }
    } catch (error) {
      page.onMouseAction = this.previousMouseActionByPage.get(page) ?? null
      this.previousMouseActionByPage.delete(page)
      this.logger.error('[playwriter] Failed to enable ghost cursor', error)
    }
  }

  async disableForRecording(options: { page: Page }): Promise<void> {
    const { page } = options
    page.onMouseAction = this.previousMouseActionByPage.get(page) ?? null
    this.previousMouseActionByPage.delete(page)
    this.cursorApplyQueueByPage.delete(page)

    // Remove the persistent init script so future navigations don't inject cursor
    const handle = this.initScriptByPage.get(page)
    if (handle) {
      try {
        await removeGhostCursorInitScript(handle)
      } catch (error) {
        this.logger.error('[playwriter] Failed to remove ghost cursor init script', error)
      }
      this.initScriptByPage.delete(page)
    }

    try {
      await disableGhostCursor({ page })
    } catch (error) {
      this.logger.error('[playwriter] Failed to disable ghost cursor', error)
    }
  }

  async show(options: { page: Page; cursorOptions?: GhostCursorClientOptions }): Promise<void> {
    const { page, cursorOptions } = options
    await enableGhostCursor({ page, cursorOptions })
  }

  async hide(options: { page: Page }): Promise<void> {
    const { page } = options
    await disableGhostCursor({ page })
  }
}
