import { redirect } from "next/navigation";
import { resolveWebIdentity } from "@/lib/identity";

export default async function HomePage() {
  try {
    await resolveWebIdentity();
  } catch {
    // ignore
  }
  redirect("/studio");
}
