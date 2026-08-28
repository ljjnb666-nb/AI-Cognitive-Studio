import { PageHeader } from "@/components/app-shell";
import { GenerationForm } from "@/components/generation-form";
import { sources } from "@/lib/product";
import { resolveWebIdentity } from "@/lib/identity";
import { providerReadiness } from "@/lib/provider-product";

export default async function NewVideoPage() {
  const context = await resolveWebIdentity();
  const readiness = await providerReadiness(context.workspaceId);

  return (
    <div>
      <PageHeader title="生成短视频" description="只使用已完成理解的书，从观点提炼镜头与旁白。" />
      <GenerationForm kind="video" sources={await sources(context)} readiness={readiness.shortVideo} />
    </div>
  );
}
