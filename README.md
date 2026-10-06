# BuzzIn

BuzzIn is a realtime online buzzer system based on the classic pre-2026 BuzzIn.live interface. It keeps the simple Bootstrap-era layout, large circular player buzzer, host controls, and old-style settings while using a server-authoritative WebSocket room.

## Development

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install
pnpm run dev
```

Open `http://localhost:5173/buzzin/`. The Vite server proxies `/api/ws` to the local WebSocket server on port 8787.

Useful commands:

```bash
pnpm run typecheck
pnpm run test
pnpm run test:e2e
pnpm run build
```

The first Playwright run may need `pnpm exec playwright install chromium`.

## Environment variables

`VITE_BUZZIN_WS_URL` optionally sets the full `ws://` or `wss://` endpoint used by browsers. If it is empty, local development uses the Vite proxy and the production app uses its deployed WebSocket endpoint.

`ALLOWED_ORIGINS` is an optional comma-separated list used by the WebSocket server for origin validation. The default allows localhost, `rangan.xyz`, `www.rangan.xyz`, and Vercel deployment hosts.

## Architecture

- React + TypeScript + Vite frontend under `src/`.
- Node `ws` WebSocket room server shared by local development and the Vercel function at `api/ws.ts`.
- `server/room.ts` is the authoritative room state owner. Buzzes are accepted synchronously on the server, so simultaneous messages are processed in one deterministic order.
- Host and player sessions use opaque random tokens. The six-digit room code never grants host permissions.
- Room data is held in the active WebSocket function instance and expires after six hours without useful activity. The client reconnects with exponential backoff and rehydrates the same player session.

## Rulesets

Prelim Rules expose `-1` and `+1` score controls. Playoff Rules expose `-2`, `-1`, `+3`, `+4`, `+5`, `+6`, and `+1`. New rooms enable One Buzz Only by default; Clear Buzzers removes the automatic lock without changing manual lock, scores, players, teams, or settings.

## Production deployment

The app is configured for `/buzzin/` with `vercel.json`. The Vercel project serves the Vite bundle and the WebSocket function together. Vercel WebSocket connections are expected to reconnect when a function reaches its platform duration; stateful rooms should use an external shared store before scaling across multiple function instances.

Production environment variables should include `VITE_BUZZIN_WS_URL=wss://<buzzin-vercel-host>/api/ws` and an explicit `ALLOWED_ORIGINS` list. No host or player secrets are committed.

## Tests

The unit tests cover room creation, six-digit codes, default settings, one-buzz atomicity, score validation, authorization, and reconnect identity. The Playwright suite covers the old-style home/join flow and a live host/player Playoff round through the local WebSocket server.
