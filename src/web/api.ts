export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function handle<T>(url: string, response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || body.ok === false) {
    throw new ApiError(response.status, body, String(body.error || `${url} failed (${response.status})`));
  }
  return body as T;
}

export async function apiGet<T>(url: string): Promise<T> {
  return handle<T>(url, await fetch(`${API_BASE_URL}${url}`));
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  return handle<T>(
    url,
    await fetch(`${API_BASE_URL}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {})
    })
  );
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    const running = error.body.running as { experimentId?: string } | undefined;
    return `The runner is busy with ${running?.experimentId || "another experiment"}. Try again in a moment.`;
  }
  return error instanceof Error ? error.message : String(error);
}
