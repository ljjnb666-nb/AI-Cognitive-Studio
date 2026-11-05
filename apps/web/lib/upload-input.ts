const mediaTypes = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  txt: "text/plain",
  md: "text/markdown",
} as const;

/** Windows ebook applications can register EPUB with this nonstandard MIME type. */
export function normalizeUploadMediaType(value: unknown) {
  return value === "application/epub" ? "application/epub+zip" : value;
}

/** The server independently inspects the uploaded bytes before publishing a source. */
export function uploadMediaType(file: { name: string; type: string }): string | null {
  if (/\.mobi$/i.test(file.name) || file.type === "application/x-mobipocket-ebook") return null;
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (extension && Object.hasOwn(mediaTypes, extension)) {
    return mediaTypes[extension as keyof typeof mediaTypes];
  }
  const type = normalizeUploadMediaType(file.type.toLowerCase());
  return Object.values(mediaTypes).some((supported) => supported === type) ? String(type) : null;
}

export function unsupportedUploadCode(file: { name: string; type: string }) {
  return /\.mobi$/i.test(file.name) || file.type === "application/x-mobipocket-ebook" ? "UNSUPPORTED_MOBI" : "UNSUPPORTED_MEDIA_TYPE";
}
