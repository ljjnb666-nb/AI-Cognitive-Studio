import "server-only";
import nodemailer from "nodemailer";

export function authMailConfigured(environment: NodeJS.ProcessEnv = process.env) {
  return Boolean(environment.SMTP_HOST && environment.SMTP_FROM);
}

/** Never log a reset URL, verification token, password or SMTP response. */
export async function sendAuthMail(to: string, url: string, purpose: "reset" | "verify") {
  if (!authMailConfigured()) throw new Error("AUTH_MAIL_NOT_CONFIGURED");
  const base = new URL(process.env.BETTER_AUTH_URL!), target = new URL(url);
  if (target.origin !== base.origin || !target.pathname.startsWith("/api/auth/")) throw new Error("AUTH_MAIL_LINK_INVALID");
  const port = Number(process.env.SMTP_PORT ?? 465);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT_INVALID");
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    requireTLS: process.env.NODE_ENV === "production" || process.env.SMTP_REQUIRE_TLS !== "false",
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {}),
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  try {
    await transport.sendMail({ from: process.env.SMTP_FROM, to,
      subject: purpose === "reset" ? "重置 AI Cognitive Studio 密码" : "验证 AI Cognitive Studio 邮箱",
      text: `${purpose === "reset" ? "使用以下链接重置密码" : "使用以下链接验证邮箱"}：\n${target.href}\n\n如果不是你发起的请求，可以忽略此邮件。`,
    });
  } catch { throw new Error("AUTH_MAIL_DELIVERY_FAILED"); }
  finally { transport.close(); }
}
