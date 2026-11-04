import { resolveSessionUserId } from "@/lib/identity";
import { exportPersonalRecords } from "@/lib/personal-export";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
export async function GET() {
  try {
    const userId = await resolveSessionUserId();
    const json = await exportPersonalRecords(userId);
    return new Response(json, { headers: { ...headers, "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="studio-personal-learning-records.json"' } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code === "WEB_IDENTITY_REQUIRED" ? 401 : code === "PERSONAL_EXPORT_TOO_LARGE" ? 413 : code === "PERSONAL_EXPORT_BUSY" ? 429 : 503;
    return Response.json({ error: status === 401 ? "AUTHENTICATION_REQUIRED" : status === 413 || status === 429 ? code : "PERSONAL_EXPORT_UNAVAILABLE" }, { status, headers: { ...headers, ...(status === 429 ? { "retry-after": "10" } : {}) } });
  }
}
