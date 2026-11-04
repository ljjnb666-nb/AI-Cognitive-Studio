import { afterEach, describe, expect, it, vi } from "vitest";
const mail = vi.hoisted(() => ({ sendMail: vi.fn(), close: vi.fn(), createTransport: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: mail.createTransport } }));
import { authMailConfigured, sendAuthMail } from "../lib/auth-mail";
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
function configured() {
  vi.stubEnv("SMTP_HOST", "smtp.example.test"); vi.stubEnv("SMTP_FROM", "accounts@example.test");
  vi.stubEnv("BETTER_AUTH_URL", "https://studio.example.test"); vi.stubEnv("SMTP_PORT", "587");
  mail.createTransport.mockReturnValue({ sendMail: mail.sendMail, close: mail.close });
}
describe("account recovery mail", () => {
  it("does not pretend recovery is available without a mail service", () => {
    expect(authMailConfigured({ NODE_ENV: "test" })).toBe(false);
  });
  it("requires the canonical auth URL before connecting to SMTP", async () => {
    configured();
    await expect(sendAuthMail("user@example.test", "https://evil.example/reset", "reset")).rejects.toThrow("AUTH_MAIL_LINK_INVALID");
    expect(mail.createTransport).not.toHaveBeenCalled();
  });
  it("uses TLS, bounded timeouts and text-only mail, and closes the transport", async () => {
    configured(); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SMTP_REQUIRE_TLS", "false");
    await sendAuthMail("user@example.test", "https://studio.example.test/api/auth/reset-password/token", "reset");
    expect(mail.createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, socketTimeout: 10000, disableFileAccess: true, disableUrlAccess: true }));
    expect(mail.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "user@example.test", text: expect.stringContaining("https://studio.example.test/api/auth/") }));
    expect(mail.close).toHaveBeenCalledOnce();
  });
  it("sanitizes SMTP failures without returning credentials or reset tokens", async () => {
    configured(); mail.sendMail.mockRejectedValue(new Error("secret-password and reset-token"));
    await expect(sendAuthMail("user@example.test", "https://studio.example.test/api/auth/reset-password/token", "reset")).rejects.toThrow(/^AUTH_MAIL_DELIVERY_FAILED$/);
    expect(mail.close).toHaveBeenCalledOnce();
  });
});
