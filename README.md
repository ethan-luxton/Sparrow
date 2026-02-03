# PixelTrail AI
Local, tool enabled Telegram assistant with autonomous runtime, workspace support, and strong safety controls.

## Highlights
- Autonomous style workspace docs for voice, behavior, and tool norms
- Autonomous runtime with heartbeat, task queue, and deterministic ticks
- Workspace scoped file access at `~/pixeltrail-projects`
- Expanded git operations with tiered approvals
- Event sourced memory ledger with tamper evident blocks
- Redaction and secret access guards on tools and logs

## Requirements
- Node.js 20 or newer
- Telegram bot token
- OpenAI API key
- `PIXELTRAIL_SECRET` environment variable for encrypting secrets
- Google OAuth credentials if using Drive, Gmail, or Calendar tools

## Quick start
1. Install dependencies
   ```bash
   npm install
   ```
2. Set encryption secret
   ```bash
   export PIXELTRAIL_SECRET="your-strong-passphrase"
   ```
3. Optional environment configuration
   ```bash
   export OPENAI_API_KEY=...
   export TELEGRAM_BOT_TOKEN=...
   export GOOGLE_CLIENT_ID=...
   export GOOGLE_CLIENT_SECRET=...
   export N8N_BASE_URL=...
   export N8N_API_KEY=...
   export N8N_BASIC_USER=...
   export N8N_BASIC_PASS=...
   ```
4. Build and initialize
   ```bash
   npm run build
   npm link
   pt init

   ```
5. Optional Google OAuth
   ```bash
   pt google-auth
   ```
6. Run the bot
   ```bash
   pt run
   ```

## Features
### Workspace system
PixelTrail AI operates inside a dedicated workspace at `~/pixeltrail-projects`. It can create projects, read and write files, search, and apply patches without leaving this root. This keeps edits isolated and auditable.

### Tooling and autonomy
Tools are tiered by risk. The agent proceeds automatically for low risk actions and requests approval for higher impact actions such as commits or pushes. Tool calls and results are logged and redacted.

### Memory ledger
Conversations, tool calls, and derived facts are stored in an append only ledger backed by SQLite. Ledger blocks are chained with hashes to make history tamper evident. Retrieval uses embeddings and always includes citations.

### Git support
Git actions are allowlisted and run inside workspace projects only. Branch defaults to main. Commit, push, pull, merge, and rebase require user approval.

### Security
- Secrets are encrypted with AES 256 GCM using `PIXELTRAIL_SECRET`
- Tool outputs are redacted for common key patterns
- Access to sensitive paths and secret searches are blocked
- Logs are written to `~/.pixeltrail/logs` with rotation

## CLI commands
- `pt init` interactive setup
- `pt run` start the Telegram bot
- `pt run --debug-io` verbose tool logging
- `pt config list|get|set` manage config
- `pt google-auth` OAuth flow for Drive, Gmail, Calendar
- `pt tools list` show available tools
- `pt logs tail` show last log lines
- `pt dashboard --host 0.0.0.0 --port 5527` start the local monitoring dashboard

## Dashboard
The dashboard serves a live local view of system status, tool activity, messages, and log tail.

Run it on the host machine:
```bash
pt dashboard --host 0.0.0.0 --port 5527
```

Then open the printed LAN URL from any device on the same network.

## Configuration
Config is stored at `~/.pixeltrail/config.json`. You can override model selection with:
- `OPENAI_MODEL` for chat
- `OPENAI_CODE_MODEL` for coding operations

## Networking notes
Some Linux setups need IPv4 for Telegram long polling. Use:
- `PIXELTRAIL_TELEGRAM_IPV4_ONLY=1`
- `PIXELTRAIL_TELEGRAM_PROXY_URL=http://user:pass@host:port`
- `PIXELTRAIL_TELEGRAM_POLLING_INTERVAL_MS=1000`
- `PIXELTRAIL_TELEGRAM_POLLING_TIMEOUT_SEC=30`

## Project layout
- `src/agent` runtime, decision loop, playbooks
- `src/lib` configuration, LLM clients, markdown injection, redaction
- `src/tools` tool implementations and tool docs under `src/tools/mds`
- `src/memory` ledger and retrieval

## Contributing
Issues and PRs are welcome. Keep changes scoped, add tests for safety or policy logic, and avoid breaking the tool allowlists.

## License
MIT License. See `LICENSE`.
