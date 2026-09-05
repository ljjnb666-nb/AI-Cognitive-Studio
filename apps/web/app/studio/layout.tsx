import { AppShell } from "@/components/app-shell";
import { resolveWebIdentity } from "@/lib/identity";
import { redirect } from "next/navigation";

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  try {
    await resolveWebIdentity();
  } catch (error) {
    if (error instanceof Error && error.message === "BETA_ACCESS_REQUIRED") redirect("/beta/access");
    if (process.env.NODE_ENV === "production") {
      redirect("/sign-in");
    }
  }
  return <AppShell>{children}</AppShell>;
}
