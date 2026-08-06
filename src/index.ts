#!/usr/bin/env node
/**
 * Quanta MCP server.
 *
 * Exposes time tracking as MCP tools so an assistant can start and stop timers,
 * log work, and answer questions about where the time went. Talks only to the
 * public /api/v1 surface, authenticated with a Quanta API key.
 *
 * Configuration (environment):
 *   QUANTA_API_KEY   required, from Settings -> API keys
 *   QUANTA_API_URL   optional, defaults to https://api.quanta.is
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  QuantaApiError,
  QuantaClient,
  type ReportGroupBy,
  describeEntry,
  formatDuration,
} from "./client.js";

const apiKey = process.env.QUANTA_API_KEY;
const baseUrl = process.env.QUANTA_API_URL ?? "https://api.quanta.is";

if (!apiKey) {
  console.error(
    "QUANTA_API_KEY is not set. Create a key in Quanta under Settings -> API keys, " +
      "then add it to your MCP client configuration.",
  );
  process.exit(1);
}

const quanta = new QuantaClient(baseUrl, apiKey);

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

/** Turns API failures into a readable tool result rather than a protocol error. */
async function guard<T>(fn: () => Promise<T>): Promise<T | { content: { type: "text"; text: string }[] }> {
  try {
    return await fn();
  } catch (error) {
    const message =
      error instanceof QuantaApiError
        ? error.message
        : `Couldn't reach Quanta: ${(error as Error).message}`;
    return text(message);
  }
}

const server = new McpServer({
  name: "quanta",
  version: "0.1.0",
});

// ── Timer ──────────────────────────────────────────────────────────────────

server.tool(
  "get_current_timer",
  "Check whether a Quanta timer is currently running, and what it's tracking.",
  {},
  async () =>
    guard(async () => {
      const entry = await quanta.getCurrentTimer();
      if (!entry) return text("No timer is running.");
      const since = entry.startedAt ? ` since ${new Date(entry.startedAt).toLocaleTimeString()}` : "";
      return text(`Running: ${describeEntry(entry)}${since}.`);
    }),
);

server.tool(
  "start_timer",
  "Start a Quanta timer. Any timer already running is stopped first. " +
    "Use list_projects to find a projectId when the user names a project.",
  {
    description: z.string().optional().describe("What the user is working on"),
    projectId: z.number().int().optional().describe("Project to log against"),
    taskId: z.number().int().optional().describe("Task within the project"),
  },
  async (args) =>
    guard(async () => {
      const entry = await quanta.startTimer(args);
      if (!entry) return text("Timer started.");
      return text(`Started: ${describeEntry(entry)}.`);
    }),
);

server.tool(
  "stop_timer",
  "Stop the running Quanta timer and save the entry.",
  {},
  async () =>
    guard(async () => {
      const entry = await quanta.stopTimer();
      if (!entry) return text("No timer was running.");
      return text(
        `Stopped: ${entry.description || "(no description)"} — ${formatDuration(entry.durationSeconds)} logged.`,
      );
    }),
);

// ── Logging time ───────────────────────────────────────────────────────────

server.tool(
  "log_time",
  "Log a completed block of time to Quanta. Use when the user says how long they " +
    "worked on something, e.g. '2 hours on the checkout flow'.",
  {
    description: z.string().describe("What the work was"),
    minutes: z.number().positive().describe("How long, in minutes"),
    projectId: z.number().int().optional().describe("Project to log against"),
    taskId: z.number().int().optional(),
    startedAt: z
      .string()
      .optional()
      .describe("ISO 8601 start time; defaults to now minus the duration"),
  },
  async ({ description, minutes, projectId, taskId, startedAt }) =>
    guard(async () => {
      const durationSeconds = Math.round(minutes * 60);
      const start =
        startedAt ?? new Date(Date.now() - durationSeconds * 1000).toISOString();

      const entry = await quanta.createTimeEntry({
        description,
        durationSeconds,
        startedAt: start,
        projectId,
        taskId,
      });

      if (!entry) return text("Time logged.");
      return text(`Logged ${formatDuration(entry.durationSeconds)}: ${describeEntry(entry)}.`);
    }),
);

server.tool(
  "list_projects",
  "List the projects the user can log time against, with their ids and tasks.",
  {},
  async () =>
    guard(async () => {
      const projects = await quanta.listProjects();
      if (!projects?.length) return text("No projects found in this workspace.");

      const lines = projects.map((p) => {
        const client = p.client?.name ? ` (${p.client.name})` : "";
        const tasks = p.tasks.length
          ? `\n    tasks: ${p.tasks.map((t) => `${t.name} [${t.id}]`).join(", ")}`
          : "";
        return `  ${p.name}${client} — id ${p.id}${tasks}`;
      });

      return text(`Projects:\n${lines.join("\n")}`);
    }),
);

server.tool(
  "list_time_entries",
  "List recent time entries, optionally within a date range. Use to answer " +
    "questions like 'what did I work on yesterday' or 'how much time went to X'.",
  {
    from: z.string().optional().describe("ISO 8601 start of range"),
    to: z.string().optional().describe("ISO 8601 end of range"),
    limit: z.number().int().min(1).max(200).optional().describe("Max entries (default 20)"),
  },
  async ({ from, to, limit }) =>
    guard(async () => {
      const page = await quanta.listTimeEntries({ from, to, take: limit ?? 20 });
      if (!page?.data.length) return text("No time entries in that range.");

      const total = page.data.reduce((sum, e) => sum + e.durationSeconds, 0);
      const lines = page.data.map((e) => {
        const when = e.startedAt ? new Date(e.startedAt).toLocaleString() : "unknown time";
        return `  ${when} — ${describeEntry(e)}`;
      });

      return text(
        `${page.data.length} of ${page.totalCount} entries, ${formatDuration(total)} total:\n${lines.join("\n")}`,
      );
    }),
);

server.tool(
  "list_clients",
  "List the clients in the workspace.",
  {},
  async () =>
    guard(async () => {
      const clients = await quanta.listClients();
      if (!clients?.length) return text("No clients found.");
      return text(`Clients:\n${clients.map((c) => `  ${c.name} — id ${c.id}`).join("\n")}`);
    }),
);

server.tool(
  "get_time_report",
  "Grouped time totals for a date range: hours per client, project, user or " +
    "task, with billable amounts when the workspace tracks rates. Use for " +
    "questions like 'how many hours did we bill Acme last month' or 'where did " +
    "this quarter go'. Needs a date range; reports cover at most 366 days.",
  {
    from: z.string().describe("First day to include, inclusive, as YYYY-MM-DD"),
    to: z.string().describe("Last day to include, inclusive, as YYYY-MM-DD"),
    groupBy: z
      .enum(["client", "project", "user", "task"])
      .optional()
      .describe("How to group the totals. Defaults to client."),
    billableOnly: z
      .boolean()
      .optional()
      .describe("Only count billable time. Omit to count everything."),
  },
  async ({ from, to, groupBy, billableOnly }) =>
    guard(async () => {
      const report = await quanta.summaryReport((groupBy ?? "client") as ReportGroupBy, {
        from,
        to,
        billable: billableOnly === true ? true : undefined,
      });

      if (!report?.groups?.length) {
        return text(`No time logged between ${from} and ${to}.`);
      }

      const money = (amount: number | null, currency: string | null) =>
        amount == null || amount === 0 ? "" : ` — ${amount.toFixed(2)} ${currency ?? ""}`.trimEnd();

      const lines = report.groups.map((g) => {
        const name = g.entity?.name ?? "(unassigned)";
        const context = g.context ? ` (${g.context})` : "";
        // formatDuration takes seconds, and seconds is the exact figure. Hours
        // is rounded to two decimals for display, so summing it drifts.
        return `  ${name}${context}: ${formatDuration(g.seconds)}${money(g.billableAmount, g.currency)}`;
      });

      // The API returns a null total when the groups span several currencies,
      // because adding them would produce a number that means nothing.
      const total =
        report.totalBillableAmount != null
          ? ` — ${report.totalBillableAmount.toFixed(2)} ${report.currency ?? ""}`.trimEnd()
          : "";

      return text(
        `${from} to ${to}, by ${report.groupBy}: ` +
          `${formatDuration(report.totalSeconds)} total${total}\n${lines.join("\n")}`,
      );
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
