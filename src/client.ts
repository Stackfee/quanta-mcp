/**
 * Thin wrapper over the Quanta public API (/api/v1). Everything the MCP tools
 * do goes through here, so the server has no knowledge of Quanta internals.
 */

/**
 * Ids are opaque strings with a type prefix: `proj_…`, `task_…`, `client_…`,
 * `tag_…`, `time_…`, `user_…`. Treat everything after the prefix as opaque
 * and never construct one; take them from a list call.
 */
export type PublicId = string;

/**
 * A pointer to another record: enough to show it, plus the id to fetch the
 * rest. Nullable because the API models a reference to something that has no
 * stored record, though every reference on a saved entry carries an id.
 */
export interface EntityRef {
  id: PublicId | null;
  name: string | null;
}

export interface UserRef {
  id: PublicId;
  name: string | null;
}

export interface TimeEntry {
  id: PublicId;
  description: string | null;
  durationSeconds: number;
  startedAt: string | null;
  stoppedAt: string | null;
  isRunning: boolean;
  billable: boolean;
  /** On a Quanta invoice, in a closed retainer statement, or flagged as invoiced outside Quanta. */
  invoiced: boolean;
  project: EntityRef | null;
  task: EntityRef | null;
  client: EntityRef | null;
  tags: EntityRef[];
  user: UserRef | null;
}

export interface Project {
  id: PublicId;
  name: string;
  code: string | null;
  client: EntityRef | null;
  isActive: boolean;
  totalHoursLogged: number;
  tasks: { id: PublicId; name: string; billable: boolean }[];
  billing: ProjectBilling | null;
  budgets: ProjectBudget[];
}

export interface Tag {
  id: PublicId;
  name: string;
  /** Hex colour the workspace gave the tag, when it set one. */
  color: string | null;
}

/** How a project is billed. All three can be on at once. */
export interface ProjectBilling {
  hourlyBilling: boolean;
  fixedFees: boolean;
  retainers: boolean;
}

/**
 * A budget set on the project. Empty when none exist, and also when the key's
 * user may not see them — budgets follow the same visibility rules as the app.
 * amount and spent are null when the user may see progress but not figures,
 * which is why percentUsed is reported separately rather than derived.
 */
export interface ProjectBudget {
  /** "hours" or "money". */
  type: string;
  amount: number | null;
  spent: number | null;
  percentUsed: number;
  isPercentage: boolean;
  /** "none" for a one-off budget, "resetting" for one that starts over each period. */
  recurrence: string;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string | null;
  alertThresholds: number[];
}

export interface Client {
  id: PublicId;
  name: string;
  currency: string | null;
  isActive: boolean;
}

export interface Paged<T> {
  data: T[];
  totalCount: number;
  skip: number;
  take: number;
}

/**
 * A summary group's subject. Shaped like EntityRef; the id carries the
 * prefix of whatever the report is grouped by.
 */
export interface SummaryEntityRef {
  id: PublicId | null;
  name: string | null;
}

export interface SummaryGroup {
  entity: SummaryEntityRef | null;
  /** Client name, set only when grouping by project, so like-named projects can be told apart. */
  context: string | null;
  /** Duration in whole seconds, the same unit durationSeconds uses on an entry. */
  seconds: number;
  billableAmount: number | null;
  costAmount: number | null;
  currency: string | null;
  /** Display colour of the project or task, when it has one. */
  color: string | null;
}

export interface SummaryReport {
  groupBy: string;
  from: string;
  to: string;
  totalSeconds: number;
  /** Null when the groups span more than one currency, since a mixed total means nothing. */
  totalBillableAmount: number | null;
  totalCostAmount: number | null;
  currency: string | null;
  groups: SummaryGroup[];
}

/** A time entry as it now stands, plus when it last changed. */
export interface ChangedTimeEntry extends TimeEntry {
  /** Created, edited or deleted at this UTC instant. Checkpoint the highest you see. */
  modifiedAt: string;
}

/** An entry that no longer exists, so a copy of the data elsewhere can drop it. */
export interface DeletedTimeEntry {
  id: PublicId;
  deletedAt: string;
}

export interface TimeEntryChanges {
  data: ChangedTimeEntry[];
  deleted: DeletedTimeEntry[];
  /** Pass back as `cursor` for the next page. Opaque; do not construct one. */
  nextCursor: string | null;
  hasMore: boolean;
}

/** Totals for everything matching a detailed report's filters, not just the page returned. */
export interface ReportTotals {
  seconds: number;
  billableAmount: number | null;
  costAmount: number | null;
  currency: string | null;
}

/** A page of individual entries behind a report, plus the totals for the whole filtered set. */
export interface DetailedReport {
  data: TimeEntry[];
  totalCount: number;
  skip: number;
  take: number;
  totals: ReportTotals | null;
}

export type ReportGroupBy = "client" | "project" | "user" | "task";

export interface ReportFilters {
  from: string;
  to: string;
  projectId?: PublicId[];
  clientId?: PublicId[];
  userId?: PublicId[];
  taskId?: PublicId[];
  tagId?: PublicId[];
  billable?: boolean;
  invoiced?: boolean;
}

export interface DetailedReportFilters extends ReportFilters {
  /** startedAt, duration, client, user or task; prefix with '-' to reverse. */
  sort?: string;
  skip?: number;
  take?: number;
}

export class QuantaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "QuantaApiError";
  }
}

export class QuantaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(
    path: string,
    init: RequestInit & { method?: string } = {},
  ): Promise<T | null> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;

    const response = await fetch(url, {
      ...init,
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (response.status === 204) return null;

    if (response.status === 401) {
      throw new QuantaApiError(
        "Quanta rejected the API key. Check QUANTA_API_KEY, and that the workspace has an active paid plan.",
        401,
      );
    }

    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { message?: string; error?: string };
        detail = body.message ?? body.error ?? "";
      } catch {
        /* non-JSON error body */
      }
      throw new QuantaApiError(
        detail || `Quanta API returned ${response.status} for ${path}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  getCurrentTimer() {
    return this.request<TimeEntry>("/api/v1/timer/current");
  }

  startTimer(body: {
    description?: string;
    projectId?: PublicId;
    taskId?: PublicId;
    billable?: boolean;
    tagIds?: PublicId[];
  }) {
    return this.request<TimeEntry>("/api/v1/timer/start", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  stopTimer() {
    return this.request<TimeEntry>("/api/v1/timer/stop", { method: "POST" });
  }

  listTimeEntries(params: { from?: string; to?: string; skip?: number; take?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.skip !== undefined) qs.set("skip", String(params.skip));
    qs.set("take", String(params.take ?? 20));
    return this.request<Paged<TimeEntry>>(`/api/v1/time-entries?${qs.toString()}`);
  }

  createTimeEntry(body: {
    description?: string;
    durationSeconds: number;
    startedAt?: string;
    projectId?: PublicId;
    taskId?: PublicId;
    billable?: boolean;
    tagIds?: PublicId[];
  }) {
    return this.request<TimeEntry>("/api/v1/time-entries", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Edits one entry. Omitted fields are left alone, so this is a true partial update. */
  updateTimeEntry(
    id: PublicId,
    body: {
      description?: string;
      durationSeconds?: number;
      startedAt?: string;
      projectId?: PublicId;
      taskId?: PublicId;
      billable?: boolean;
      invoiced?: boolean;
    },
  ) {
    return this.request<TimeEntry>(`/api/v1/time-entries/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /** Deletes one entry. Resolves to null: the API answers 204 with no body. */
  deleteTimeEntry(id: PublicId) {
    return this.request<null>(`/api/v1/time-entries/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /**
   * Edits many entries in one call, all or nothing — if any one fails, none of
   * them change. That guarantee is the point: a half-applied bulk move leaves
   * you reading every entry back to find out which half landed.
   *
   * At most 100 per call, and an id may appear only once.
   */
  batchUpdateTimeEntries(
    updates: {
      id: PublicId;
      description?: string;
      durationSeconds?: number;
      startedAt?: string;
      projectId?: PublicId;
      taskId?: PublicId;
      billable?: boolean;
      invoiced?: boolean;
    }[],
  ) {
    return this.request<{ data: TimeEntry[] }>("/api/v1/time-entries/batch", {
      method: "POST",
      body: JSON.stringify({ updates }),
    });
  }

  /**
   * Everything in the workspace that changed since a point in time, deletions
   * included. Covers every user, unlike listTimeEntries, so it needs the
   * detailed-report permission.
   *
   * `since` is inclusive, so boundary rows arrive again on the next run; apply
   * changes by id and that is harmless.
   */
  changes(params: { since?: string; cursor?: string; take?: number }) {
    const qs = new URLSearchParams();
    if (params.cursor) qs.set("cursor", params.cursor);
    else if (params.since) qs.set("since", params.since);
    if (params.take !== undefined) qs.set("take", String(params.take));

    return this.request<TimeEntryChanges>(`/api/v1/time-entries/changes?${qs.toString()}`);
  }

  // Reference data is paged like /time-entries. Ask for the maximum page so a
  // large workspace doesn't quietly look half-empty.
  //
  // Accepts either shape. These endpoints returned a bare array before paging
  // was added, and a published client meets whatever API version a workspace is
  // running — so assuming the new envelope makes an older server look like an
  // empty workspace rather than an error, which is the worst way to be wrong.
  private static items<T>(result: Paged<T> | T[] | null): T[] {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    return result.data ?? [];
  }

  async listProjects() {
    return QuantaClient.items(
      await this.request<Paged<Project> | Project[]>("/api/v1/projects?take=200"),
    );
  }

  async listClients() {
    return QuantaClient.items(
      await this.request<Paged<Client> | Client[]>("/api/v1/clients?take=200"),
    );
  }

  async listTags() {
    return QuantaClient.items(await this.request<Paged<Tag> | Tag[]>("/api/v1/tags?take=200"));
  }

  /**
   * Grouped totals for a date range.
   *
   * Unlike the rest of this client, the report endpoints require a permission
   * on the key's user, so a 403 here means the key's creator cannot open the
   * equivalent report in the app either. The message names the permission.
   */
  summaryReport(groupBy: ReportGroupBy, filters: ReportFilters) {
    const qs = new URLSearchParams({
      from: filters.from,
      to: filters.to,
      groupBy,
    });
    for (const [key, values] of [
      ["projectId", filters.projectId],
      ["clientId", filters.clientId],
      ["userId", filters.userId],
      ["taskId", filters.taskId],
      ["tagId", filters.tagId],
    ] as const) {
      for (const value of values ?? []) qs.append(key, value);
    }
    if (filters.billable !== undefined) qs.set("billable", String(filters.billable));
    if (filters.invoiced !== undefined) qs.set("invoiced", String(filters.invoiced));

    return this.request<SummaryReport>(`/api/v1/reports/summary?${qs.toString()}`);
  }

  /**
   * The individual entries behind a report, across everyone in the workspace.
   *
   * Distinct from listTimeEntries, which the API scopes to the calling key's
   * own user and cannot be widened. This is the only way to see someone
   * else's entries, so it carries the heavier permission of the two.
   */
  detailedReport(filters: DetailedReportFilters) {
    const qs = new URLSearchParams({ from: filters.from, to: filters.to });

    for (const [key, values] of [
      ["projectId", filters.projectId],
      ["clientId", filters.clientId],
      ["userId", filters.userId],
      ["taskId", filters.taskId],
      ["tagId", filters.tagId],
    ] as const) {
      for (const value of values ?? []) qs.append(key, value);
    }

    if (filters.billable !== undefined) qs.set("billable", String(filters.billable));
    if (filters.invoiced !== undefined) qs.set("invoiced", String(filters.invoiced));
    if (filters.sort) qs.set("sort", filters.sort);
    if (filters.skip !== undefined) qs.set("skip", String(filters.skip));
    if (filters.take !== undefined) qs.set("take", String(filters.take));

    return this.request<DetailedReport>(`/api/v1/reports/detailed?${qs.toString()}`);
  }

  /**
   * Display name -> opaque id, for one kind of thing, over a date range.
   *
   * Report filters take ids, but a person asks about "Matthew", not about
   * user_k2m9…. Projects and clients have list endpoints to look ids up in;
   * users do not — the public API deliberately exposes no /users route — so
   * the summary report doubles as the directory, since every group it returns
   * carries both the id and the name. The set it covers is whoever logged
   * time in the window, which is the only set worth filtering on anyway.
   *
   * Names are normalised (lowercased, whitespace collapsed) because the app
   * builds them from separate first and last name fields and a missing
   * surname leaves a double space behind.
   */
  async entityIdsByName(
    groupBy: ReportGroupBy,
    from: string,
    to: string,
  ): Promise<Map<string, { id: PublicId; name: string }>> {
    const report = await this.summaryReport(groupBy, { from, to });
    const byName = new Map<string, { id: PublicId; name: string }>();

    for (const group of report?.groups ?? []) {
      const id = group.entity?.id;
      const name = group.entity?.name;
      if (!id || !name) continue;
      byName.set(normaliseName(name), { id, name: name.replace(/\s+/g, " ").trim() });
    }

    return byName;
  }
}

/** Lowercase, single-spaced, trimmed — see entityIdsByName. */
export function normaliseName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function formatDuration(seconds: number): string {
  // Rounded to whole minutes first, then split. Rounding the remainder on its
  // own lets 59.6 minutes print as "60m", so totals came out as "143h 60m".
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function describeEntry(entry: TimeEntry): string {
  const parts = [
    entry.description || "(no description)",
    entry.project?.name ? `on ${entry.project.name}` : null,
    entry.task?.name ? `/ ${entry.task.name}` : null,
    entry.isRunning ? "(running)" : formatDuration(entry.durationSeconds),
  ].filter(Boolean);
  return parts.join(" ");
}
