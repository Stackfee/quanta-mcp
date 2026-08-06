# Quanta MCP server

Track time in [Quanta](https://quanta.is) from Claude, Cursor, or any other MCP
client. Start and stop timers, log work you've already done, and ask where your
hours went, without leaving the conversation.

Requires a paid Quanta plan (Individual or Team).

## Setup

### 1. Create an API key

In Quanta, go to **Settings → API Keys** and create a key. It is shown once, at
creation, so copy it before closing the panel. The key acts as you: it sees
exactly what your account sees and can change exactly what you can change.

### 2. Add the server to Claude Desktop

Open **Settings → Developer → Edit Config**, which opens the config file for
you. Or edit it directly:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

The file may not exist yet. If it does not, create it with exactly this:

```json
{
  "mcpServers": {
    "quanta": {
      "command": "npx",
      "args": ["-y", "quanta-mcp"],
      "env": { "QUANTA_API_KEY": "qta_live_..." }
    }
  }
}
```

If the file already exists, add the `"quanta"` block inside your existing
`"mcpServers"` object rather than replacing the file. It is JSON, so remember
the comma between entries.

Then **quit Claude Desktop completely and reopen it**. MCP servers are only
started at launch, so closing the window or reloading is not enough: use
Cmd+Q on macOS, or quit from the tray on Windows.

To check it worked, ask Claude *"what am I working on?"*. It should answer from
your Quanta timer rather than guessing.

> **If Quanta does not appear, it is almost certainly PATH.**
> Claude Desktop is launched by the operating system, not from your shell, so
> it does not inherit your `PATH`. If you installed Node through nvm, asdf,
> Homebrew or Volta, the bare `npx` above will not resolve and the server
> silently fails to start.
>
> Fix it by using the full path. Run `which npx` in a terminal, then use what
> it prints:
>
> ```json
> "command": "/Users/you/.nvm/versions/node/v22.21.1/bin/npx",
> "args": ["-y", "quanta-mcp"]
> ```
>
> Claude Desktop writes logs to `~/Library/Logs/Claude/` on macOS if you need
> to see the actual error.

### 3. Other clients

**Claude Code** runs from your shell, so `npx` resolves normally:

```bash
claude mcp add quanta --env QUANTA_API_KEY=qta_live_... -- npx -y quanta-mcp
```

**Cursor and other MCP clients** take the same shape as the Claude Desktop
config above: command `npx`, args `["-y", "quanta-mcp"]`, and `QUANTA_API_KEY`
in the environment.

<details>
<summary>Running from source instead</summary>

```bash
git clone git@github.com:Stackfee/quanta-mcp.git
cd quanta-mcp
npm install
npm run build          # produces dist/index.js
```

Then point the client at the built file rather than at npx:

```bash
claude mcp add quanta --env QUANTA_API_KEY=qta_live_... -- node /absolute/path/to/quanta-mcp/dist/index.js
```

</details>

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `QUANTA_API_KEY` | yes | — | From Settings → API Keys |
| `QUANTA_API_URL` | no | `https://api.quanta.is` | Point at another environment for testing |

## Tools

| Tool | What it does |
| --- | --- |
| `get_current_timer` | Whether a timer is running, and what it's tracking |
| `start_timer` | Starts a timer, stopping any already-running one first |
| `stop_timer` | Stops the running timer and saves the entry |
| `log_time` | Logs a completed block of time you specify in minutes |
| `list_projects` | Projects you can log against, with ids and tasks |
| `list_time_entries` | Recent entries, optionally within a date range |
| `list_clients` | Clients in the workspace |
| `get_time_report` | Grouped totals by client, project, user or task, with billable amounts |

### Things worth knowing

**Reports need a permission.** `get_time_report` is the one tool that checks
one. A key carries its creator's permissions, so if that person cannot open
the summary report in Quanta, the tool is refused and says which permission
is missing. Everything else only touches your own time.

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
new one. If a key leaks, revoke it in **Settings → API Keys**; anything
using it stops working immediately.

Keys carry your permissions, not more. A key created by someone who can't see
billing still can't see billing.
