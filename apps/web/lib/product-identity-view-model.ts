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
  } | null;
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
