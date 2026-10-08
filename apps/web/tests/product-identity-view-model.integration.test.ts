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
      product: { workId: "w", editionId: "e", title: "原始书名", language: "en", isbn10: "0306406152", isbn13: "9780306406157" },
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
