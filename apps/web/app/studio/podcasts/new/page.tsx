import {PageHeader} from "@/components/app-shell";import {GenerationForm} from "@/components/generation-form";import {sources} from "@/lib/product";
export default async function NewPodcast(){return <><PageHeader title="生成播客" description="只使用已完成理解的书，并保留版本化风格配置。"/><GenerationForm kind="podcast" sources={await sources()}/></>}
