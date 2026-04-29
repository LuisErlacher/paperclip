export type PaperclipClientOptions = {
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

export type HeartbeatRun = { id: string; issueId: string | null; companyId: string };
export type RoutineRun = { id: string; triggerPayload: Record<string, unknown> | null; linkedIssueId: string | null };
export type IssueSummary = {
  id: string;
  description: string | null;
  status: string;
  priority: string | null;
  projectId: string | null;
  companyId: string;
  originRunId?: string | null;
};
export type CreateIssueInput = {
  projectId: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  status?: "todo" | "backlog" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
};

export class PaperclipApiError extends Error {
  constructor(public status: number, public body: string) {
    const preview = body.slice(0, 500) || "(empty response body)";
    super(`Paperclip API ${status}: ${preview}`);
  }
}

export class PaperclipClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PaperclipClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new PaperclipApiError(res.status, await res.text());
    return (await res.json()) as T;
  }

  getHeartbeatRun(runId: string): Promise<HeartbeatRun> {
    return this.request("GET", `/api/heartbeat-runs/${encodeURIComponent(runId)}`);
  }

  getRoutineRun(runId: string): Promise<RoutineRun> {
    return this.request("GET", `/api/routine-runs/${encodeURIComponent(runId)}`);
  }

  /**
   * Fetches an issue. Accepts both `{issue: IssueSummary}` (route-test response shape)
   * and bare `IssueSummary` (real API shape) — kept compatible while routes evolve.
   */
  async getIssue(issueId: string): Promise<IssueSummary> {
    const res = await this.request<{ issue: IssueSummary } | IssueSummary>(
      "GET",
      `/api/issues/${encodeURIComponent(issueId)}`,
    );
    return "issue" in (res as object) ? (res as { issue: IssueSummary }).issue : (res as IssueSummary);
  }

  /**
   * Lists issues filtered by projectId. Accepts both `{items: IssueSummary[]}` and
   * bare arrays — kept compatible while routes evolve.
   */
  async listProjectIssues(companyId: string, projectId: string): Promise<IssueSummary[]> {
    const path = `/api/companies/${encodeURIComponent(companyId)}/issues?projectId=${encodeURIComponent(projectId)}&limit=200`;
    const res = await this.request<{ items: IssueSummary[] } | IssueSummary[]>("GET", path);
    if (Array.isArray(res)) return res;
    return res.items ?? [];
  }

  createIssue(companyId: string, input: CreateIssueInput): Promise<{ id: string }> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/issues`, input);
  }

  addComment(issueId: string, body: string): Promise<{ id: string }> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, { body });
  }

  updateIssue(issueId: string, patch: Partial<{ status: string; priority: string; title: string }>): Promise<{ id: string }> {
    return this.request("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, patch);
  }
}
