# Cicada-5453 — Playwright e2e smoke tests

These tests exercise the dashboard against the dev-stub bridge. They do
NOT run against a real broker — they verify that the UI flows we
shipped in Stage 1-7 actually work end to end.

## Prerequisites

Three services must be running:

```bash
# Terminal 1: dev-stub bridge (fake MT5 in-process)
PYTHONPATH=. python -m bridge.dev_stub --port 5000

# Terminal 2: backend (uvicorn)
cd python && uvicorn cicada_nn.api:app --host 127.0.0.1 --port 8000

# Terminal 3: frontend (vite)
VITE_NN_API_URL=http://localhost:8000 npm run dev
```

Then in a fourth terminal:

```bash
# First time only — install Playwright browser binaries (~200 MB):
npx playwright install chromium

# Run the suite:
npm run test:e2e

# Or specific spec / debug mode:
npx playwright test e2e/login.spec.ts
npx playwright test --debug
```

## What's tested

| Spec file | What it covers |
|-----------|----------------|
| `login.spec.ts` | Bad-password rejection, sub-1000 account rejection, valid login redirects to dashboard. |
| `dashboard.spec.ts` | MT5 BRIDGE pill, ProcessMonitor latency strip, TradingModes panel, Beehive `/dashboard/map` route. |

The dev-stub deliberately exposes deterministic failure paths
(`password contains 'wrong'/'bad'/'fail'` → reject; `account < 1000` →
reject) so the bad-credential tests are reliable across runs.

## Adding tests

Drop a `*.spec.ts` file in `e2e/`. Use the `dashboard.spec.ts`
`beforeEach` pattern when the test needs an authenticated session.
