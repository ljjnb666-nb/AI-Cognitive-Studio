/**
 * Browser-only copy and advisory rendering policy for the product-identity UI.
 * It never classifies ISBN, edits Work/Edition, or grants write authority.
 */
export const previewStateCopy = {
  UNSUPPORTED_FORMAT: "仅 EPUB 支持此书籍身份确认流程",
  NO_CURRENT_EXTRACTION: "当前尚无可使用的解析结果",
  QUALITY_NOT_PROMOTABLE: "当前解析质量不满足书籍身份写入要求",
  SUPERSEDED: "已有更新版本，当前版本不能确认",
  CANDIDATE_UNAVAILABLE: "当前解析没有可使用的书籍身份候选数据",
  ALREADY_RECORDED: "当前解析的书籍身份已记录",
  MISSING_TITLE: "未获取到有效书名，无法创建新的书籍记录",
  READY: "已获取书籍身份候选信息，请核对后手动确认",
} as const;

export type ProductIdentityPreviewState = keyof typeof previewStateCopy;
export type ProductIdentityOutcomeStatus = "APPLIED" | "NOOP" | "CONFLICT" | "BLOCKED" | "STALE" | "SUPERSEDED";

export type ProductIdentityPreview = {
  sourceDocumentId: string;
  latestSourceDocumentId: string;
  currentExtractionId: string | null;
  qualityStatus: string | null;
  state: ProductIdentityPreviewState;
  canWrite: boolean;
  canPromote: boolean;
  candidate: {
    title: { value: string; sourceField: "dc:title" } | null;
    language: { value: string; sourceField: "dc:language" } | null;
    identifier: { value: string; sourceField: "dc:identifier"; classification: string } | null;
  } | null;
  product: {
    workId: string;
    editionId: string;
    title: string;
    language: string | null;
    isbn10: string | null;
    isbn13: string | null;
    workUpdatedAt: string;
    editionUpdatedAt: string;
  } | null;
  recentCorrections: Array<{
    id: string;
    actorUserId: string;
    reason: string;
    changes: unknown;
    createdAt: string;
  }>;
  promotion: {
    status: "APPLIED" | "NOOP" | "CONFLICT" | "BLOCKED";
    reasonCode: string | null;
    appliedFields: unknown;
    conflicts: unknown;
    ignoredFields: unknown;
  } | null;
};

export const outcomeCopy: Record<ProductIdentityOutcomeStatus, string> = {
  APPLIED: "书籍身份已写入，详情已重新核对。",
  NOOP: "当前信息已一致，没有需要写入的字段。",
  CONFLICT: "候选信息与已有记录冲突，本次未改写任何已有字段。",
  BLOCKED: "缺少必要数据，未创建或修改书籍记录。",
  STALE: "解析结果已更新，本次没有写入。请重新核对最新候选信息。",
  SUPERSEDED: "书籍已有新版本，旧版本未被写入。请切换到最新版本。",
};

export function canConfirmProductIdentity(preview: ProductIdentityPreview | null): boolean {
  return preview !== null &&
    preview.canWrite &&
    preview.canPromote &&
    preview.state === "READY" &&
    Boolean(preview.currentExtractionId) &&
    preview.sourceDocumentId === preview.latestSourceDocumentId;
}

/**
 * Confirmation is deliberately conservative: identifiers are raw dc:identifier
 * evidence, NOT client-verified ISBN values. The server decides what qualifies.
 */
export function plannedIdentityChanges(preview: ProductIdentityPreview): string[] {
  const candidate = preview.candidate;
  if (!preview.product) {
    return [
      "创建一条书籍（Work）与版本（Edition）记录并关联此文件",
      "写入有效候选书名",
      ...(candidate?.language ? ["仅在语言格式有效时写入语言"] : []),
      ...(candidate?.identifier ? ["仅在服务端判定为有效 ISBN 时写入对应 ISBN"] : []),
    ];
  }
  const result: string[] = [];
  if (!preview.product.language && candidate?.language) result.push("仅当已有语言为空且候选值有效时，补全语言");
  if ((!preview.product.isbn10 || !preview.product.isbn13) && candidate?.identifier) {
    result.push("仅当对应 ISBN 字段为空且服务端验证通过时，补全 ISBN");
  }
  if (result.length === 0) result.push("核对现有信息；若无可补全字段则不修改");
  result.push("现有书名、语言及 ISBN 不会被自动覆盖；任何字段冲突将整体拒绝写入");
  return result;
}

export function productIdentityHttpMessage(status: number, code?: string): string {
  if (status === 401) return "登录已失效，请重新登录后查看书籍身份。";
  if (status === 403) return "当前账号没有这项操作的权限。";
  if (status === 404) return "书籍不存在或当前工作区无权访问。";
  if (status === 409) return "当前书籍身份已变化或不满足确认条件，请重新获取数据。";
  if (status === 422) return "候选信息不满足写入要求，本次没有写入。";
  if (code === "PRODUCT_IDENTITY_ORIGIN_DENIED") return "页面来源验证失败，请从正式站点重新打开。";
  return "书籍身份服务暂时不可用，请稍后重新检查。";
}

export function isProductIdentityOutcome(value: unknown): value is ProductIdentityOutcomeStatus {
  return typeof value === "string" &&
    ["APPLIED", "NOOP", "CONFLICT", "BLOCKED", "STALE", "SUPERSEDED"].includes(value);
}

export function identityFieldLabel(field: string): string {
  const names: Record<string, string> = {
    "source.editionId": "文件关联版本",
    "work.title": "书名",
    "edition.language": "语言",
    "edition.isbn10": "ISBN-10",
    "edition.isbn13": "ISBN-13",
    identifier: "原始标识符",
    language: "语言",
  };
  return names[field] ?? "其他字段";
}

export function identityIgnoredReason(reason: string): string {
  const reasons: Record<string, string> = {
    INVALID_LANGUAGE: "语言格式不符合要求",
    UNCLASSIFIED_IDENTIFIER: "原始标识符无法确认为 ISBN",
    INVALID_EXPLICIT_ISBN: "ISBN 格式、标签或校验位不合法",
  };
  return reasons[reason] ?? "未满足自动写入规则";
}


/** Advisory only: the server enforces all membership, ownership and revision fences. */
export const manualIdentityFields = [
  { field: "title", label: "正式书名" },
  { field: "language", label: "语言" },
  { field: "isbn10", label: "ISBN-10" },
  { field: "isbn13", label: "ISBN-13" },
] as const;
export type ManualIdentityField = typeof manualIdentityFields[number]["field"];
export type ManualIdentityDraft = Record<ManualIdentityField, string>;
type SavedProduct = NonNullable<ProductIdentityPreview["product"]>;

export function canEditProductIdentity(preview: ProductIdentityPreview): boolean {
  return preview.canWrite && preview.product !== null && !!preview.currentExtractionId &&
    preview.sourceDocumentId === preview.latestSourceDocumentId &&
    preview.state !== "UNSUPPORTED_FORMAT" && preview.state !== "SUPERSEDED" &&
    preview.state !== "NO_CURRENT_EXTRACTION" &&
    !!preview.product.workUpdatedAt && !!preview.product.editionUpdatedAt;
}

export function identityDraft(product: SavedProduct): ManualIdentityDraft {
  return {
    title: product.title,
    language: product.language ?? "",
    isbn10: product.isbn10 ?? "",
    isbn13: product.isbn13 ?? "",
  };
}

/** Diff only: never send untouched fields, and never translate an empty input into a clearing operation. */
export function manualIdentityChanges(product: SavedProduct, draft: ManualIdentityDraft):
  Partial<Record<ManualIdentityField, string>> {
  const before = identityDraft(product);
  const result: Partial<Record<ManualIdentityField, string>> = {};
  for (const { field } of manualIdentityFields) {
    const value = draft[field].trim();
    if (value !== before[field]) result[field] = value;
  }
  return result;
}

export function manualIdentityFormError(changes: Partial<Record<ManualIdentityField, string>>, reason: string): string | null {
  if (Object.keys(changes).length === 0) return "未修改任何字段，无需提交。";
  if (Object.values(changes).some((value) => !value)) return "不能将正式身份字段清空，请填写非空内容。";
  if (changes.title && changes.title.length > 255) return "正式书名不能超过 255 个字符。";
  if (reason.trim().length < 3 || reason.trim().length > 500) return "请填写 3 至 500 个字符的修正原因。";
  return null;
}

export function manualIdentityOutcomeMessage(status: unknown, httpStatus: number): string {
  if (status === "APPLIED" && httpStatus >= 200 && httpStatus < 300) return "人工修正已保存，正在重新读取正式书名和审计记录。";
  if (status === "NOOP" && httpStatus >= 200 && httpStatus < 300) return "保存结果无变更，已重新检查正式信息。";
  if (status === "CONFLICT") return "正式书籍信息已被其他操作修改；本次不会覆盖已有字段。已重新读取最新数据，请重新核对。";
  if (status === "STALE") return "当前解析已更新，旧版本修正未写入。请重新核对。";
  if (status === "SUPERSEDED") return "源文件已出现新版本，旧版本修正未写入。请切换到最新文件。";
  if (httpStatus === 400 || httpStatus === 422) return "输入不符合服务端校验要求，本次没有保存。请检查书名、语言、ISBN 和修正原因。";
  return productIdentityHttpMessage(httpStatus);
}

export type ManualIdentityAuditChange = { field: string; before: string | null; after: string };
export function manualIdentityAuditChanges(raw: unknown): ManualIdentityAuditChange[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const permitted = ["work.title", "edition.language", "edition.isbn10", "edition.isbn13"];
  const record = raw as Record<string, unknown>;
  return permitted.flatMap((field) => {
    const item = record[field];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const pair = item as Record<string, unknown>;
    if ((pair.before !== null && typeof pair.before !== "string") || typeof pair.after !== "string") return [];
    return [{ field, before: pair.before as string | null, after: pair.after }];
  });
}
