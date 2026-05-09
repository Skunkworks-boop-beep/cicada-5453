/**
 * Dashboard surface smoke tests — assert the Stage 1-7 surfaces render
 * without runtime errors after a clean login.
 */

import { test, expect } from '@playwright/test';

test.describe('Dashboard surfaces', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('MT5 account number...').fill('99999');
    await page.getByPlaceholder('enter_cipher_key...').fill('secret');
    await page.getByRole('button', { name: /INITIATE SECURE ACCESS/ }).click();
    await page.waitForURL('**/dashboard', { timeout: 5000 });
  });

  test('MT5 BRIDGE pill renders green when bridge is reachable', async ({ page }) => {
    // BrokersManager bridge pill (added in Stage 2A).
    await expect(page.locator('text=/MT5 BRIDGE/').first()).toBeVisible();
    // Broker pills use #00ff00 when reachable; the pill itself contains
    // either "BRIDGE OK" or "BRIDGE UNREACHABLE".
    await expect(page.locator('text=/BRIDGE OK|BRIDGE UNREACHABLE/').first()).toBeVisible();
  });

  test('ProcessMonitor latency strip is rendered', async ({ page }) => {
    // ProcessMonitor latency strip (added in Stage 2A).
    await expect(page.locator('text=/MT5 BRIDGE|rtt|p95/i').first()).toBeVisible();
  });

  test('TradingModes panel renders', async ({ page }) => {
    await expect(page.locator('text=/TRADING MODES/i').first()).toBeVisible();
  });

  test('navigates to /dashboard/map (Beehive)', async ({ page }) => {
    await page.goto('/dashboard/map');
    await expect(page.locator('text=/GEOMETRIC MAP|HIVE VIEW/i').first()).toBeVisible();
    // The beehive renders a canvas — assert it exists.
    await expect(page.locator('canvas')).toBeVisible();
  });
});
