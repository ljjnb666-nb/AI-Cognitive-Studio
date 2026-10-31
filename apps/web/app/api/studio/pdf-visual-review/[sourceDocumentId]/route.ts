import {NextResponse} from "next/server";
import {z} from "zod";
import {auth} from "@/lib/auth";
import {resolveWebIdentity} from "@/lib/identity";
import {productIdentityMutationOriginAllowed} from "@/lib/product-identity-api-policy";
import {requestOcrModelReview,OCR_MODEL_REVIEW_CONSENT} from "@ai-cognitive/ingestion";
const body=z.strictObject({ingestionRunId:z.string().cuid(),physicalPageIndex:z.number().int().min(0).max(1999),receiptId:z.string().cuid(),textSha256:z.string().regex(/^[a-f0-9]{64}$/),sourcePdfSha256:z.string().regex(/^[a-f0-9]{64}$/),consent:z.literal(OCR_MODEL_REVIEW_CONSENT),previousFailedJobId:z.string().cuid().optional()});
export async function POST(request:Request,{params}:{params:Promise<{sourceDocumentId:string}>}) {
 try {
  if(process.env.PDF_VISUAL_REVIEW_ON_DEMAND_ENABLED!=="true")return NextResponse.json({error:"OCR_REVIEW_DISABLED"},{status:403});
  if(!productIdentityMutationOriginAllowed(request.headers.get("origin"),process.env.BETTER_AUTH_URL))return NextResponse.json({error:"OCR_REVIEW_ORIGIN_REQUIRED"},{status:403});
  const session=await auth.api.getSession({headers:request.headers,query:{disableCookieCache:true}});
  if(!session?.user?.id)return NextResponse.json({error:"WEB_IDENTITY_REQUIRED"},{status:401});
  const identity=await resolveWebIdentity();if(identity.userId!==session.user.id)throw new Error("OCR_REVIEW_FORBIDDEN");
  const input=body.parse(await request.json());const {sourceDocumentId}=await params;
  return NextResponse.json(await requestOcrModelReview({...input,sourceDocumentId,workspaceId:identity.workspaceId,userId:identity.userId}));
 }catch{return NextResponse.json({error:"OCR_REVIEW_REQUEST_REJECTED"},{status:409});}
}
