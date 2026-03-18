/**
 * Playwright browser test: Model Switch UI (/model command).
 *
 * Tests the ModelPicker UI flow:
 *  1. /model command appears in session command palette with Control badge
 *  2. Selecting /model opens the ModelPicker drawer
 *  3. Model cards render correctly (5 options including 1M variants, active state)
 *  4. Selecting a model closes the picker
 *
 * Requires seed data in test-server.ts:
 *  - Task: pw-task-model-switch (in_progress, with session)
 *  - Session: pw-model-switch-session (seeded as running, reconciled to stopped)
 */
import { test, expect } from '@playwright/test'

/**
 * Opens the SessionPanel for the model-switch test task.
 *
 * Flow: home page → "All" tab → find the task row →
 * click the SessionPill on the task row (which opens the SessionPanel inline).
 *
 * The SessionPill is always visible on the task row for tasks with sessions,
 * regardless of whether the TaskDetailPane has finished loading session records.
 */
async function openSessionPanel(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Click "All" category tab to show all tasks (default may be starred)
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
  // Type /m to trigger the command palette
  await input.focus()
  await input.fill('/m')
  await page.waitForTimeout(300)

  // Wait for command palette to appear (scoped to session panel)
  const palette = page.locator('.session-panel .command-palette')
  await expect(palette).toBeVisible({ timeout: 3000 })

  // Find the /model palette item (use control class to avoid matching commands with "model" in description)
  const modelItem = palette.locator('.command-palette-item.command-palette-control', { hasText: 'model' })
  await expect(modelItem).toBeVisible({ timeout: 3000 })
  // Use mousedown (CommandPalette uses onMouseDown, not onClick)
  await modelItem.dispatchEvent('mousedown')
  await page.waitForTimeout(300)

  // Verify ModelPicker is visible
  const modelPicker = page.locator('.session-panel .model-picker')
  await expect(modelPicker).toBeVisible({ timeout: 3000 })

  return modelPicker
}

// ── Tests ──

test.describe('Model Switch UI', () => {
  test('opens ModelPicker via /model command', async ({ page }) => {
    const input = await openSessionPanel(page)

    // Type /m to trigger the command palette
    await input.focus()
    await input.fill('/m')
    await page.waitForTimeout(300)

    // Command palette should appear (scoped to session panel)
    const palette = page.locator('.session-panel .command-palette')
    await expect(palette).toBeVisible({ timeout: 3000 })

    // Verify /model entry exists with correct description (use control class to disambiguate)
    const modelItem = palette.locator('.command-palette-item.command-palette-control', { hasText: 'model' })
    await expect(modelItem).toBeVisible({ timeout: 3000 })
    await expect(modelItem).toContainText('Switch model')
    await expect(modelItem).toContainText('opus / sonnet / haiku')

    // Verify Control badge on /model entry
    const controlBadge = modelItem.locator('.command-palette-source-control')
    await expect(controlBadge).toBeVisible()
    await expect(controlBadge).toHaveText('Control')

    // Click /model to open the picker
    await modelItem.dispatchEvent('mousedown')
    await page.waitForTimeout(300)

    // ModelPicker should be visible
    const modelPicker = page.locator('.session-panel .model-picker')
    await expect(modelPicker).toBeVisible({ timeout: 3000 })

    // Input should be cleared (control command resets input)
    await expect(input).toHaveValue('')
  })

  test('renders model cards correctly', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Should have exactly 5 model options (including 1M variants)
    const options = picker.locator('.model-picker-option')
    await expect(options).toHaveCount(5)

    // Check option labels
    const names = picker.locator('.model-picker-option-name')
    await expect(names.nth(0)).toHaveText('Opus')
    await expect(names.nth(1)).toHaveText('Opus 1M')
    await expect(names.nth(2)).toHaveText('Sonnet')
    await expect(names.nth(3)).toHaveText('Sonnet 1M')
    await expect(names.nth(4)).toHaveText('Haiku')

    // Check option descriptions
    const descs = picker.locator('.model-picker-option-desc')
    await expect(descs.nth(0)).toHaveText('Most capable')
    await expect(descs.nth(1)).toHaveText('1M context window')
    await expect(descs.nth(2)).toHaveText('Balanced')
    await expect(descs.nth(3)).toHaveText('1M context window')
    await expect(descs.nth(4)).toHaveText('Fastest')

    // Opus should be the active model (default)
    const activeOption = picker.locator('.model-picker-option-active')
    await expect(activeOption).toHaveCount(1)
    await expect(activeOption.locator('.model-picker-option-name')).toHaveText('Opus')
    await expect(activeOption.locator('.model-picker-option-badge')).toHaveText('Active')

    // Non-active options should have "Next turn" and "Now" buttons
    // Use filter with "Balanced" description to get only the plain Sonnet (not Sonnet 1M)
    const sonnetOption = picker.locator('.model-picker-option').filter({ hasText: 'Balanced' })
    await expect(sonnetOption.locator('.model-picker-btn')).toBeVisible()
    await expect(sonnetOption.locator('.model-picker-btn')).toHaveText('Next turn')
    await expect(sonnetOption.locator('.model-picker-btn-immediate')).toBeVisible()
    await expect(sonnetOption.locator('.model-picker-btn-immediate')).toHaveText('Now')

    const haikuOption = picker.locator('.model-picker-option').filter({ hasText: 'Haiku' })
    await expect(haikuOption.locator('.model-picker-btn')).toBeVisible()
    await expect(haikuOption.locator('.model-picker-btn-immediate')).toBeVisible()
  })

  test('selecting model closes picker', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Click "Next turn" on the plain Sonnet option (filter by "Balanced" description)
    const sonnetOption = picker.locator('.model-picker-option').filter({ hasText: 'Balanced' })
    await sonnetOption.locator('.model-picker-btn').click()

    // ModelPicker should close
    await expect(picker).toBeHidden({ timeout: 3000 })
  })

  test('shows Control badge styling on /model', async ({ page }) => {
    const input = await openSessionPanel(page)

    // Type /m to show the palette
    await input.focus()
    await input.fill('/m')
    await page.waitForTimeout(300)

    const palette = page.locator('.session-panel .command-palette')
    await expect(palette).toBeVisible({ timeout: 3000 })

    // Find the /model item (use control class to disambiguate)
    const modelItem = palette.locator('.command-palette-item.command-palette-control', { hasText: 'model' })
    await expect(modelItem).toBeVisible()

    // Verify the Control badge element exists with correct class
    const badge = modelItem.locator('.command-palette-source-control')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('Control')

    // Verify the badge has the source-specific class (command-palette-source-control)
    // which applies amber styling
    await expect(badge).toHaveClass(/command-palette-source-control/)
  })
})
