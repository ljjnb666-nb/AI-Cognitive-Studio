import { NextResponse } from "next/server";
import { prisma } from "@ai-cognitive/db";
import { resolveWebIdentity } from "@/lib/identity";
import { storage } from "@/lib/storage";

export async function GET(_request:Request,{params}:{params:Promise<{kind:string;id:string}>}){try{const {kind,id}=await params;const identity=await resolveWebIdentity();let key:string|undefined;if(kind==="audio"){key=(await prisma.podcastAudioRevision.findFirst({where:{id,workspaceId:identity.workspaceId},select:{storageKey:true}}))?.storageKey}else if(kind==="video"){key=(await prisma.shortVideoRevision.findFirst({where:{id,workspaceId:identity.workspaceId},select:{storageKey:true}}))?.storageKey}if(!key)return NextResponse.json({error:"MEDIA_ACCESS_DENIED"},{status:404});const bytes=await storage().getObjectBytes(key);const body:BodyInit=new Uint8Array(bytes);return new NextResponse(body,{headers:{"content-type":kind==="audio"?"audio/wav":"video/mp4","content-disposition":"inline"}})}catch{return NextResponse.json({error:"MEDIA_ACCESS_DENIED"},{status:403})}}
