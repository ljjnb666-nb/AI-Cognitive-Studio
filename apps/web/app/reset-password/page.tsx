import { PasswordRecovery } from "@/components/password-recovery";
import { authMailConfigured } from "@/lib/auth-mail";
export const metadata = { referrer: "no-referrer" as const };
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  return <PasswordRecovery token={typeof query.token === "string" ? query.token : undefined} available={authMailConfigured()} />;
}
