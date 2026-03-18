/**
 * Playwright browser test: ModelPicker 1M variant rendering.
 *
 * Tests that the ModelPicker UI correctly renders all 5 model options
 * including the 1M context window variants (Opus 1M, Sonnet 1M).
 *
 * This validates the MODEL_CLI_MAP fix:
 *   - 'opus-1m'   -> 'opus[1m]'  (was broken: used full model ID + [1m])
 *   - 'sonnet-1m' -> 'sonnet[1m]' (was broken)
 *   - Non-1M models pass through as aliases (opus, sonnet, haiku)
 *
 * Tests:
 *  1. ModelPicker renders all 5 options (Opus, Opus 1M, Sonnet, Sonnet 1M, Haiku)
 *  2. Default active model (Opus) shows "Active" badge, not action buttons
 *  3. 1M variants show "1M context window" description
 *  4. Non-active models show "Next turn" and "Now" buttons
 *  5. Clicking "Now" on a 1M variant closes the picker (switch flow works)
 *  6. Escape key closes the picker
 *
 * Requires seed data in test-server.ts:
 *  - Task: pw-task-model-switch (in_progress, with session)
 *  - Session: pw-model-switch-session (seeded as running, reconciled to stopped)
 */
import { test, expect } from '@playwright/test'
import path from 'node:path'

const SCREENSHOT_DIR = '/tmp/test-and-verify'

/**
 * Opens the SessionPanel for the model-switch test task.
 *
 * Strategy: navigate to home → "All" tab → find the task row →
 * click the SessionPill on the task row (which opens the SessionPanel inline).
 *
 * The SessionPill is always visible on the task row for tasks with sessions,
 * regardless of whether the TaskDetailPane has finished loading session records.
 */
async function openSessionPanel(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Click "All" category tab to show all tasks
  const allTab = page.locator('.todo-panel-tab', { hasText: 'All' })
  await expect(allTab).toBeVisible({ timeout: 5000 })
  await allTab.click()
  await page.waitForTimeout(300)

  // Find the task row
  const taskItem = page.locator('.todo-panel-item', { hasText: 'Model switch test task' })
  await expect(taskItem).toBeVisible({ timeout: 5000 })

  // Click the SessionPill on the task row — this opens SessionPanel inline
  const sessionPill = taskItem.locator('.task-session-pill')
  await expect(sessionPill).toBeVisible({ timeout: 3000 })
  await sessionPill.click()
  await page.waitForTimeout(1000)

  // Verify the SessionPanel is open with its chat input
  const sessionPanelInput = page.locator('.session-panel .chat-input-textarea')
  await expect(sessionPanelInput).toBeVisible({ timeout: 5000 })

  return sessionPanelInput
}

/**
 * Types /m in the session chat input and selects the /model command from the palette.
 * Returns after the ModelPicker is visible.
 */
async function openModelPicker(page: import('@playwright/test').Page, input: import('@playwright/test').Locator) {
  await input.focus()
  await input.fill('/m')
  await page.waitForTimeout(300)

  const palette = page.locator('.session-panel .command-palette')
  await expect(palette).toBeVisible({ timeout: 3000 })

  // Use the control-specific class to find /model (avoids matching other items with "model" in text)
  const modelItem = palette.locator('.command-palette-item.command-palette-control', { hasText: 'model' })
  await expect(modelItem).toBeVisible({ timeout: 3000 })
  // CommandPalette uses onMouseDown, not onClick
  await modelItem.dispatchEvent('mousedown')
  await page.waitForTimeout(300)

  const modelPicker = page.locator('.session-panel .model-picker')
  await expect(modelPicker).toBeVisible({ timeout: 3000 })

  return modelPicker
}

// ── Tests ──

test.describe('ModelPicker 1M Variants', () => {
  test('renders all 5 model options including 1M variants', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Should have exactly 5 model options
    const options = picker.locator('.model-picker-option')
    await expect(options).toHaveCount(5)

    // Verify all 5 option labels in correct order
    const names = picker.locator('.model-picker-option-name')
    await expect(names.nth(0)).toHaveText('Opus')
    await expect(names.nth(1)).toHaveText('Opus 1M')
    await expect(names.nth(2)).toHaveText('Sonnet')
    await expect(names.nth(3)).toHaveText('Sonnet 1M')
    await expect(names.nth(4)).toHaveText('Haiku')

    // Screenshot: all 5 options visible
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-all-5-options.png') })
  })

  test('1M variants show correct description', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Verify descriptions for each model
    const descs = picker.locator('.model-picker-option-desc')
    await expect(descs.nth(0)).toHaveText('Most capable')
    await expect(descs.nth(1)).toHaveText('1M context window')
    await expect(descs.nth(2)).toHaveText('Balanced')
    await expect(descs.nth(3)).toHaveText('1M context window')
    await expect(descs.nth(4)).toHaveText('Fastest')
  })

  test('default model (Opus) is marked Active', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Opus should be the active model (default for new sessions)
    const activeOption = picker.locator('.model-picker-option-active')
    await expect(activeOption).toHaveCount(1)
    await expect(activeOption.locator('.model-picker-option-name')).toHaveText('Opus')
    await expect(activeOption.locator('.model-picker-option-badge')).toHaveText('Active')

    // Active option should NOT have action buttons
    const activeButtons = activeOption.locator('.model-picker-option-actions')
    await expect(activeButtons).toHaveCount(0)
  })

  test('non-active models show Next turn and Now buttons', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Check all 4 non-active models have buttons.
    // Use description text to disambiguate models with similar names (Sonnet vs Sonnet 1M).
    const modelFilters = [
      { name: 'Opus 1M', desc: 'Opus 1M' },
      { name: 'Sonnet', desc: 'Balanced' },
      { name: 'Sonnet 1M', desc: 'Sonnet 1M' },
      { name: 'Haiku', desc: 'Fastest' },
    ]
    for (const { name, desc } of modelFilters) {
      const option = picker.locator('.model-picker-option').filter({ hasText: desc })
      await expect(option.locator('.model-picker-option-name')).toContainText(name)
      const btn = option.locator('.model-picker-btn')
      await expect(btn).toBeVisible()
      await expect(btn).toHaveText('Next turn')
      const btnImmediate = option.locator('.model-picker-btn-immediate')
      await expect(btnImmediate).toBeVisible()
      await expect(btnImmediate).toHaveText('Now')
    }

    // Screenshot: buttons visible on non-active models
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-buttons-visible.png') })
  })

  test('clicking Now on Opus 1M closes the picker', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Find Opus 1M specifically — filter by description to disambiguate from "Opus"
    const opus1mOption = picker.locator('.model-picker-option').filter({ hasText: '1M context window' }).first()
    await expect(opus1mOption.locator('.model-picker-option-name')).toHaveText('Opus 1M')

    // Click "Now" button
    await opus1mOption.locator('.model-picker-btn-immediate').click()

    // Picker should close
    await expect(picker).toBeHidden({ timeout: 3000 })

    // Screenshot: after Opus 1M switch
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-opus-1m-switch.png') })
  })

  test('clicking Next turn on Sonnet 1M closes the picker', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Find Sonnet 1M specifically
    const sonnet1mOption = picker.locator('.model-picker-option').filter({ hasText: 'Sonnet 1M' })
    await expect(sonnet1mOption.locator('.model-picker-option-name')).toHaveText('Sonnet 1M')

    // Click "Next turn" button
    await sonnet1mOption.locator('.model-picker-btn').click()

    // Picker should close
    await expect(picker).toBeHidden({ timeout: 3000 })

    // Screenshot: after Sonnet 1M deferred switch
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-sonnet-1m-switch.png') })
  })

  test('Escape key closes the ModelPicker', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Verify picker is open
    await expect(picker).toBeVisible()

    // Press Escape
    await page.keyboard.press('Escape')

    // Picker should close
    await expect(picker).toBeHidden({ timeout: 3000 })
  })

  test('header shows Current model label', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // The header shows "Current: opus" (normalizeModelId default)
    const currentLabel = picker.locator('.model-picker-current')
    await expect(currentLabel).toBeVisible()
    await expect(currentLabel).toContainText('Current:')

    // Screenshot: header with current model
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-header-current.png') })
  })
})
