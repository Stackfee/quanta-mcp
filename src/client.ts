/**
 * Thin wrapper over the Quanta public API (/api/v1). Everything the MCP tools
 * do goes through here, so the server has no knowledge of Quanta internals.
 */

/**
 * A pointer to another record. `id` is null only when the reference names
 * something that isn't a saved record, which happens on an entries-from-text
 * preview, and for the client on a time entry, which the API returns by name.
 */
export interface EntityRef {
  id: number | null;
  name: string | null;
}

export interface UserRef {
  id: number;
  name: string | null;
}

export interface TimeEntry {
  id: number;
  description: string | null;
  durationSeconds: number;
  startedAt: string | null;
  stoppedAt: string | null;
  isRunning: boolean;
  billable: boolean;
  project: EntityRef | null;
  task: EntityRef | null;
  client: EntityRef | null;
  tags: EntityRef[];
  user: UserRef | null;
}

export interface Project {
  id: number;
  name: string;
  code: string | null;
  client: EntityRef | null;
  isActive: boolean;
  totalHoursLogged: number;
  tasks: { id: number; name: string; billable: boolean }[];
}

export interface Client {
  id: number;
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

export interface ParsedEntries {
  saved: boolean;
  entries: TimeEntry[];
  error?: string | null;
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
    projectId?: number;
    taskId?: number;
    billable?: boolean;
  }) {
    return this.request<TimeEntry>("/api/v1/timer/start", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  stopTimer() {
    return this.request<TimeEntry>("/api/v1/timer/stop", { method: "POST" });
  }

  listTimeEntries(params: { from?: string; to?: string; take?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    qs.set("take", String(params.take ?? 20));
    return this.request<Paged<TimeEntry>>(`/api/v1/time-entries?${qs.toString()}`);
  }

  createTimeEntry(body: {
    description?: string;
    durationSeconds: number;
    startedAt?: string;
    projectId?: number;
    taskId?: number;
    billable?: boolean;
  }) {
    return this.request<TimeEntry>("/api/v1/time-entries", {
      method: "POST",
      body: JSON.stringify(body),
    });
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

  entryFromText(body: { text: string; localTime?: string; save?: boolean }) {
    return this.request<ParsedEntries>("/api/v1/entries-from-text", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
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
