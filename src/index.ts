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
  type Client,
  type Invoice,
  type InvoiceStatus,
  type Money,
  type Project,
  type ProjectBillingInput,
  type PublicId,
  type ReportGroupBy,
  type Tag,
  type TimeEntry,
  describeEntry,
  formatDuration,
  formatMoney,
  normaliseName,
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
  version: "0.5.0",
});

// ── Looking things up by name ──────────────────────────────────────────────
//
// Every write and filter in the API takes an opaque id, but people say
// "Quanta" and "Matthew". These turn one into the other, so a caller does not
// have to list projects first just to log an hour against one.

/**
 * Reference data goes stale slowly (a new project a few times a month) and gets
 * asked for repeatedly inside one conversation, so it is cached briefly rather
 * than re-fetched per tool call. Short enough that a project created mid-chat
 * shows up without restarting the server.
 */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const isPublicId = (value: string) => /^[a-z]+_[0-9a-z]{20,}$/.test(value);

/**
 * Picks the one thing a name refers to. Exact match wins; failing that a unique
 * substring match. Anything ambiguous or unknown returns a message naming the
 * real options — guessing here means silently logging time against the wrong
 * project, which is worse than one more question.
 */
function pick<T>(
  value: string,
  candidates: T[],
  nameOf: (item: T) => string,
  kind: string,
): { hit?: T; error?: string } {
  const wanted = normaliseName(value);
  const named = candidates.map((item) => ({ item, name: normaliseName(nameOf(item)) }));

  const exact = named.filter((c) => c.name === wanted);
  if (exact.length === 1) return { hit: exact[0].item };

  const partial = named.filter((c) => c.name.includes(wanted));
  if (partial.length === 1) return { hit: partial[0].item };

  if (partial.length > 1) {
    return {
      error: `"${value}" matches more than one ${kind}: ${partial
        .map((c) => nameOf(c.item))
        .join(", ")}. Say which one.`,
    };
  }

  const known = candidates.map(nameOf).sort();
  return {
    error: known.length
      ? `No ${kind} called "${value}". Known ${kind}s: ${known.join(", ")}.`
      : `This workspace has no ${kind}s.`,
  };
}

const allProjects = () => cached("projects", () => quanta.listProjects());
const allClients = () => cached("clients", () => quanta.listClients());
const allTags = () => cached("tags", () => quanta.listTags());

/**
 * Every active project the key's user may see on the Projects page, not only
 * the ones they are on. Managing a project (renaming it, adding a task) is an
 * administrator's job, and an administrator is often not a member of it.
 */
const everyProject = () => cached("projects:all", () => quanta.listProjects({ scope: "all" }));

/** Forget cached reference data after a write, so the next lookup sees the change. */
function forget(...prefixes: string[]) {
  for (const key of [...cache.keys()]) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) cache.delete(key);
  }
}

/**
 * A project to manage, by name or id. Looks at the projects the user is on
 * first, then at everything they may see, and loads by id when given one so a
 * deactivated project can still be found and switched back on.
 */
async function resolveManagedProject(value: string): Promise<{ project?: Project; error?: string }> {
  if (isPublicId(value)) {
    const project = await quanta.getProject(value);
    return project ? { project } : { error: `No project with id ${value}.` };
  }

  const mine = pick(value, await allProjects(), (p) => p.name, "project");
  if (mine.hit) return { project: mine.hit };

  const { hit, error } = pick(value, await everyProject(), (p) => p.name, "project");
  return hit ? { project: hit } : { error };
}

async function resolveClient(value?: string): Promise<{ client?: Client; id?: PublicId; error?: string }> {
  if (!value) return {};
  if (isPublicId(value)) return { id: value };
  const { hit, error } = pick(value, await allClients(), (c) => c.name, "client");
  return hit
    ? { client: hit, id: hit.id }
    : { error: `${error} A deactivated client is not listed; use its client_ id.` };
}

/**
 * A person, by name or user_ id. There is no route that lists people, so a name
 * is looked up among whoever logged time in the window (the last year unless a
 * range is given), which needs the summary report permission.
 */
async function resolveUser(
  value: string | undefined,
  from?: string,
  to?: string,
): Promise<{ id?: PublicId; name?: string; error?: string }> {
  if (!value) return {};
  if (isPublicId(value)) return { id: value, name: value };

  const day = (d: Date) => d.toISOString().slice(0, 10);
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 365 * 86_400_000);
  const r = await resolveFilter("user", value, day(start), day(end));
  return r.error ? { error: r.error } : { id: r.ids![0], name: r.label };
}

async function resolveProject(value?: string): Promise<{ id?: PublicId; name?: string; project?: Project; error?: string }> {
  if (!value) return {};
  const projects = await allProjects();
  if (isPublicId(value)) {
    const known = projects.find((p) => p.id === value);
    return { id: value, name: known?.name ?? value, project: known };
  }
  const { hit, error } = pick(value, projects, (p) => p.name, "project");
  return hit ? { id: hit.id, name: hit.name, project: hit } : { error };
}

/**
 * Tasks live inside projects, so a task name is only unambiguous within one.
 * With a project in hand the search is that project's tasks; without one it is
 * every task in the workspace, which is where duplicate names get caught.
 */
async function resolveTask(
  value?: string,
  project?: Project,
): Promise<{ id?: PublicId; name?: string; error?: string }> {
  if (!value) return {};
  if (isPublicId(value)) return { id: value, name: value };

  const scope = project
    ? project.tasks.map((t) => ({ ...t, project: project.name }))
    : (await allProjects()).flatMap((p) => p.tasks.map((t) => ({ ...t, project: p.name })));

  const { hit, error } = pick(value, scope, (t) => t.name, "task");
  return hit ? { id: hit.id, name: hit.name } : { error };
}

async function resolveTags(values?: string[]): Promise<{ ids?: PublicId[]; names?: string[]; error?: string }> {
  if (!values?.length) return {};
  const tags = await allTags();
  const ids: PublicId[] = [];
  const names: string[] = [];

  for (const value of values) {
    if (isPublicId(value)) {
      ids.push(value);
      names.push(tags.find((t) => t.id === value)?.name ?? value);
      continue;
    }
    const { hit, error } = pick(value, tags, (t) => t.name, "tag");
    if (error) return { error };
    ids.push(hit!.id);
    names.push(hit!.name);
  }

  return { ids, names };
}

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
    "Project, task and tags take plain names; nothing needs listing first.",
  {
    description: z.string().optional().describe("What the user is working on"),
    project: z.string().optional().describe("Project name (e.g. 'Quanta') or proj_ id"),
    task: z.string().optional().describe("Task name (e.g. 'Dev') or task_ id"),
    tags: z.array(z.string()).optional().describe("Tag names or tag_ ids"),
    billable: z.boolean().optional().describe("Defaults to billable."),
  },
  async ({ description, project, task, tags, billable }) =>
    guard(async () => {
      const p = await resolveProject(project);
      if (p.error) return text(p.error);
      const t = await resolveTask(task, p.project);
      if (t.error) return text(t.error);
      const g = await resolveTags(tags);
      if (g.error) return text(g.error);

      const entry = await quanta.startTimer({
        description,
        projectId: p.id,
        taskId: t.id,
        tagIds: g.ids,
        billable,
      });
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
    project: z.string().optional().describe("Project name (e.g. 'Quanta') or proj_ id"),
    task: z.string().optional().describe("Task name (e.g. 'Dev') or task_ id"),
    tags: z.array(z.string()).optional().describe("Tag names or tag_ ids"),
    billable: z.boolean().optional().describe("Defaults to billable."),
    user: z
      .string()
      .optional()
      .describe("Log it for this teammate instead of yourself, by name or user_ id. Needs the permission to manage other people's time."),
    startedAt: z
      .string()
      .optional()
      .describe("ISO 8601 start time with a timezone offset (e.g. 2026-08-27T09:00:00-04:00); a bare local time is read as UTC. Defaults to now minus the duration."),
  },
  async ({ description, minutes, project, task, tags, billable, user, startedAt }) =>
    guard(async () => {
      const p = await resolveProject(project);
      if (p.error) return text(p.error);
      const t = await resolveTask(task, p.project);
      if (t.error) return text(t.error);
      const g = await resolveTags(tags);
      if (g.error) return text(g.error);
      const u = await resolveUser(user);
      if (u.error) return text(u.error);

      const durationSeconds = Math.round(minutes * 60);
      const start =
        startedAt ?? new Date(Date.now() - durationSeconds * 1000).toISOString();

      const entry = await quanta.createTimeEntry({
        description,
        durationSeconds,
        startedAt: start,
        projectId: p.id,
        taskId: t.id,
        tagIds: g.ids,
        billable,
        userId: u.id,
      });

      if (!entry) return text("Time logged.");
      const forWhom = u.id ? ` for ${entry.user?.name ?? u.name}` : "";
      return text(`Logged ${formatDuration(entry.durationSeconds)}${forWhom}: ${describeEntry(entry)}.`);
    }),
);

server.tool(
  "list_projects",
  "List projects with their ids, tasks and budgets. By default the projects the " +
    "user is on, which are the ones they can log time against. Set everyProject " +
    "for every project they may see on the Projects page (an administrator sees " +
    "them all), and deactivated to list the switched-off ones instead.",
  {
    everyProject: z
      .boolean()
      .optional()
      .describe("true for every project the user may see, not only the ones they are on"),
    deactivated: z
      .boolean()
      .optional()
      .describe("true to list deactivated projects instead of active ones. Implies everyProject."),
  },
  async ({ everyProject: wide, deactivated }) =>
    guard(async () => {
      const projects =
        wide || deactivated
          ? await quanta.listProjects({ scope: "all", isActive: deactivated ? false : undefined })
          : await quanta.listProjects();
      if (!projects?.length) {
        return text(deactivated ? "No deactivated projects." : "No projects found in this workspace.");
      }

      const lines = projects.map((p) => {
        const client = p.client?.name ? ` (${p.client.name})` : "";
        const tasks = p.tasks.length
          ? `\n    tasks: ${p.tasks.map((t) => `${t.name} [${t.id}]`).join(", ")}`
          : "";
        // Budgets are the thing people ask about after "how many hours" — show
        // spend against them here rather than making it a second call.
        const budgets = (p.budgets ?? [])
          .map((b) => {
            const unit = b.type === "money" ? (b.currency ?? "") : "h";
            const of =
              b.amount != null
                ? ` of ${b.amount}${unit === "h" ? "h" : ` ${unit}`}`
                : "";
            const spent = b.spent != null ? `${b.spent}${unit === "h" ? "h" : ` ${unit}`}` : "?";
            const period = b.recurrence === "resetting" ? " per period" : "";
            return `\n    budget (${b.type}${period}): ${spent}${of} — ${Math.round(b.percentUsed)}% used`;
          })
          .join("");
        return `  ${p.name}${client} — id ${p.id}${tasks}${budgets}`;
      });

      return text(`${deactivated ? "Deactivated projects" : "Projects"}:\n${lines.join("\n")}`);
    }),
);

server.tool(
  "list_time_entries",
  "List recent time entries, optionally within a date range. Use to answer " +
    "questions like 'what did I work on yesterday' or 'how much time went to X'. " +
    "Your own entries unless user is given.",
  {
    user: z
      .string()
      .optional()
      .describe("List this teammate's entries instead of your own, by name or user_ id. Needs the permission to manage other people's time."),
    from: z.string().optional().describe("ISO 8601 start of range"),
    to: z.string().optional().describe("ISO 8601 end of range"),
    limit: z.number().int().min(1).max(200).optional().describe("Max entries (default 20)"),
    skip: z.number().int().min(0).optional().describe("Entries to skip, for paging further back"),
  },
  async ({ user, from, to, limit, skip }) =>
    guard(async () => {
      const u = await resolveUser(user, from, to);
      if (u.error) return text(u.error);

      const page = await quanta.listTimeEntries({ from, to, skip, take: limit ?? 20, userId: u.id });
      if (!page?.data.length) return text("No time entries in that range.");

      const total = page.data.reduce((sum, e) => sum + e.durationSeconds, 0);
      // Ids are printed because update_time_entry and delete_time_entry need
      // them, and this is where a caller finds the entry it wants to change.
      const lines = page.data.map((e) => {
        const when = e.startedAt ? new Date(e.startedAt).toLocaleString() : "unknown time";
        const tags = e.tags?.length ? ` #${e.tags.map((t) => t.name).join(" #")}` : "";
        return `  ${when} — ${describeEntry(e)}${tags}  [${e.id}]`;
      });

      const whose = u.id ? ` for ${page.data[0].user?.name ?? u.name}` : "";
      return text(
        `${page.data.length} of ${page.totalCount} entries${whose}, ${formatDuration(total)} total:\n${lines.join("\n")}`,
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
      return text(
        `Clients:\n${clients
          .map((c) => `  ${c.name}${c.currency ? ` (${c.currency})` : ""} — id ${c.id}`)
          .join("\n")}`,
      );
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
    user: z.string().optional().describe("Only this person's time, by name (e.g. 'Matthew') or user_ id"),
    project: z.string().optional().describe("Only this project, by name or proj_ id"),
    client: z.string().optional().describe("Only this client, by name or client_ id"),
    task: z.string().optional().describe("Only this task, by name (e.g. 'Design') or task_ id"),
    billableOnly: z
      .boolean()
      .optional()
      .describe("Only count billable time. Omit to count everything."),
    invoiced: z
      .boolean()
      .optional()
      .describe("true for invoiced time only, false for uninvoiced only. Omit for both."),
  },
  async ({ from, to, groupBy, user, project, client, task, billableOnly, invoiced }) =>
    guard(async () => {
      const scopeProject = project ? (await resolveProject(project)).project : undefined;
      const resolved = {
        user: await resolveFilter("user", user, from, to),
        project: await resolveFilter("project", project, from, to),
        client: await resolveFilter("client", client, from, to),
        task: await resolveFilter("task", task, from, to, scopeProject),
      };

      const failed = Object.values(resolved).find((r) => r.error);
      if (failed) return text(failed.error!);

      const report = await quanta.summaryReport((groupBy ?? "client") as ReportGroupBy, {
        from,
        to,
        userId: resolved.user.ids,
        projectId: resolved.project.ids,
        clientId: resolved.client.ids,
        taskId: resolved.task.ids,
        billable: billableOnly === true ? true : undefined,
        invoiced,
      });

      if (!report?.groups?.length) {
        const scope = [resolved.user.label, resolved.project.label, resolved.client.label, resolved.task.label]
          .filter(Boolean)
          .join(", ");
        return text(`No time logged between ${from} and ${to}${scope ? ` for ${scope}` : ""}.`);
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
      // Same rule as the per-group amounts: a zero is not worth printing.
      const total =
        report.totalBillableAmount != null && report.totalBillableAmount !== 0
          ? ` — ${report.totalBillableAmount.toFixed(2)} ${report.currency ?? ""}`.trimEnd()
          : "";

      return text(
        `${from} to ${to}, by ${report.groupBy}: ` +
          `${formatDuration(report.totalSeconds)} total${total}\n${lines.join("\n")}`,
      );
    }),
);

/**
 * Turns whatever the user called something into the id the report expects.
 *
 * Accepts an opaque id unchanged, so a caller that already listed projects can
 * pass one straight through. Otherwise treats the value as a name: exact match
 * first, then a unique substring match. An ambiguous or unknown name comes back
 * as a message naming the real options rather than a guess, because silently
 * reporting on the wrong person is worse than asking again.
 */
async function resolveFilter(
  kind: ReportGroupBy,
  value: string | undefined,
  from: string,
  to: string,
  project?: Project,
): Promise<{ ids?: PublicId[]; label?: string; error?: string }> {
  if (!value) return {};
  if (isPublicId(value)) return { ids: [value], label: value };

  // Anything with a list endpoint resolves there: it knows about a project that
  // logged nothing this month (a "0h" answer, not "no such project"), and it
  // keeps two tasks called "Design" on different projects apart. The summary
  // report — which is all users have — would merge those into one name.
  if (kind === "project") {
    const r = await resolveProject(value);
    return r.error ? { error: r.error } : { ids: [r.id!], label: r.name };
  }
  if (kind === "task") {
    const r = await resolveTask(value, project);
    return r.error ? { error: r.error } : { ids: [r.id!], label: r.name };
  }
  if (kind === "client") {
    const { hit, error } = pick(value, await allClients(), (c) => c.name, "client");
    return hit ? { ids: [hit.id], label: hit.name } : { error };
  }

  const directory = await quanta.entityIdsByName(kind, from, to);
  const wanted = normaliseName(value);

  const exact = directory.get(wanted);
  if (exact) return { ids: [exact.id], label: exact.name };

  const partial = [...directory.entries()].filter(([name]) => name.includes(wanted));
  if (partial.length === 1) {
    const [, hit] = partial[0];
    return { ids: [hit.id], label: hit.name };
  }

  const known = [...directory.values()].map((v) => v.name).sort();
  if (partial.length > 1) {
    return {
      error:
        `"${value}" matches more than one ${kind}: ${partial.map(([, v]) => v.name).join(", ")}. ` +
        "Say which one.",
    };
  }

  return {
    error: known.length
      ? `No ${kind} matching "${value}" logged time between ${from} and ${to}. Known: ${known.join(", ")}.`
      : `No ${kind} logged any time between ${from} and ${to}.`,
  };
}

const reportRow = (entry: TimeEntry, showUser: boolean): string => {
  const when = entry.startedAt
    ? new Date(entry.startedAt).toISOString().slice(0, 10)
    : "??????????";
  const where = [entry.project?.name, entry.task?.name].filter(Boolean).join(" / ") || "(no project)";
  const who = showUser && entry.user?.name ? `${entry.user.name} — ` : "";
  return `  ${when}  ${formatDuration(entry.durationSeconds).padStart(7)}  ${who}${where}` +
    `${entry.description ? ` — ${entry.description}` : ""}`;
};

server.tool(
  "get_detailed_report",
  "The individual time entries behind a report, across everyone in the workspace, " +
    "with totals for everything that matched. Use for 'what did Matthew work on last " +
    "week', 'show me the entries we billed Acme for', or anything needing entries " +
    "rather than totals — get_time_report gives totals only, and list_time_entries " +
    "only ever sees your own work. Filters take plain names ('Matthew', 'Acme'); ids " +
    "from list_projects work too. Needs a date range; at most 366 days.",
  {
    from: z.string().describe("First day to include, inclusive, as YYYY-MM-DD"),
    to: z.string().describe("Last day to include, inclusive, as YYYY-MM-DD"),
    user: z.string().optional().describe("Whose entries, by name (e.g. 'Matthew') or user_ id"),
    project: z.string().optional().describe("Restrict to one project, by name or proj_ id"),
    client: z.string().optional().describe("Restrict to one client, by name or client_ id"),
    task: z.string().optional().describe("Restrict to one task, by name or task_ id"),
    billableOnly: z.boolean().optional().describe("Only billable time. Omit for everything."),
    invoiced: z
      .boolean()
      .optional()
      .describe("true for invoiced entries only, false for uninvoiced only. Omit for both."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Entries to show (default 25). Totals always cover every match, not just these."),
    sort: z
      .enum(["startedAt", "-startedAt", "duration", "-duration", "user", "-user", "task", "-task"])
      .optional()
      .describe("Order; '-' is descending. Defaults to -startedAt (newest first)."),
  },
  async ({ from, to, user, project, client, task, billableOnly, invoiced, limit, sort }) =>
    guard(async () => {
      const scopeProject = project ? (await resolveProject(project)).project : undefined;
      const resolved = {
        user: await resolveFilter("user", user, from, to),
        project: await resolveFilter("project", project, from, to),
        client: await resolveFilter("client", client, from, to),
        task: await resolveFilter("task", task, from, to, scopeProject),
      };

      const failed = Object.values(resolved).find((r) => r.error);
      if (failed) return text(failed.error!);

      const take = limit ?? 25;
      const report = await quanta.detailedReport({
        from,
        to,
        userId: resolved.user.ids,
        projectId: resolved.project.ids,
        clientId: resolved.client.ids,
        taskId: resolved.task.ids,
        billable: billableOnly === true ? true : undefined,
        invoiced,
        sort: sort ?? "-startedAt",
        take,
      });

      if (!report?.data?.length) {
        return text(`No time entries between ${from} and ${to} for those filters.`);
      }

      const scope = [
        resolved.user.label,
        resolved.project.label,
        resolved.client.label,
        resolved.task.label,
        billableOnly ? "billable only" : null,
        invoiced === true ? "invoiced" : invoiced === false ? "uninvoiced" : null,
      ]
        .filter(Boolean)
        .join(", ");

      const totals = report.totals;
      const money =
        totals?.billableAmount != null && totals.billableAmount !== 0
          ? ` — ${totals.billableAmount.toFixed(2)} ${totals.currency ?? ""}`.trimEnd()
          : "";

      // The header counts every match; the rows are only the page asked for.
      const shown =
        report.totalCount > report.data.length
          ? ` (showing ${report.data.length} of ${report.totalCount})`
          : ` (${report.totalCount} ${report.totalCount === 1 ? "entry" : "entries"})`;

      const header =
        `${from} to ${to}${scope ? ` — ${scope}` : ""}: ` +
        `${formatDuration(totals?.seconds ?? 0)}${money}${shown}`;

      return text(`${header}\n${report.data.map((e) => reportRow(e, !resolved.user.ids)).join("\n")}`);
    }),
);

server.tool(
  "list_tags",
  "The tags available for labelling time entries, with their ids.",
  {},
  async () =>
    guard(async () => {
      const tags = await quanta.listTags();
      if (!tags?.length) return text("This workspace has no tags.");
      return text(`Tags:\n${tags.map((t: Tag) => `  ${t.name} — id ${t.id}`).join("\n")}`);
    }),
);

// ── Editing what is already logged ─────────────────────────────────────────

server.tool(
  "update_time_entry",
  "Change an existing time entry: its description, how long it was, when it " +
    "started, what it is booked to, or whether it is billable. Omitted fields " +
    "are left alone. Get the id from list_time_entries or get_detailed_report.",
  {
    id: z.string().describe("The entry's id, e.g. time_7h3k9m… — shown in square brackets by the list tools"),
    description: z.string().optional().describe("New description"),
    minutes: z.number().positive().optional().describe("New duration, in minutes"),
    startedAt: z.string().optional().describe("New start time, ISO 8601 with a timezone offset; a bare local time is read as UTC"),
    project: z.string().optional().describe("Move it to this project, by name or proj_ id"),
    task: z.string().optional().describe("Move it to this task, by name or task_ id"),
    billable: z.boolean().optional().describe("Mark billable or not"),
  },
  async ({ id, description, minutes, startedAt, project, task, billable }) =>
    guard(async () => {
      const p = await resolveProject(project);
      if (p.error) return text(p.error);
      const t = await resolveTask(task, p.project);
      if (t.error) return text(t.error);

      const updated = await quanta.updateTimeEntry(id, {
        description,
        durationSeconds: minutes === undefined ? undefined : Math.round(minutes * 60),
        startedAt,
        projectId: p.id,
        taskId: t.id,
        billable,
      });

      if (!updated) return text("Entry updated.");
      return text(`Updated: ${describeEntry(updated)}.`);
    }),
);

server.tool(
  "delete_time_entry",
  "Permanently remove a time entry. Get the id from list_time_entries or " +
    "get_detailed_report. Confirm with the user first — this is not undoable " +
    "from here.",
  {
    id: z.string().min(1).describe("The entry's id, e.g. time_7h3k9m…"),
  },
  async ({ id }) =>
    guard(async () => {
      await quanta.deleteTimeEntry(id);
      return text(`Deleted entry ${id}.`);
    }),
);

server.tool(
  "batch_update_time_entries",
  "Change many entries at once — moving a block of work onto a different " +
    "project or task, or flipping billable across a set. All or nothing: if " +
    "one entry cannot be changed, none of them are. At most 100 per call, and " +
    "each id may appear only once.",
  {
    ids: z.array(z.string()).min(1).max(100).describe("The entry ids to change"),
    project: z.string().optional().describe("Move them all to this project, by name or proj_ id"),
    task: z.string().optional().describe("Move them all to this task, by name or task_ id"),
    billable: z.boolean().optional().describe("Set billable across all of them"),
    description: z.string().optional().describe("Set the same description on all of them"),
  },
  async ({ ids, project, task, billable, description }) =>
    guard(async () => {
      if (project === undefined && task === undefined && billable === undefined && description === undefined) {
        return text("Nothing to change. Give at least one of project, task, billable or description.");
      }

      const p = await resolveProject(project);
      if (p.error) return text(p.error);
      const t = await resolveTask(task, p.project);
      if (t.error) return text(t.error);

      const result = await quanta.batchUpdateTimeEntries(
        ids.map((id) => ({
          id,
          projectId: p.id,
          taskId: t.id,
          billable,
          description,
        })),
      );

      const changed = result?.data?.length ?? 0;
      const moved = [p.name && `project ${p.name}`, t.name && `task ${t.name}`]
        .filter(Boolean)
        .join(", ");
      return text(`Updated ${changed} ${changed === 1 ? "entry" : "entries"}${moved ? ` → ${moved}` : ""}.`);
    }),
);

server.tool(
  "get_time_entry",
  "One time entry by id, with everything it is booked to. Works for a " +
    "teammate's entry when the key's user may see it.",
  {
    id: z.string().min(1).describe("The entry's id, e.g. time_7h3k9m…"),
  },
  async ({ id }) =>
    guard(async () => {
      const e = await quanta.getTimeEntry(id);
      if (!e) return text(`No entry with id ${id}.`);
      const when = e.startedAt ? new Date(e.startedAt).toLocaleString() : "unknown time";
      const tags = e.tags?.length ? ` #${e.tags.map((t) => t.name).join(" #")}` : "";
      const who = e.user?.name ? `${e.user.name}, ` : "";
      return text(
        `${who}${when} — ${describeEntry(e)}${tags}\n` +
          `  ${e.billable ? "billable" : "not billable"}${e.client?.name ? `, client ${e.client.name}` : ""}  [${e.id}]`,
      );
    }),
);

// ── Projects, tasks and clients ────────────────────────────────────────────
//
// The app's own rules apply to every one of these: the key's user needs the
// same permission they would need to do it on screen, and the API's refusals
// (a name already taken, a project with time logged) come back as its own
// sentences, so they are passed on as they are.

const billingShape = {
  billing: z
    .enum(["hourly", "fixed_fee", "non_billable"])
    .optional()
    .describe("How the project is billed. Omit to keep the workspace default (or, on an update, what it has)."),
  hourlyRate: z.number().min(0).optional().describe("Hourly rate, with billing 'hourly'"),
  fixedFeeAmount: z.number().positive().optional().describe("The fee, required with billing 'fixed_fee'"),
};

function billingInput(
  billing: "hourly" | "fixed_fee" | "non_billable" | undefined,
  hourlyRate: number | undefined,
  fixedFeeAmount: number | undefined,
): { value?: ProjectBillingInput; error?: string } {
  if (!billing) {
    return hourlyRate !== undefined || fixedFeeAmount !== undefined
      ? { error: "Say how the project is billed (billing: hourly, fixed_fee or non_billable) along with the rate or fee." }
      : {};
  }
  return { value: { type: billing, hourlyRate, fixedFeeAmount } };
}

const describeProject = (p: Project) => {
  const client = p.client?.name ? ` (${p.client.name})` : "";
  const tasks = p.tasks?.length ? `, tasks: ${p.tasks.map((t) => t.name).join(", ")}` : "";
  return `${p.name}${client}${p.isActive ? "" : " [deactivated]"} — id ${p.id}${tasks}`;
};

server.tool(
  "create_project",
  "Create a project, optionally with its tasks. Behaves like creating one in " +
    "the app: the workspace's project defaults fill in whatever is left out. " +
    "Needs the permission to create projects.",
  {
    name: z.string().min(1).describe("The project's name"),
    client: z.string().optional().describe("The client it is for, by name or client_ id"),
    code: z.string().optional().describe("Short project code"),
    visibility: z
      .enum(["private", "public"])
      .optional()
      .describe("private: only its members see it. public: everyone in the workspace. Omit for the workspace default."),
    notes: z.string().optional().describe("Project notes"),
    startsOn: z.string().optional().describe("Start date, YYYY-MM-DD"),
    endsOn: z.string().optional().describe("End date, YYYY-MM-DD"),
    ...billingShape,
    tasks: z.array(z.string().min(1)).optional().describe("Names of tasks to create on it"),
    joinProject: z
      .boolean()
      .optional()
      .describe("false to stay off a private project you create. Only honoured for someone who can open the project anyway, such as an administrator. Defaults to joining."),
  },
  async ({ name, client, code, visibility, notes, startsOn, endsOn, billing, hourlyRate, fixedFeeAmount, tasks, joinProject }) =>
    guard(async () => {
      const c = await resolveClient(client);
      if (c.error) return text(c.error);
      const b = billingInput(billing, hourlyRate, fixedFeeAmount);
      if (b.error) return text(b.error);

      const project = await quanta.createProject({
        name,
        clientId: c.id,
        code,
        visibility,
        notes,
        startsOn,
        endsOn,
        billing: b.value,
        tasks: tasks?.map((t) => ({ name: t })),
        assignCreator: joinProject,
      });
      forget("projects");

      if (!project) return text(`Created project ${name}.`);
      return text(`Created project: ${describeProject(project)}.`);
    }),
);

server.tool(
  "update_project",
  "Change a project: rename it, move it to another client, change how it is " +
    "billed, or deactivate or reactivate it. Omitted fields are left alone. " +
    "Tasks are changed with the task tools.",
  {
    project: z.string().describe("The project, by name or proj_ id. Use the id for a deactivated project."),
    name: z.string().min(1).optional().describe("New name"),
    client: z.string().optional().describe("Move it to this client, by name or client_ id"),
    code: z.string().optional().describe("New project code"),
    visibility: z.enum(["private", "public"]).optional().describe("Who can see it"),
    notes: z.string().optional().describe("New project notes"),
    startsOn: z.string().optional().describe("Start date, YYYY-MM-DD"),
    endsOn: z.string().optional().describe("End date, YYYY-MM-DD"),
    ...billingShape,
    active: z.boolean().optional().describe("false to deactivate the project, true to switch it back on"),
  },
  async ({ project, name, client, code, visibility, notes, startsOn, endsOn, billing, hourlyRate, fixedFeeAmount, active }) =>
    guard(async () => {
      const p = await resolveManagedProject(project);
      if (p.error) return text(p.error);
      const c = await resolveClient(client);
      if (c.error) return text(c.error);
      const b = billingInput(billing, hourlyRate, fixedFeeAmount);
      if (b.error) return text(b.error);

      const updated = await quanta.updateProject(p.project!.id, {
        name,
        clientId: c.id,
        code,
        visibility,
        notes,
        startsOn,
        endsOn,
        billing: b.value,
        isActive: active,
      });
      forget("projects");

      if (!updated) return text(`Updated project ${p.project!.name}.`);
      return text(`Updated project: ${describeProject(updated)}.`);
    }),
);

server.tool(
  "delete_project",
  "Delete a project for good. There is no undo. Quanta refuses while the " +
    "project has time, expenses or a retainer; deactivate it with " +
    "update_project instead. Confirm with the user first.",
  {
    project: z.string().describe("The project, by name or proj_ id"),
  },
  async ({ project }) =>
    guard(async () => {
      const p = await resolveManagedProject(project);
      if (p.error) return text(p.error);
      await quanta.deleteProject(p.project!.id);
      forget("projects");
      return text(`Deleted project ${p.project!.name}.`);
    }),
);

server.tool(
  "list_tasks",
  "The tasks on one project, archived ones included, with their ids.",
  {
    project: z.string().describe("The project, by name or proj_ id"),
  },
  async ({ project }) =>
    guard(async () => {
      const p = await resolveManagedProject(project);
      if (p.error) return text(p.error);
      const tasks = await quanta.listProjectTasks(p.project!.id);
      if (!tasks.length) return text(`${p.project!.name} has no tasks.`);
      const lines = tasks.map(
        (t) => `  ${t.name}${t.billable ? "" : " (not billable)"}${t.isArchived ? " [archived]" : ""} — id ${t.id}`,
      );
      return text(`Tasks on ${p.project!.name}:\n${lines.join("\n")}`);
    }),
);

server.tool(
  "create_task",
  "Add a task to a project. Task names are unique within a project.",
  {
    project: z.string().describe("The project to add it to, by name or proj_ id"),
    name: z.string().min(1).describe("The task's name"),
    billable: z.boolean().optional().describe("Defaults to billable."),
    billableRate: z.number().min(0).optional().describe("An hourly rate for this task, when it has its own"),
  },
  async ({ project, name, billable, billableRate }) =>
    guard(async () => {
      const p = await resolveManagedProject(project);
      if (p.error) return text(p.error);
      const task = await quanta.createTask(p.project!.id, { name, billable, billableRate });
      forget("projects");
      return text(`Added task ${task?.name ?? name} to ${p.project!.name}${task ? ` — id ${task.id}` : ""}.`);
    }),
);

/** A task to change, by task_ id, or by name within a named project. */
async function resolveManagedTask(
  task: string,
  project?: string,
): Promise<{ id?: PublicId; name?: string; error?: string }> {
  if (isPublicId(task)) return { id: task, name: task };
  if (!project) return { error: "Say which project the task is on, or give its task_ id." };

  const p = await resolveManagedProject(project);
  if (p.error) return { error: p.error };
  const tasks = await quanta.listProjectTasks(p.project!.id);
  const { hit, error } = pick(task, tasks, (t) => t.name, "task");
  return hit ? { id: hit.id, name: hit.name } : { error };
}

server.tool(
  "update_task",
  "Change a task: rename it, set whether it is billable, give it its own " +
    "rate, or archive or restore it. Omitted fields are left alone. A new " +
    "rate applies to time logged from now on.",
  {
    task: z.string().describe("The task, by task_ id, or by name together with project"),
    project: z.string().optional().describe("The project the task is on, when the task is given by name"),
    name: z.string().min(1).optional().describe("New name"),
    billable: z.boolean().optional().describe("Whether time on it is billable"),
    billableRate: z.number().min(0).optional().describe("New hourly rate for this task"),
    archived: z.boolean().optional().describe("true to archive the task, false to restore it"),
  },
  async ({ task, project, name, billable, billableRate, archived }) =>
    guard(async () => {
      const t = await resolveManagedTask(task, project);
      if (t.error) return text(t.error);
      const updated = await quanta.updateTask(t.id!, { name, billable, billableRate, isArchived: archived });
      forget("projects");
      return text(
        `Updated task ${updated?.name ?? t.name}${updated?.isArchived ? " [archived]" : ""}.`,
      );
    }),
);

server.tool(
  "delete_task",
  "Delete a task. Quanta refuses while time is logged against it; archive " +
    "it with update_task instead. Confirm with the user first.",
  {
    task: z.string().describe("The task, by task_ id, or by name together with project"),
    project: z.string().optional().describe("The project the task is on, when the task is given by name"),
  },
  async ({ task, project }) =>
    guard(async () => {
      const t = await resolveManagedTask(task, project);
      if (t.error) return text(t.error);
      await quanta.deleteTask(t.id!);
      forget("projects");
      return text(`Deleted task ${t.name}.`);
    }),
);

server.tool(
  "create_client",
  "Create a client. Client names are unique in the workspace.",
  {
    name: z.string().min(1).describe("The client's name"),
    currency: z.string().length(3).optional().describe("ISO currency code, e.g. USD. Omit for the workspace default."),
    code: z.string().optional().describe("Short client code"),
  },
  async ({ name, currency, code }) =>
    guard(async () => {
      const client = await quanta.createClient({ name, currency: currency?.toUpperCase(), code });
      forget("clients");
      return text(`Created client ${client?.name ?? name}${client ? ` — id ${client.id}` : ""}.`);
    }),
);

server.tool(
  "update_client",
  "Change a client: rename it, change its currency or code, or deactivate or " +
    "reactivate it. Omitted fields are left alone. The currency cannot change " +
    "once time has been logged for one of the client's projects.",
  {
    client: z.string().describe("The client, by name or client_ id. Use the id for a deactivated client."),
    name: z.string().min(1).optional().describe("New name"),
    currency: z.string().length(3).optional().describe("New ISO currency code"),
    code: z.string().optional().describe("New client code"),
    active: z.boolean().optional().describe("false to deactivate the client, true to switch it back on"),
  },
  async ({ client, name, currency, code, active }) =>
    guard(async () => {
      const c = await resolveClient(client);
      if (c.error) return text(c.error);
      const updated = await quanta.updateClient(c.id!, {
        name,
        currency: currency?.toUpperCase(),
        code,
        isActive: active,
      });
      forget("clients", "projects");
      return text(
        `Updated client ${updated?.name ?? c.client?.name ?? client}${updated && !updated.isActive ? " [deactivated]" : ""}.`,
      );
    }),
);

server.tool(
  "delete_client",
  "Delete a client for good. There is no undo. Quanta refuses while the " +
    "client has projects, invoices, payments, quotes or a retainer; " +
    "deactivate it with update_client instead. Confirm with the user first.",
  {
    client: z.string().describe("The client, by name or client_ id"),
  },
  async ({ client }) =>
    guard(async () => {
      const c = await resolveClient(client);
      if (c.error) return text(c.error);
      await quanta.deleteClient(c.id!);
      forget("clients");
      return text(`Deleted client ${c.client?.name ?? client}.`);
    }),
);

// ── Invoices (read-only) ───────────────────────────────────────────────────

const moneyList = (amounts: Money[] | undefined) =>
  amounts?.length ? amounts.map((m) => formatMoney(m.amount, m.currency)).join(" + ") : "0.00";

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "draft",
  sent: "sent",
  partially_paid: "part paid",
  paid: "paid",
  overdue: "overdue",
  void: "void",
};

const invoiceRow = (i: Invoice) => {
  const owed =
    i.balanceDue > 0 && i.balanceDue !== i.total ? `, ${formatMoney(i.balanceDue, i.currency)} still owed` : "";
  const due = i.dueOn ? `, due ${i.dueOn}` : "";
  return (
    `  ${i.number ?? "(no number)"}  ${i.client?.name ?? "(no client)"}  ${formatMoney(i.total, i.currency)}` +
    `  ${STATUS_LABEL[i.status] ?? i.status}${owed}  issued ${i.issuedOn}${due}  [${i.id}]`
  );
};

server.tool(
  "list_invoices",
  "List invoices, newest first, with totals for everything that matched. Use " +
    "for 'which invoices are outstanding', 'what does Acme still owe us', " +
    "'what is overdue' or 'what did we invoice in October'. Read-only: " +
    "invoices are created, sent and paid in Quanta. Needs the permission to " +
    "see invoices.",
  {
    outstanding: z
      .boolean()
      .optional()
      .describe("true for only what clients still owe: sent or part paid with a balance left, overdue included. Drafts are not outstanding."),
    status: z
      .enum(["draft", "sent", "partially_paid", "paid", "overdue", "void"])
      .optional()
      .describe("Only invoices with this status, as the app shows it"),
    client: z.string().optional().describe("Only this client's invoices, by name or client_ id"),
    project: z.string().optional().describe("Only invoices that bill this project, by name or proj_ id"),
    from: z.string().optional().describe("Earliest invoice date, inclusive, YYYY-MM-DD"),
    to: z.string().optional().describe("Latest invoice date, inclusive, YYYY-MM-DD"),
    sort: z
      .enum(["issuedOn", "-issuedOn", "dueOn", "-dueOn", "number", "-number", "client", "-client"])
      .optional()
      .describe("Defaults to -issuedOn, newest first. dueOn puts the longest overdue first."),
    limit: z.number().int().min(1).max(200).optional().describe("Max invoices (default 50)"),
    skip: z.number().int().min(0).optional().describe("Invoices to skip, for paging"),
  },
  async ({ outstanding, status, client, project, from, to, sort, limit, skip }) =>
    guard(async () => {
      const c = await resolveClient(client);
      if (c.error) return text(c.error);
      const p = project ? await resolveManagedProject(project) : {};
      if (p.error) return text(p.error);

      const page = await quanta.listInvoices({
        outstanding,
        status,
        clientId: c.id,
        projectId: p.project?.id,
        from,
        to,
        sort,
        skip,
        take: limit ?? 50,
      });

      if (!page?.data.length) {
        return text(outstanding ? "No outstanding invoices match." : "No invoices match.");
      }

      const totals = page.totals;
      const summary = totals
        ? [
            `invoiced ${moneyList(totals.invoiced)}`,
            `outstanding ${moneyList(totals.outstanding)} on ${totals.outstandingCount}`,
            totals.overdueCount ? `overdue ${moneyList(totals.overdue)} on ${totals.overdueCount}` : null,
          ]
            .filter(Boolean)
            .join("; ")
        : "";

      const more =
        page.totalCount > (page.skip ?? 0) + page.data.length
          ? `\nShowing ${page.data.length} of ${page.totalCount}. Pass skip to see more.`
          : "";

      return text(
        `${page.totalCount} ${page.totalCount === 1 ? "invoice" : "invoices"}${summary ? ` — ${summary}` : ""}:\n` +
          `${page.data.map(invoiceRow).join("\n")}${more}`,
      );
    }),
);

server.tool(
  "get_invoice",
  "One invoice with its lines, taxes and payments. Take the id from " +
    "list_invoices. Read-only.",
  {
    id: z.string().min(1).describe("The invoice's id, e.g. inv_7h3k9m… — shown in square brackets by list_invoices"),
  },
  async ({ id }) =>
    guard(async () => {
      const i = await quanta.getInvoice(id);
      if (!i) return text(`No invoice with id ${id}.`);

      const money = (amount: number) => formatMoney(amount, i.currency);
      const lines = i.lines.map(
        (l) => `  ${l.description ?? "(no description)"} — ${l.quantity} x ${money(l.unitPrice)} = ${money(l.amount)}`,
      );
      const taxes = i.taxes.map((t) => `  ${t.name ?? "Tax"} ${t.rate}%: ${money(t.amount)}`);
      const payments = i.payments.map(
        (pmt) => `  ${pmt.paidOn}: ${money(pmt.amount)} by ${pmt.method.replace(/_/g, " ")}`,
      );

      return text(
        [
          `Invoice ${i.number ?? id} for ${i.client?.name ?? "(no client)"} — ${STATUS_LABEL[i.status] ?? i.status}`,
          `Issued ${i.issuedOn}${i.dueOn ? `, due ${i.dueOn}` : ""}`,
          i.subject ? `Subject: ${i.subject}` : null,
          i.poNumber ? `PO number: ${i.poNumber}` : null,
          lines.length ? `Lines:\n${lines.join("\n")}` : "No lines.",
          `Subtotal ${money(i.subTotal)}`,
          taxes.length ? `Tax:\n${taxes.join("\n")}` : null,
          `Total ${money(i.total)}, paid ${money(i.amountPaid)}, balance due ${money(i.balanceDue)}`,
          payments.length ? `Payments:\n${payments.join("\n")}` : null,
          i.notes ? `Note to the client: ${i.notes}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }),
);

// ── Sync ───────────────────────────────────────────────────────────────────

server.tool(
  "get_recent_changes",
  "Everything that changed in the workspace since a point in time, deletions " +
    "included, across every user. Built for keeping a copy of the data " +
    "elsewhere in step; for ordinary questions about where time went, prefer " +
    "get_detailed_report. Needs the detailed-report permission.",
  {
    since: z
      .string()
      .optional()
      .describe("UTC instant, ISO 8601. Use 1970-01-01T00:00:00Z to seed from nothing. Required unless cursor is given."),
    cursor: z.string().optional().describe("Continue a previous run: the nextCursor it returned"),
    limit: z.number().int().min(1).max(200).optional().describe("Rows per page (default 50)"),
  },
  async ({ since, cursor, limit }) =>
    guard(async () => {
      if (!since && !cursor) {
        return text("Give either since (an ISO 8601 instant) or a cursor from a previous call.");
      }

      const page = await quanta.changes({ since, cursor, take: limit ?? 50 });
      if (!page) return text("No changes.");

      const lines = [
        ...page.data.map(
          (e) => `  changed ${e.modifiedAt} — ${describeEntry(e)}  [${e.id}]`,
        ),
        ...page.deleted.map((e) => `  deleted ${e.deletedAt} — [${e.id}]`),
      ];

      if (!lines.length) return text("Nothing has changed since then.");

      const more = page.hasMore
        ? `\nMore to come — call again with cursor: ${page.nextCursor}`
        : "\nUp to date.";
      return text(
        `${page.data.length} changed, ${page.deleted.length} deleted:\n${lines.join("\n")}${more}`,
      );
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
