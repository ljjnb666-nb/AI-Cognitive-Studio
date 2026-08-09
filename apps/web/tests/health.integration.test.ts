import { describe, expect, it } from "vitest";
import { GET } from "../app/api/health/route";

describe("GET /api/health", () => {
  it("returns the Web service health contract", async () => {
    const response = GET();

    await expect(response.json()).resolves.toEqual({ status: "ok", service: "web" });
    expect(response.status).toBe(200);
  });
});
