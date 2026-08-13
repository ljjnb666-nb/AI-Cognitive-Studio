import {PageHeader} from "@/components/app-shell";import {GenerationForm} from "@/components/generation-form";import {sources} from "@/lib/product";
export default async function NewVideo(){return <><PageHeader title="生成短视频" description="直接基于 Book Intelligence，不依赖播客脚本。"/><GenerationForm kind="video" sources={await sources()}/></>}
