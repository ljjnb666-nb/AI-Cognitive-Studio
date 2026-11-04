import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "../packages/db/src/index.js";
import { VersionedAesGcmCipher, type EncryptedCredential } from "../packages/provider-gateway/src/index.js";
import { S3CompatibleStorageProvider } from "../packages/storage/src/index.js";

// Run only against a quiescent, disposable test database. Never restores in place.
const sourceUrl = process.env.DATABASE_URL_TEST;
if (!sourceUrl || !new URL(sourceUrl).pathname.endsWith("_test")) throw new Error("RESTORE_REHEARSAL_REQUIRES_TEST_DATABASE");
const project = process.env.RESTORE_COMPOSE_PROJECT ?? "ai-cognitive-studio";
const execute = promisify(execFile), nonce = randomUUID().replaceAll("-", "");
const restoredName = `acs_restore_${nonce}_test`, canaryTable = `restore_canary_${nonce}`;
const directory = resolve("output", "restore", nonce), remoteDump = `/tmp/acs-restore-${nonce}.dump`;
await mkdir(directory, { recursive: true });
const docker = (...args: string[]) => execute("docker", ["compose", "-p", project, "exec", "-T", "postgres", ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
const source = new PrismaClient({ datasourceUrl: sourceUrl });
const restoredUrl = new URL(sourceUrl); restoredUrl.pathname = `/${restoredName}`;
const restored = new PrismaClient({ datasourceUrl: restoredUrl.toString() });
const storage = new S3CompatibleStorageProvider({ endpoint: process.env.S3_ENDPOINT!, region: process.env.S3_REGION ?? "us-east-1", bucket: process.env.S3_BUCKET!, accessKey: process.env.S3_ACCESS_KEY!, secretKey: process.env.S3_SECRET_KEY!, forcePathStyle: true });
const objectKey = `tests/restore/${nonce}/original`, restoredKey = `tests/restore/${nonce}/restored`;
const key = randomBytes(32), secret = randomBytes(48).toString("base64");
const aad = { workspaceId: nonce, connectionId: nonce, credentialVersionId: nonce, providerKey: "restore-canary" };
let createdDatabase = false, createdCanary = false;
const began = Date.now();
const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function counts(db: PrismaClient) {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const result: Record<string, number> = {};
  for (const { tablename } of tables) {
    const quoted = `"${tablename.replaceAll('"', '""')}"`;
    const [row] = await db.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) AS count FROM ${quoted}`);
    result[tablename] = Number(row!.count);
  }
  return result;
}
try {
  const encrypted = new VersionedAesGcmCipher("canary-v1", new Map([["canary-v1", key]])).encrypt(secret, aad);
  await writeFile(resolve(directory, "canary-key.bin"), key, { mode: 0o600, flag: "wx" });
  await source.$executeRawUnsafe(`CREATE TABLE "${canaryTable}" (payload jsonb NOT NULL)`); createdCanary = true;
  await source.$executeRawUnsafe(`INSERT INTO "${canaryTable}" VALUES ($1::jsonb)`, JSON.stringify(encrypted));
  const before = await counts(source);
  const bytes = randomBytes(4096);
  await storage.putObject({ key: objectKey, body: bytes, contentType: "application/octet-stream" });
  await writeFile(resolve(directory, "object.bin"), await storage.getObjectBytes(objectKey));
  await docker("pg_dump", "-U", "app", "-Fc", "-d", new URL(sourceUrl).pathname.slice(1), "-f", remoteDump);
  await execute("docker", ["compose", "-p", project, "cp", `postgres:${remoteDump}`, resolve(directory, "database.dump")], { windowsHide: true });
  const restoreBegan = Date.now();
  await docker("createdb", "-U", "app", restoredName); createdDatabase = true;
  await docker("pg_restore", "-U", "app", "--exit-on-error", "--no-owner", "-d", restoredName, remoteDump);
  const after = await counts(restored);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("RESTORE_ROW_COUNTS_DIFFER");
  const [canary] = await restored.$queryRawUnsafe<Array<{ payload: EncryptedCredential }>>(`SELECT payload FROM "${canaryTable}"`);
  const recoveredCipher = new VersionedAesGcmCipher("canary-v1", new Map([["canary-v1", await readFile(resolve(directory, "canary-key.bin"))]]));
  if (recoveredCipher.decrypt(canary!.payload, aad) !== secret) throw new Error("RESTORE_KEYRING_VERIFICATION_FAILED");
  await storage.deleteObject(objectKey);
  if (await storage.objectExists(objectKey)) throw new Error("RESTORE_CANARY_DELETE_NOT_VERIFIED");
  await storage.putObject({ key: restoredKey, body: await readFile(resolve(directory, "object.bin")), contentType: "application/octet-stream" });
  if (checksum(await storage.getObjectBytes(restoredKey)) !== checksum(bytes)) throw new Error("RESTORE_OBJECT_CHECKSUM_MISMATCH");
  const report = { status: "PASS", scope: "isolated test database and synthetic object/keyring; not a production RTO guarantee", tablesVerified: Object.keys(before).length, rowsVerified: Object.values(before).reduce((a, b) => a + b, 0), restoreMs: Date.now() - restoreBegan, totalMs: Date.now() - began, objectSha256: checksum(bytes), keyringDecryptVerified: true, sourceDatabase: new URL(sourceUrl).pathname.slice(1), restoredDatabase: restoredName };
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await restored.$disconnect();
  if (createdDatabase) await docker("dropdb", "-U", "app", restoredName);
  if (createdCanary) await source.$executeRawUnsafe(`DROP TABLE "${canaryTable}"`);
  await source.$disconnect();
  await storage.deleteObject(objectKey); await storage.deleteObject(restoredKey);
  await docker("rm", "-f", remoteDump);
}
