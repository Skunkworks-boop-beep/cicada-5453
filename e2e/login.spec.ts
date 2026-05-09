/**
 * Login flow smoke test against the dev-stub bridge.
 *
 * Pre-conditions: bridge/dev_stub.py on :5000, uvicorn cicada_nn.api on
 * :8000, vite dev on :5173. The dev-stub rejects logins with password
 * containing 'wrong' / 'bad' / 'fail' or login below 1000 — so we can
 * exercise both the success and failure paths deterministically.
 */

import { test, expect } from '@playwright/test';

test.describe('Login', () => {
  test('rejects login with explicit bad-password marker', async ({ page }) => {
    await page.goto('/');

    // Wait for the form to be present.
    await expect(page.getByPlaceholder('MT5 account number...')).toBeVisible();

    await page.getByPlaceholder('MT5 account number...').fill('99999');
    await page.getByPlaceholder('enter_cipher_key...').fill('wrong');
    await page.getByPlaceholder('Broker-Server or leave empty').fill('DemoServer');

    await page.getByRole('button', { name: /INITIATE SECURE ACCESS/ }).click();

    // The form stays on the login page and shows an error containing
    // either "Invalid credentials" (from the stub's last_error) or the
    // generic "MT5 connection failed" fallback.
    await expect(page).toHaveURL(/.*\/?$/, { timeout: 5000 });
    const errorBox = page.locator('text=/Invalid|failed|rejected/i').first();
    await expect(errorBox).toBeVisible({ timeout: 5000 });
  });

  test('rejects login with sub-1000 account number', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('MT5 account number...').fill('42');
    await page.getByPlaceholder('enter_cipher_key...').fill('anything');
    await page.getByRole('button', { name: /INITIATE SECURE ACCESS/ }).click();
    await expect(page.locator('text=/Invalid|below|stub minimum/i').first()).toBeVisible({ timeout: 5000 });
  });

  test('valid credentials enter the dashboard', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('MT5 account number...').fill('99999');
    await page.getByPlaceholder('enter_cipher_key...').fill('secret');
    await page.getByPlaceholder('Broker-Server or leave empty').fill('DemoServer');

    await page.getByRole('button', { name: /INITIATE SECURE ACCESS/ }).click();

    // After a successful login, the app navigates to /dashboard.
    await page.waitForURL('**/dashboard', { timeout: 5000 });

    // The dashboard's header shows the LIVE/DISCONNECTED pill.
    await expect(page.locator('text=/LIVE|DISCONNECTED/').first()).toBeVisible();
  });
});
