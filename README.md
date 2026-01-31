# Sparrow (local-only Telegram AI agent)

## Requirements
- Node.js 20+
- Telegram bot token
- OpenAI API key (model: gpt-5-mini)
- `SPARROW_SECRET` env var for encrypting secrets
- Google Cloud OAuth credentials (installed app) if using Drive/Gmail

## Setup
1. Install deps:
   ```bash
   npm install
   ```
2. Export encryption secret (any strong passphrase):
   ```bash
   export SPARROW_SECRET="your-long-passphrase"
   ```
3. Optional env-based secrets (avoids prompts):
   ```bash
   export OPENAI_API_KEY=...
   export TELEGRAM_BOT_TOKEN=...
   export GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   export GOOGLE_CLIENT_SECRET=...
   export N8N_BASE_URL=http://localhost:5678
   export N8N_API_KEY=...
   export N8N_BASIC_USER=...
   export N8N_BASIC_PASS=...
   export N8N_BASE_URL=http://localhost:5678
   export N8N_API_KEY=...
   ```
4. Initialize:
   ```bash
   npm run build
   node dist/cli.js init
   ```
   Provide keys if not set via env.
5. Google auth:
   ```bash
   node dist/cli.js google-auth
   ```

## Run the bot
```bash
node dist/cli.js run
```
Bot uses Telegram long polling and persists chat history in `~/.sparrow/sparrow.db`.

### Linux / networking notes
On some Linux setups, IPv6 or proxy settings can prevent Telegram long polling from connecting. Sparrow now supports a few env toggles:
- `SPARROW_TELEGRAM_IPV4_ONLY=1` (default on Linux) forces IPv4 for Telegram requests.
- `SPARROW_TELEGRAM_PROXY_URL=http://user:pass@host:port` to use a proxy.
- `SPARROW_TELEGRAM_POLLING_INTERVAL_MS=1000` to adjust polling interval.
- `SPARROW_TELEGRAM_POLLING_TIMEOUT_SEC=30` to adjust long-poll timeout.

## CLI commands
- `sparrow init` – interactive setup
- `sparrow run` – start Telegram bot
- `sparrow config list|get|set` – manage config
- `sparrow google-auth` – OAuth flow for Drive/Gmail
- `sparrow tools list` – show available tools
- `sparrow logs tail` – show last log lines

## Security notes
- Secrets are encrypted with AES-256-GCM using `SPARROW_SECRET`.
- File tool limited to allowlist (default `~/.sparrow/sandbox`).
- No remote execution or webhooks; Telegram uses long polling only.
- Logging writes to `~/.sparrow/logs` with rotation.
# sparrow
