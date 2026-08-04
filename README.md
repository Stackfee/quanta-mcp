# Quanta MCP server

Track time in [Quanta](https://quanta.is) from Claude, Cursor, or any other MCP
client. Start and stop timers, log work you've already done, and ask where your
hours went, without leaving the conversation.

Requires a paid Quanta plan (Individual or Team).

## Setup

### 1. Create an API key

In Quanta, go to **Administration → API Keys** and create a key. It's shown
once, so copy it before closing the panel. The key acts as you: it can see and
change exactly what your own account can.

### 2. Build it

> **Not on npm yet.** `@quanta/mcp-server` is unpublished, so `npx -y @quanta/mcp-server`
> will not work. Clone this repository and build it, then point your client at
> the built file. The npm instructions below are what will apply once it ships.

```bash
git clone git@github.com:Stackfee/quanta-mcp.git
cd quanta-mcp
npm install
npm run build          # produces dist/index.js
```

### 3. Point your MCP client at the server

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "quanta": {
      "command": "node",
      "args": ["/absolute/path/to/quanta-mcp/dist/index.js"],
      "env": {
        "QUANTA_API_KEY": "qta_live_..."
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add quanta --env QUANTA_API_KEY=qta_live_... -- node /absolute/path/to/quanta-mcp/dist/index.js
```

Restart the client. You should see the Quanta tools available.

<details>
<summary>Once published to npm</summary>

```json
{
  "mcpServers": {
    "quanta": {
      "command": "npx",
      "args": ["-y", "@quanta/mcp-server"],
      "env": { "QUANTA_API_KEY": "qta_live_..." }
    }
  }
}
```

```bash
claude mcp add quanta --env QUANTA_API_KEY=qta_live_... -- npx -y @quanta/mcp-server
```

</details>

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `QUANTA_API_KEY` | yes | — | From Administration → API Keys |
| `QUANTA_API_URL` | no | `https://api.quanta.is` | Point at another environment for testing |

## Tools

| Tool | What it does |
| --- | --- |
| `get_current_timer` | Whether a timer is running, and what it's tracking |
| `start_timer` | Starts a timer, stopping any already-running one first |
| `stop_timer` | Stops the running timer and saves the entry |
| `log_time` | Logs a completed block of time you specify in minutes |
| `log_time_from_text` | Logs time from plain English, using Quanta's AI to work out project, duration and start time |
| `list_projects` | Projects you can log against, with ids and tasks |
| `list_time_entries` | Recent entries, optionally within a date range |
| `list_clients` | Clients in the workspace |

### Things worth knowing

**`log_time_from_text` previews by default.** The first call parses the text and
shows what it would log without saving. Calling again with `confirm: true`
saves it. Each call uses one AI credit.

**Timers are exclusive.** Starting a timer stops whatever was already running,
matching how the web and desktop apps behave.

**Entries are attributed to you, and marked as API-created.** Anything the
assistant logs appears under your name, with its source recorded as `Api` so you
can tell it apart from web and desktop entries in the detailed report and Excel
export.

## Examples

> "Start a timer on the Northwind portal, I'm doing the checkout flow."

> "Stop the timer."

> "I spent about three hours this morning on the Acme migration. Log it."

> "What did I work on yesterday, and how much of it was billable?"

## Development

```bash
npm install
npm run build          # tsc -> dist/
npm run dev            # tsc --watch

QUANTA_API_KEY=qta_live_... QUANTA_API_URL=https://localhost:44301 node dist/index.js
```

The server talks only to Quanta's public `/api/v1` surface, the same one
documented at [api.quanta.is/docs](https://api.quanta.is/docs). If a tool needs
data the public API doesn't expose yet, the API is what needs extending.

## Security

Keys are stored hashed. Quanta can't show you an existing key again, only mint a
new one. If a key leaks, revoke it in **Administration → API Keys**; anything
using it stops working immediately.

Keys carry your permissions, not more. A key created by someone who can't see
billing still can't see billing.
