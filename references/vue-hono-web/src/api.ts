import type { AppType } from "@boringparts/reference-hono-api";

type HealthResponse = AppType extends object
  ? { readonly status: string }
  : never;

export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health");

  if (!response.ok) {
    throw new Error(`Health check failed with ${response.status}`);
  }

  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("status" in body) ||
    typeof body.status !== "string"
  ) {
    throw new Error("Health check response must include a string status");
  }

  return { status: body.status };
}
