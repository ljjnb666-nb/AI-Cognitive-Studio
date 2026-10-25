import { describe, expect, it } from "vitest";
import { readEnvironment, type Environment } from "@ai-cognitive/shared/server";
import {
  DOCLING_LAYOUT_QUEUE,
  doclingLayoutJobId,
  resolveDoclingBackgroundExecutor,
} from "../src/docling-layout.js";

describe("isolated Docling layout background admission",()=>{
  it("is off by default and does not require a Docling installation",async()=>{
    const env=readEnvironment({
      DATABASE_URL:"postgresql://local:local@localhost:5432/testing",
      REDIS_URL:"redis://localhost:6379",
    });
    expect(env.DOCLING_LAYOUT_ENABLED).toBe(false);
    await expect(resolveDoclingBackgroundExecutor(env)).resolves.toBeNull();
  });

  it("requires an explicit opt-in; orphan model paths are rejected",async()=>{
    const env={
      DOCLING_LAYOUT_ENABLED:false,
      DOCLING_LAYOUT_PYTHON_PATH:"/synthetic/python",
      DOCLING_LAYOUT_ARTIFACTS_PATH:"/synthetic/assets",
    } as Environment;
    await expect(resolveDoclingBackgroundExecutor(env))
      .rejects.toThrow("DOCLING_LAYOUT_DISABLED_WITH_CONFIG");
  });

  it("enabled but unavailable local runtime fails before queue construction",async()=>{
    const env={
      DOCLING_LAYOUT_ENABLED:true,
      DOCLING_LAYOUT_PYTHON_PATH:"/this/path/does/not/exist",
      DOCLING_LAYOUT_ARTIFACTS_PATH:"/models/not/available",
    } as Environment;
    await expect(resolveDoclingBackgroundExecutor(env))
      .rejects.toThrow("DOCLING_LAYOUT_PYTHON_UNAVAILABLE");
  });

  it("stable queue/job IDs use run, physical page and verified model only",()=>{
    const sha="a".repeat(64);
    const input={ingestionRunId:"run-A_123",physicalPageIndex:7,modelSha256:sha};
    expect(DOCLING_LAYOUT_QUEUE).toBe("source.docling-layout-candidate.v1");
    expect(doclingLayoutJobId(input)).toBe("run-A_123-7-"+sha);
    expect(doclingLayoutJobId(input)).toBe(doclingLayoutJobId({...input}));
    expect(doclingLayoutJobId({...input,physicalPageIndex:8})).not.toEqual(doclingLayoutJobId(input));
    expect(()=>doclingLayoutJobId({...input,ingestionRunId:"run:unsafe"}))
      .toThrow("DOCLING_LAYOUT_JOB_IDENTITY_INVALID");
    expect(()=>doclingLayoutJobId({...input,physicalPageIndex:-1}))
      .toThrow("DOCLING_LAYOUT_JOB_IDENTITY_INVALID");
    expect(()=>doclingLayoutJobId({...input,modelSha256:"spoofed"}))
      .toThrow("DOCLING_LAYOUT_JOB_IDENTITY_INVALID");
  });
});
