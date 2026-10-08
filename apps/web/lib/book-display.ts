/**
 * One read-side presentation policy for Source-linked Work/Edition identity.
 *
 * Work.title is authoritative only when this Source has an Edition relation.
 * EPUB extraction dc:title is advisory and MUST NEVER be a library title.
 * SourceDocument.version identifies the file version, not Work/Edition version.
 */
export type BookDisplayProjection = {
  title: string;
  titleOrigin: "WORK" | "FILENAME";
  fileName: string;
  version: number;
  isLatestVersion: boolean;
};

export function projectBookDisplay(input: {
  fileName: string;
  workTitle?: string | null;
  version: number;
  isLatestVersion: boolean;
}): BookDisplayProjection {
  const authoritativeTitle = input.workTitle?.trim() ?? "";
  return {
    title: authoritativeTitle || input.fileName,
    titleOrigin: authoritativeTitle ? "WORK" : "FILENAME",
    fileName: input.fileName,
    version: input.version,
    isLatestVersion: input.isLatestVersion,
  };
}
