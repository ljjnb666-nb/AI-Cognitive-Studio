import { describe, expect, it } from "vitest";
import {
  canConfirmProductIdentity,
  identityFieldLabel,
  isProductIdentityOutcome,
  outcomeCopy,
  plannedIdentityChanges,
  previewStateCopy,
  productIdentityHttpMessage,
  type ProductIdentityPreview,
  canEditProductIdentity,
  identityDraft,
  manualIdentityChanges,
  manualIdentityFormError,
  manualIdentityOutcomeMessage,
  manualIdentityAuditChanges,
} from "../lib/product-identity-view-model";

function preview(overrides: Partial<ProductIdentityPreview> = {}): ProductIdentityPreview {
  return {
    sourceDocumentId: "document-a",
    latestSourceDocumentId: "document-a",
    currentExtractionId: "extraction-a",
    qualityStatus: "ACCEPTED",
    state: "READY",
    canWrite: true,
    canPromote: true,
    candidate: {
      title: { value: "我的书", sourceField: "dc:title" },
      language: { value: "zh-CN", sourceField: "dc:language" },
      identifier: { value: "urn:isbn:978-0-306-40615-7", sourceField: "dc:identifier", classification: "UNCLASSIFIED" },
    },
    product: null,
    recentCorrections: [],
    promotion: null,
    ...overrides,
  };
}

describe("04C-4C2 product identity UI presentation policy", () => {
  it("allows only current, writable, READY previews with an observed extraction", () => {
    expect(canConfirmProductIdentity(preview())).toBe(true);
    expect(canConfirmProductIdentity(preview({ canWrite: false }))).toBe(false);
    expect(canConfirmProductIdentity(preview({ canPromote: false }))).toBe(false);
    expect(canConfirmProductIdentity(preview({ currentExtractionId: null }))).toBe(false);
    expect(canConfirmProductIdentity(preview({ latestSourceDocumentId: "newer-version" }))).toBe(false);
    expect(canConfirmProductIdentity(null)).toBe(false);
  });

  it.each(Object.keys(previewStateCopy) as Array<keyof typeof previewStateCopy>)(
    "never enables confirmation when preview state is %s unless READY",
    (state) => {
      expect(canConfirmProductIdentity(preview({ state }))).toBe(state === "READY");
      expect(previewStateCopy[state].length).toBeGreaterThan(3);
    },
  );

  it("never describes candidate identifiers as already verified ISBN", () => {
    const changes = plannedIdentityChanges(preview());
    expect(changes).toContain("仅在服务端判定为有效 ISBN 时写入对应 ISBN");
    expect(changes.join(" ")).not.toContain("覆盖");
  });

  it("never advertises overwriting existing product identity", () => {
    const changes = plannedIdentityChanges(preview({
      product: { workId: "w", editionId: "e", title: "原始书名", language: "en", isbn10: "0306406152", isbn13: "9780306406157", workUpdatedAt: "2026-10-08T00:00:00.000Z", editionUpdatedAt: "2026-10-08T00:00:00.000Z" },
    }));
    expect(changes.join(" ")).toContain("不会被自动覆盖");
    expect(changes.join(" ")).not.toContain("创建一条书籍");
    expect(changes).toContain("核对现有信息；若无可补全字段则不修改");
  });

  it.each([401, 403, 404, 409, 422, 500])("localizes HTTP failure %s", (status) => {
    expect(productIdentityHttpMessage(status)).toMatch(/[，。]/);
  });

  it.each(["APPLIED", "NOOP", "CONFLICT", "BLOCKED", "STALE", "SUPERSEDED"] as const)(
    "provides a distinct Chinese outcome for %s",
    (status) => {
      expect(isProductIdentityOutcome(status)).toBe(true);
      expect(outcomeCopy[status].length).toBeGreaterThan(5);
    },
  );

  it("does not interpret arbitrary untrusted JSON as a promotion result", () => {
    expect(isProductIdentityOutcome("not-real")).toBe(false);
    expect(isProductIdentityOutcome({ status: "APPLIED" })).toBe(false);
    expect(identityFieldLabel("edition.isbn13")).toBe("ISBN-13");
  });
});


describe("04C-4C4B manual correction browser-only presentation model", () => {
  const saved = {
    workId: "work-1", editionId: "edition-1", title: "正式旧书名",
    language: "zh-CN", isbn10: null, isbn13: "9780306406157",
    workUpdatedAt: "2026-10-08T00:00:00.000Z",
    editionUpdatedAt: "2026-10-08T00:00:00.000Z",
  };
  it("allows editing bound current authoritative identity even when EPUB promotion is already recorded", () => {
    expect(canEditProductIdentity(preview({ product: saved, state: "ALREADY_RECORDED", canPromote: false }))).toBe(true);
    expect(canEditProductIdentity(preview({ product: saved, canWrite: false }))).toBe(false);
    expect(canEditProductIdentity(preview({ product: saved, latestSourceDocumentId: "other" }))).toBe(false);
    expect(canEditProductIdentity(preview({ product: saved, currentExtractionId: null }))).toBe(false);
    expect(canEditProductIdentity(preview({ product: saved, state: "UNSUPPORTED_FORMAT" }))).toBe(false);
    expect(canEditProductIdentity(preview())).toBe(false);
  });
  it("sends only actual changed fields with no implicit clearing and keeps the full snapshot available", () => {
    const draft = { ...identityDraft(saved), title: " 新书名 ", isbn10: "0306406152" };
    const changes = manualIdentityChanges(saved, draft);
    expect(changes).toEqual({ title: "新书名", isbn10: "0306406152" });
    expect(manualIdentityFormError(changes, "对照出版社版权页")).toBeNull();
    expect(manualIdentityChanges(saved, identityDraft(saved))).toEqual({});
    expect(manualIdentityFormError({}, "对照出版社版权页")).toContain("未修改");
    expect(manualIdentityFormError({ title: "" }, "对照出版社版权页")).toContain("不能");
    expect(manualIdentityFormError({ title: "新书名" }, "x")).toContain("原因");
  });
  it("never claims success for inconsistent response statuses or unknown transport outcomes", () => {
    expect(manualIdentityOutcomeMessage("APPLIED", 409)).not.toContain("已保存");
    expect(manualIdentityOutcomeMessage("APPLIED", 200)).toContain("已保存");
    expect(manualIdentityOutcomeMessage("CONFLICT", 409)).toContain("不会覆盖");
    expect(manualIdentityOutcomeMessage("STALE", 409)).toContain("解析");
    expect(manualIdentityOutcomeMessage("SUPERSEDED", 409)).toContain("新版本");
    expect(manualIdentityOutcomeMessage(undefined, 400)).toContain("输入");
  });
  it("shows only known database audit field pairs, never raw JSON blobs", () => {
    expect(manualIdentityAuditChanges({
      "work.title": { before: "旧", after: "新" },
      "edition.isbn10": { before: null, after: "0306406152" },
      invalid: { before: "secret", after: "secret" },
      "edition.isbn13": { before: 123, after: "invalid" },
    })).toEqual([
      { field: "work.title", before: "旧", after: "新" },
      { field: "edition.isbn10", before: null, after: "0306406152" },
    ]);
    expect(manualIdentityAuditChanges(null)).toEqual([]);
  });
});
