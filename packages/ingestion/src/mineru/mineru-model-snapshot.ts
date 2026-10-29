import { constants } from "node:fs";
import { copyFile, mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { verifyMineruStandardModels, type MineruStandardAdmissionConfig } from "./mineru-standard-admission.js";

/** Copy only release-approved assets into an application-generated claim root.
 * The engines read the verified copy, never the mutable operator cache. */
export async function snapshotMineruStandardModels(root:string, target:string, admission:MineruStandardAdmissionConfig, signal:AbortSignal):Promise<void> {
  signal.throwIfAborted();
  const before=await verifyMineruStandardModels(root,admission);
  if(!before.ok) throw new Error("OCR_STANDARD_MODEL_SNAPSHOT_REJECTED");
  await mkdir(target,{recursive:false});
  for(const file of admission.manifest.files){
    signal.throwIfAborted();
    const destination=join(target,...file.path.split("/"));
    await mkdir(dirname(destination),{recursive:true});
    await copyFile(join(root,...file.path.split("/")),destination,constants.COPYFILE_EXCL);
    await chmod(destination,0o444);
  }
  signal.throwIfAborted();
  const after=await verifyMineruStandardModels(target,admission);
  if(!after.ok) throw new Error("OCR_STANDARD_MODEL_SNAPSHOT_REJECTED");
}
