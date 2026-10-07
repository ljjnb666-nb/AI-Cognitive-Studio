import { inflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import type { Document as XmlDocument, Element as XmlElement, Node as XmlNode } from "@xmldom/xmldom";
import { parseEpubExtractionMetadata } from "@ai-cognitive/domain";
import type {
  BlockExtractionProvenance,
  CanonicalSourceLocator,
  EpubExtractionMetadata,
  EpubNavigationEntry,
  EpubNavigationSource,
  EpubRenditionLayout,
  ExtractionQualityWarningCode,
} from "@ai-cognitive/domain";
import { normalizeCanonicalText, splitCanonicalBlock } from "./canonical-text.js";
import type { Parsed, ParsedBlock, ParserDescriptor, ParserLimits, SourceBlockKind } from "./document-parsers.js";
import { SourceError } from "./source-errors.js";

/**
 * EPUB native ingestion (epub-parser-v2).
 *
 * The ZIP subsystem is authoritative: central-directory and local-header
 * identity, duplicate-name rejection, archive bounds, per-entry/total/compression
 * limits, and encrypted-flag rejection are checked before inflation. v2
 * replaces regex-based structure discovery with namespace-aware XML DOM
 * parsing (@xmldom/xmldom, pure JS, no network, no entity expansion) and adds
 * durable EPUB format metadata, safe archive-relative href resolution, DOM
 * locators (fragmentId + elementPath) and semantic block kinds.
 *
 * RF01 hardening invariants:
 * - XML predefined entities (&amp; &lt; &gt; &quot; &apos;) are NEVER touched
 *   before parsing — only XML-unknown HTML named entities are rewritten, and
 *   only into numeric character references, so escaped markup can never be
 *   re-interpreted as XML grammar. Any parser-reported warning, error or
 *   fatal error fails closed (SOURCE_CORRUPTED).
 * - Resource references (src / href / xlink:href / container full-path) are
 *   validated again AFTER DOM parsing on the DECODED attribute values, so
 *   entity-obfuscated external URLs cannot slip past the raw-text prefilter.
 * - Structure discovery is localName/namespace based: prefixed
 *   container/OPF/nav/NCX/XHTML documents parse identically to their
 *   default-namespace forms.
 * - Unsupported spine reading-order items are tracked (never inflated); a
 *   reflowable book without any usable text fails with
 *   SOURCE_EPUB_NO_USABLE_TEXT instead of the OCR fallback code.
 *
 * Non-negotiables carried over from BOOK-01: no fabricated physical pages
 * (SourcePage stays 0, physicalPageIndex stays null), per-block provenance,
 * qualityStatus UNKNOWN, and fail-closed handling of DOCTYPE/ENTITY and every
 * external resource reference.
 */

const EPUB_OPS_NAMESPACE = "http://www.idpf.org/2007/ops";
const EPUB_RENDITION_NAMESPACE = "http://www.idpf.org/2013/rendition";
const DC_ELEMENTS_NAMESPACE = "http://purl.org/dc/elements/1.1/";
const OPF_MEDIA_TYPE = "application/oebps-package+xml";
const NCX_MEDIA_TYPE = "application/x-dtbncx+xml";
const CONTENT_MEDIA_TYPES = new Set(["application/xhtml+xml", "text/html", "application/x-dtbook+xml"]);
const SVG_MEDIA_TYPE = "image/svg+xml";
const FOOTNOTE_TYPES = new Set(["footnote", "endnote", "footnotes", "endnotes"]);
const BLOCK_PRODUCERS = new Set(["p", "li", "blockquote", "pre", "table", "figcaption", "math", "svg", "img", "h1", "h2", "h3", "h4", "h5", "h6"]);
const CONTAINER_TAGS = new Set(["html", "body", "main", "div", "section", "article", "aside", "nav", "header", "footer", "figure", "ul", "ol", "dl", "details", "center"]);
const SKIPPED_TAGS = new Set(["script", "style", "head", "template"]);
/** Structural navigation failure (never a security issue); degrades to a warning. */
const NAV_STRUCTURAL_FAILURE = "EPUB_NAV_STRUCTURAL_FAILURE";
const MAX_WALK_DEPTH = 256;
const MAX_NAVIGATION_DEPTH = 64;

type ZipEntry = { name: string; method: number; flags: number; compressed: Buffer; compressedSize: number; uncompressedSize: number; localOffset: number; localExtraLength: number };
type ManifestItem = { id: string; href: string; mediaType: string | null; properties: string[]; fallback: string | null };
type SpineItemRef = { idref: string; linear: boolean };
type EpubPackage = { path: string; version: string | null; renditionLayout: EpubRenditionLayout; manifest: Map<string, ManifestItem>; spine: SpineItemRef[]; spineTocId: string | null; dcTitle: string | null; dcLanguage: string | null; dcIdentifier: string | null };
type NavigationResult = { source: EpubNavigationSource; entries: EpubNavigationEntry[]; degraded: boolean };
type BlockContext = { spineIndex: number; docPath: string; provenance: BlockExtractionProvenance; footnote: boolean; warnings: Set<ExtractionQualityWarningCode>; limits: ParserLimits };

export function parseEpub(bytes: Uint8Array, limits: ParserLimits, parser: ParserDescriptor): Parsed {
  const entries = readZip(bytes, limits);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const mimetype = byName.get("mimetype");
  // OCF authority: mimetype is the first local file, STORED (never deflated)
  // and carries no local extra field. This prevents ambiguous/self-extracting
  // ZIP layouts from being accepted as EPUB containers.
  if (!mimetype || mimetype.localOffset !== 0 || mimetype.method !== 0 || mimetype.localExtraLength !== 0 ||
      entryText(byName, "mimetype", limits) !== "application/epub+zip") throw new Error(SourceError.CORRUPTED);
  if (byName.has("META-INF/encryption.xml")) throw new Error(SourceError.ARCHIVE_UNSAFE);
  const provenance: BlockExtractionProvenance = { sourceMethod: parser.sourceMethod, parserName: parser.name, parserVersion: parser.version };
  const opf = readPackage(byName, limits);
  const navigation = readNavigation(opf, byName, limits);
  const warnings = new Set<ExtractionQualityWarningCode>();
  const blocks: ParsedBlock[] = [];
  // The package spine is the reading-order authority. Every itemref is
  // validated, but only primary (linear=yes/implicit) items contribute to the
  // canonical reading stream. Auxiliary linear=no content remains addressable
  // EPUB content; it is not silently mixed into Book Intelligence input.
  let textSpineItems = 0;
  let emptyTextSpineItems = 0;
  opf.spine.forEach((ref, spineIndex) => {
    const item = opf.manifest.get(ref.idref);
    if (!item) throw new Error(SourceError.CORRUPTED);

    // Preserve the pre-04C-2 invariant that every spine-declared local resource
    // exists, even when it is auxiliary or requires a manifest fallback.
    const declaredResource = resolveArchiveHref(opf.path, item.href);
    if (!byName.has(declaredResource.path)) throw new Error(SourceError.CORRUPTED);

    const contentItem = resolveSpineContentItem(opf.manifest, item);
    const resource = resolveArchiveHref(opf.path, contentItem.href);
    if (!byName.has(resource.path)) throw new Error(SourceError.CORRUPTED);
    if (!ref.linear) return;

    const mediaType = contentItem.mediaType ?? "";
    const document = parseXmlResource(entryText(byName, resource.path, limits), limits, resource.path);
    const root = document.documentElement;
    if (!root) throw new Error(SourceError.CORRUPTED);
    const context: BlockContext = { spineIndex, docPath: resource.path, provenance, footnote: false, warnings, limits };
    const countBefore = blocks.length;
    if (mediaType === SVG_MEDIA_TYPE) emitSvgEvidence(root, context, blocks);
    else emitBlocksFor(root, context, blocks, 0);
    if (blocks.length > countBefore) textSpineItems += 1;
    else emptyTextSpineItems += 1;
  });
  if (opf.renditionLayout === "PRE_PAGINATED") warnings.add("EPUB_FIXED_LAYOUT");
  if (textSpineItems > 0 && emptyTextSpineItems > 0) warnings.add("PARTIAL_EXTRACTION");
  if (!blocks.length) throw new Error(opf.renditionLayout === "PRE_PAGINATED" ? SourceError.EPUB_FIXED_LAYOUT_UNSUPPORTED : SourceError.EPUB_NO_USABLE_TEXT);
  if (navigation.degraded) warnings.add("EPUB_NAVIGATION_DEGRADED");
  const formatMetadata: EpubExtractionMetadata = parseEpubExtractionMetadata({
    kind: "epub",
    epubVersion: opf.version,
    packagePath: opf.path,
    renditionLayout: opf.renditionLayout,
    spineItemCount: opf.spine.length,
    navigationSource: navigation.source,
    navigation: navigation.entries,
    dcTitle: opf.dcTitle,
    dcLanguage: opf.dcLanguage,
    dcIdentifier: opf.dcIdentifier,
  });
  return { parser, pages: [{ physicalPageIndex: null, blocks }], qualityWarnings: [...warnings], formatMetadata };
}

// ---------------------------------------------------------------------------
// Package (container.xml + OPF) — namespace-aware
// ---------------------------------------------------------------------------

function readPackage(byName: Map<string, ZipEntry>, limits: ParserLimits): EpubPackage {
  const container = parseXmlResource(entryText(byName, "META-INF/container.xml", limits), limits, "");
  let opfPath: string | null = null;
  for (const rootfile of elementsByLocalName(container, "rootfile", limits)) {
    const mediaType = rootfile.getAttribute("media-type");
    // OCF: a rootfile without media-type defaults to the OPF media type.
    if (mediaType && mediaType !== OPF_MEDIA_TYPE) continue;
    const fullPath = rootfile.getAttribute("full-path");
    if (!fullPath) continue;
    const resolved = resolveArchiveHref("", fullPath);
    if (byName.has(resolved.path)) { opfPath = resolved.path; break; }
  }
  if (!opfPath) throw new Error(SourceError.CORRUPTED);
  const opf = parseXmlResource(entryText(byName, opfPath, limits), limits, opfPath);
  const packageElement = opf.documentElement;
  if (!packageElement || localName(packageElement) !== "package") throw new Error(SourceError.CORRUPTED);
  const manifestElement = elementsByLocalName(opf, "manifest", limits)[0];
  const spineElement = elementsByLocalName(opf, "spine", limits)[0];
  if (!manifestElement || !spineElement) throw new Error(SourceError.CORRUPTED);
  const manifest = new Map<string, ManifestItem>();
  for (const item of directElementChildrenByLocalName(manifestElement, "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    if (manifest.has(id)) throw new Error(SourceError.CORRUPTED);
    manifest.set(id, {
      id,
      href,
      mediaType: item.getAttribute("media-type") || null,
      properties: (item.getAttribute("properties") || "").split(/\s+/).filter(Boolean),
      fallback: item.getAttribute("fallback") || null,
    });
  }

  const spine: SpineItemRef[] = [];
  const seenSpineIds = new Set<string>();
  for (const itemref of directElementChildrenByLocalName(spineElement, "itemref")) {
    const idref = itemref.getAttribute("idref");
    const linearValue = itemref.getAttribute("linear");
    if (!idref || seenSpineIds.has(idref) || (linearValue && linearValue !== "yes" && linearValue !== "no")) throw new Error(SourceError.CORRUPTED);
    seenSpineIds.add(idref);
    spine.push({ idref, linear: linearValue !== "no" });
  }
  // EPUB requires at least one primary item; omitted linear means "yes".
  if (!spine.length || !spine.some((itemref) => itemref.linear)) throw new Error(SourceError.CORRUPTED);

  return {
    path: opfPath,
    version: packageElement.getAttribute("version") || null,
    renditionLayout: readRenditionLayout(packageElement, opf, limits),
    manifest,
    spine,
    spineTocId: spineElement.getAttribute("toc") || null,
    dcTitle: dcElementText(opf, limits, "title"),
    dcLanguage: dcElementText(opf, limits, "language"),
    dcIdentifier: dcElementText(opf, limits, "identifier"),
  };
}

function isProcessableSpineContent(item: ManifestItem): boolean {
  const mediaType = item.mediaType ?? "";
  // Preserve legacy v2 tolerance for missing media-type: attempt XML content
  // parsing rather than silently discarding old-but-readable books.
  return !mediaType || CONTENT_MEDIA_TYPES.has(mediaType) || mediaType === SVG_MEDIA_TYPE;
}

function resolveSpineContentItem(manifest: Map<string, ManifestItem>, start: ManifestItem): ManifestItem {
  let current = start;
  const seen = new Set<string>();
  while (!isProcessableSpineContent(current)) {
    if (seen.has(current.id) || !current.fallback) throw new Error(SourceError.CORRUPTED);
    seen.add(current.id);
    const next = manifest.get(current.fallback);
    if (!next) throw new Error(SourceError.CORRUPTED);
    current = next;
  }
  return current;
}

function readRenditionLayout(packageElement: XmlElement, opf: XmlDocument, limits: ParserLimits): EpubRenditionLayout {
  for (const meta of elementsByLocalName(opf, "meta", limits)) {
    const property = (meta.getAttribute("property") || "").trim();
    const prefix = property.includes(":") ? property.slice(0, property.indexOf(":")) : null;
    const isLayout = property === "rendition:layout" || (!!prefix && property.endsWith(":layout") && (packageElement.getAttribute(`xmlns:${prefix}`) || "") === EPUB_RENDITION_NAMESPACE);
    if (!isLayout) continue;
    const value = (meta.textContent || "").trim();
    if (value === "pre-paginated") return "PRE_PAGINATED";
    if (value === "reflowable") return "REFLOWABLE";
  }
  return "UNKNOWN";
}

function dcElementText(opf: XmlDocument, limits: ParserLimits, local: string): string | null {
  const metadata = elementsByLocalName(opf, "metadata", limits)[0];
  if (!metadata) return null;
  const candidates = directElementChildrenByLocalName(metadata, local);
  const hit = candidates.find((element) => element.namespaceURI === DC_ELEMENTS_NAMESPACE) ?? candidates.find((element) => !element.namespaceURI);
  return collapsedText(hit) || null;
}

// ---------------------------------------------------------------------------
// Navigation (EPUB3 nav preferred, EPUB2 NCX fallback) — evidence only
// ---------------------------------------------------------------------------

function readNavigation(opf: EpubPackage, byName: Map<string, ZipEntry>, limits: ParserLimits): NavigationResult {
  try {
    const navItem = [...opf.manifest.values()].find((item) => item.properties.includes("nav"));
    if (navItem) {
      const navPath = resolveNavDocumentPath(navItem, opf, byName);
      const document = parseXmlResource(entryText(byName, navPath, limits), limits, navPath);
      const entries = flattenEpub3Nav(document, navPath, limits);
      return entries.length ? { source: "EPUB3_NAV", entries, degraded: false } : { source: "NONE", entries: [], degraded: true };
    }
    // No EPUB3 nav: EPUB2 NCX via spine toc, then any declared NCX manifest item.
    const ncxItem = (opf.spineTocId ? opf.manifest.get(opf.spineTocId) : undefined) ?? [...opf.manifest.values()].find((item) => item.mediaType === NCX_MEDIA_TYPE);
    if (ncxItem) {
      const ncxPath = resolveNavDocumentPath(ncxItem, opf, byName);
      const document = parseXmlResource(entryText(byName, ncxPath, limits), limits, ncxPath);
      const entries = flattenNcx(document, ncxPath, limits);
      return entries.length ? { source: "EPUB2_NCX", entries, degraded: false } : { source: "NONE", entries: [], degraded: true };
    }
    // A legal EPUB may ship without any TOC: no warning without evidence.
    return { source: "NONE", entries: [], degraded: false };
  } catch (error) {
    // Security violations and limit breaches must always fail closed; every
    // other primary-navigation failure degrades to a deterministic warning.
    if (error instanceof Error && (error.message === SourceError.ARCHIVE_UNSAFE || error.message === SourceError.TOO_LARGE)) throw error;
    return { source: "NONE", entries: [], degraded: true };
  }
}

function resolveNavDocumentPath(item: ManifestItem, opf: EpubPackage, byName: Map<string, ZipEntry>): string {
  const resolved = resolveArchiveHref(opf.path, item.href);
  if (!byName.has(resolved.path)) throw new Error(SourceError.CORRUPTED);
  return resolved.path;
}

function flattenEpub3Nav(document: XmlDocument, navDocumentPath: string, limits: ParserLimits): EpubNavigationEntry[] {
  const navs = elementsByLocalName(document, "nav", limits);
  if (!navs.length) throw new Error(NAV_STRUCTURAL_FAILURE);
  const tocNav = navs.find((nav) => (epubType(nav) || "").split(/\s+/).includes("toc")) ?? navs.find((nav) => (nav.getAttribute("hidden") || "") !== "hidden") ?? navs[0]!;
  const firstList = directElementChildrenByLocalName(tocNav, "ol")[0];
  if (!firstList) throw new Error(NAV_STRUCTURAL_FAILURE);
  const entries: EpubNavigationEntry[] = [];
  walkEpub3NavList(firstList, 0, entries, navDocumentPath, limits);
  return entries;
}

function walkEpub3NavList(list: XmlElement, depth: number, entries: EpubNavigationEntry[], navDocumentPath: string, limits: ParserLimits): void {
  if (depth > MAX_NAVIGATION_DEPTH) throw new Error(NAV_STRUCTURAL_FAILURE);
  for (const li of directElementChildrenByLocalName(list, "li")) {
    assertNavigationCapacity(entries, limits);
    const anchor = directElementChildren(li).find((child) => localName(child) === "a" || localName(child) === "span");
    const label = collapsedText(anchor);
    const href = anchor && localName(anchor) === "a" ? anchor.getAttribute("href") : null;
    if (label && href) {
      const resolved = resolveArchiveHref(navDocumentPath, href);
      entries.push({ ordinal: entries.length, depth, label, href: resolved.path, fragmentId: resolved.fragmentId });
    }
    for (const nested of directElementChildrenByLocalName(li, "ol")) walkEpub3NavList(nested, depth + 1, entries, navDocumentPath, limits);
  }
}

function flattenNcx(document: XmlDocument, ncxPath: string, limits: ParserLimits): EpubNavigationEntry[] {
  const navMap = elementsByLocalName(document, "navMap", limits)[0];
  if (!navMap) throw new Error(NAV_STRUCTURAL_FAILURE);
  const entries: EpubNavigationEntry[] = [];
  for (const navPoint of directElementChildrenByLocalName(navMap, "navPoint")) walkNcxNavPoint(navPoint, 0, entries, ncxPath, limits);
  return entries;
}

function walkNcxNavPoint(navPoint: XmlElement, depth: number, entries: EpubNavigationEntry[], ncxPath: string, limits: ParserLimits): void {
  if (depth > MAX_NAVIGATION_DEPTH) throw new Error(NAV_STRUCTURAL_FAILURE);
  assertNavigationCapacity(entries, limits);
  // Direct children only: a nested navPoint owns its own navLabel/content.
  const navLabel = directElementChildrenByLocalName(navPoint, "navLabel")[0];
  const label = collapsedText(navLabel ? directElementChildrenByLocalName(navLabel, "text")[0] : undefined);
  const src = directElementChildrenByLocalName(navPoint, "content")[0]?.getAttribute("src") ?? null;
  if (label && src) {
    const resolved = resolveArchiveHref(ncxPath, src);
    entries.push({ ordinal: entries.length, depth, label, href: resolved.path, fragmentId: resolved.fragmentId });
  }
  for (const nested of directElementChildrenByLocalName(navPoint, "navPoint")) walkNcxNavPoint(nested, depth + 1, entries, ncxPath, limits);
}

function assertNavigationCapacity(entries: EpubNavigationEntry[], limits: ParserLimits): void {
  if (entries.length >= limits.maxEpubNavigationEntries) throw new Error(SourceError.TOO_LARGE);
}

// ---------------------------------------------------------------------------
// Safe archive-relative resource resolution
// ---------------------------------------------------------------------------

/**
 * Resolves an href from a base document inside the archive. Legal parent
 * normalization is allowed (OPS/nav/nav.xhtml + ../text/ch1.xhtml resolves to
 * OPS/text/ch1.xhtml); crossing the archive root, external schemes, absolute,
 * drive, UNC, backslash and encoded-traversal paths all fail closed. The
 * fragment is separated here and never participates in archive lookup. Pure
 * string semantics: nothing is fetched, nothing is read from disk.
 */
function resolveArchiveHref(basePath: string, href: string): { path: string; fragmentId: string | null } {
  if (!href || /[\0]/.test(href) || /%00|%2e|%2f|%5c/i.test(href)) throw new Error(SourceError.ARCHIVE_UNSAFE);
  if (/[\\]/.test(href)) throw new Error(SourceError.ARCHIVE_UNSAFE);
  const hash = href.indexOf("#");
  const rawPath = hash >= 0 ? href.slice(0, hash) : href;
  const fragmentId = hash >= 0 && hash + 1 < href.length ? href.slice(hash + 1) : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath)) throw new Error(SourceError.ARCHIVE_UNSAFE);
  if (/^(?:[\\/]|[a-zA-Z]:|\\\\)/.test(rawPath)) throw new Error(SourceError.ARCHIVE_UNSAFE);
  if (!rawPath) return { path: basePath, fragmentId };
  const parts = basePath.split("/");
  parts.pop();
  for (const part of rawPath.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error(SourceError.ARCHIVE_UNSAFE);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const resolved = parts.join("/");
  if (!resolved || !isSafePath(resolved)) throw new Error(SourceError.ARCHIVE_UNSAFE);
  return { path: resolved, fragmentId };
}

// ---------------------------------------------------------------------------
// Content-document block extraction (DOM order)
// ---------------------------------------------------------------------------

function emitBlocksFor(element: XmlElement, context: BlockContext, blocks: ParsedBlock[], depth: number): void {
  if (depth > MAX_WALK_DEPTH) throw new Error(SourceError.CORRUPTED);
  const tag = localName(element);
  // EPUB3 semantic footnotes/endnotes: the whole note subtree becomes FOOTNOTE.
  const footnoteTypes = (epubType(element) || "").split(/\s+/).filter(Boolean);
  const inner: BlockContext = !context.footnote && footnoteTypes.some((type) => FOOTNOTE_TYPES.has(type)) ? { ...context, footnote: true } : context;
  const headingMatch = /^h([1-6])$/.exec(tag);
  if (headingMatch) return emitInlineBlock(element, inner, blocks, "HEADING", { headingLevel: Number(headingMatch[1]) });
  if (tag === "p") return emitInlineBlock(element, inner, blocks, "PARAGRAPH");
  if (tag === "li") return emitInlineBlock(element, inner, blocks, "LIST_ITEM");
  // Blockquote/figcaption consume their whole subtree so nested paragraphs are
  // never extracted twice.
  if (tag === "blockquote") return emitInlineBlock(element, inner, blocks, "QUOTE", { flatten: true });
  if (tag === "figcaption") return emitInlineBlock(element, inner, blocks, "CAPTION", { flatten: true });
  if (tag === "pre") return emitTextBlock("CODE", normalizeCanonicalText((element.textContent ?? "").replace(/\u00a0/g, " ")), element, inner, blocks);
  if (tag === "table") return emitTableBlock(element, inner, blocks);
  if (tag === "math") return emitEquation(element, inner, blocks);
  if (tag === "svg") return emitSvgEvidence(element, inner, blocks);
  if (tag === "img") return emitImageEvidence(element, inner, blocks);
  // Transparent containers: direct text runs become paragraphs, block-level
  // children recurse in document order.
  emitInlineBlock(element, inner, blocks, "PARAGRAPH");
}

function emitInlineBlock(element: XmlElement, context: BlockContext, blocks: ParsedBlock[], kind: SourceBlockKind, options: { flatten?: boolean; headingLevel?: number } = {}): void {
  const walk: { buffer: string } = { buffer: "" };
  // Block ownership rule: a list item owns its direct paragraph content (so
  // <li><p>text</p></li> produces one LIST_ITEM, never a duplicate pair), while
  // nested lists recurse into their own list items.
  walkInline(element, walk, context, blocks, 0, kind, { ...options, absorbParagraphs: kind === "LIST_ITEM" });
  flushInline(walk, element, context, blocks, kind, options.headingLevel ?? null);
}

function walkInline(element: XmlElement, walk: { buffer: string }, context: BlockContext, blocks: ParsedBlock[], depth: number, kind: SourceBlockKind, options: { flatten?: boolean; absorbParagraphs?: boolean } = {}): void {
  if (depth > MAX_WALK_DEPTH) throw new Error(SourceError.CORRUPTED);
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3 || child.nodeType === 4) {
      walk.buffer += child.nodeValue ?? "";
      continue;
    }
    if (child.nodeType !== 1) continue;
    const elementChild = child as XmlElement;
    const tag = localName(elementChild);
    if (SKIPPED_TAGS.has(tag)) continue;
    if (options.flatten) {
      // Flattened mode: nested block markup contributes text to the owning
      // block, only real evidence objects (img/math/svg) split out.
      if (tag === "img") { flushInline(walk, element, context, blocks, kind, null); emitImageEvidence(elementChild, context, blocks); }
      else if (tag === "math") { flushInline(walk, element, context, blocks, kind, null); emitEquation(elementChild, context, blocks); }
      else if (tag === "svg") { flushInline(walk, element, context, blocks, kind, null); emitSvgEvidence(elementChild, context, blocks); }
      else walkInline(elementChild, walk, context, blocks, depth + 1, kind, options);
      continue;
    }
    if (tag === "p" && options.absorbParagraphs) {
      walkInline(elementChild, walk, context, blocks, depth + 1, kind, options);
      continue;
    }
    if (BLOCK_PRODUCERS.has(tag) || CONTAINER_TAGS.has(tag)) { flushInline(walk, element, context, blocks, kind, null); emitBlocksFor(elementChild, context, blocks, depth + 1); }
    else if (tag === "img") { flushInline(walk, element, context, blocks, kind, null); emitImageEvidence(elementChild, context, blocks); }
    else if (tag === "math") { flushInline(walk, element, context, blocks, kind, null); emitEquation(elementChild, context, blocks); }
    else if (tag === "svg") { flushInline(walk, element, context, blocks, kind, null); emitSvgEvidence(elementChild, context, blocks); }
    else if (tag === "br") walk.buffer += "\n";
    else walkInline(elementChild, walk, context, blocks, depth + 1, kind);
  }
}

function flushInline(walk: { buffer: string }, element: XmlElement, context: BlockContext, blocks: ParsedBlock[], kind: SourceBlockKind, headingLevel: number | null): void {
  const text = normalizeBlockText(walk.buffer);
  walk.buffer = "";
  if (!text) return;
  emitOwnedBlocks(context.footnote ? "FOOTNOTE" : kind, text, element, context, blocks, headingLevel);
}

function emitTextBlock(kind: SourceBlockKind, text: string, element: XmlElement, context: BlockContext, blocks: ParsedBlock[]): void {
  if (!text.trim()) return;
  emitOwnedBlocks(context.footnote ? "FOOTNOTE" : kind, text, element, context, blocks, null);
}

function emitOwnedBlocks(kind: SourceBlockKind, text: string, element: XmlElement, context: BlockContext, blocks: ParsedBlock[], headingLevel: number | null): void {
  const locator: CanonicalSourceLocator = { kind: "epub", spineIndex: context.spineIndex, href: context.docPath, fragmentId: fragmentIdFor(element), elementPath: elementPathFor(element) };
  const metadata = headingLevel === null ? undefined : { headingLevel };
  for (const chunk of splitCanonicalBlock(text)) if (chunk) blocks.push({ kind, text: chunk, locator, provenance: context.provenance, metadata });
}

function emitTableBlock(table: XmlElement, context: BlockContext, blocks: ParsedBlock[]): void {
  const caption = directElementChildrenByLocalName(table, "caption")[0];
  if (caption) emitInlineBlock(caption, context, blocks, "CAPTION", { flatten: true });
  let flattened = false;
  const sections = directElementChildren(table).filter((child) => ["thead", "tbody", "tfoot"].includes(localName(child)));
  const rowSources = [...sections.flatMap((section) => directElementChildrenByLocalName(section, "tr")), ...directElementChildrenByLocalName(table, "tr")];
  const rows: string[] = [];
  for (const row of rowSources) {
    const cells: string[] = [];
    for (const cell of directElementChildren(row)) {
      const cellTag = localName(cell);
      if (cellTag !== "td" && cellTag !== "th") continue;
      // v1 keeps readable text and flags the loss of merged-cell geometry
      // instead of reconstructing a 2D grid.
      if (cell.getAttribute("rowspan") || cell.getAttribute("colspan")) flattened = true;
      cells.push(collapsedText(cell));
    }
    const rowText = cells.join("\t");
    if (rowText) rows.push(rowText);
  }
  const text = normalizeCanonicalText(rows.join("\n"));
  if (!text) return;
  if (flattened) context.warnings.add("TABLE_FLATTENED");
  emitOwnedBlocks(context.footnote ? "FOOTNOTE" : "TABLE", text, table, context, blocks, null);
}

function emitEquation(math: XmlElement, context: BlockContext, blocks: ParsedBlock[]): void {
  // Evidence priority: TeX annotation > accessible alttext > normalized
  // MathML text content. No LLM guessing, no raw markup dumps.
  const annotations = [...elementsByLocalName(math, "annotation", context.limits), ...elementsByLocalName(math, "annotation-xml", context.limits)];
  const tex = annotations.find((annotation) => (annotation.getAttribute("encoding") || "").trim() === "application/x-tex");
  const alttext = (math.getAttribute("alttext") || "").trim();
  const text = (tex && collapsedText(tex)) || (alttext && alttext.replace(/\s+/g, " ")) || collapsedText(math);
  if (!text) return;
  emitOwnedBlocks(context.footnote ? "FOOTNOTE" : "EQUATION", text, math, context, blocks, null);
}

function emitSvgEvidence(svg: XmlElement, context: BlockContext, blocks: ParsedBlock[]): void {
  // SVG is never rendered or executed: only deterministic accessibility text.
  const text = collapsedText(elementsByLocalName(svg, "title", context.limits)[0]) || collapsedText(elementsByLocalName(svg, "desc", context.limits)[0]);
  if (!text) return;
  emitOwnedBlocks(context.footnote ? "FOOTNOTE" : "IMAGE", text, svg, context, blocks, null);
}

function emitImageEvidence(img: XmlElement, context: BlockContext, blocks: ParsedBlock[]): void {
  // Only reliable accessibility evidence produces text; alt text is never
  // invented from filenames or guessed.
  const evidence = [img.getAttribute("alt"), img.getAttribute("title"), img.getAttribute("aria-label")].map((value) => (value || "").trim().replace(/\s+/g, " ")).find(Boolean);
  if (!evidence) return;
  emitOwnedBlocks(context.footnote ? "FOOTNOTE" : "IMAGE", evidence, img, context, blocks, null);
}

// ---------------------------------------------------------------------------
// XML plumbing
// ---------------------------------------------------------------------------

/**
 * Parses one EPUB XML resource and enforces the post-DOM resource-reference
 * security gate on the DECODED attribute values (RF01-02): entity-obfuscated
 * or whitespace-padded external URLs never survive parsing unnoticed. The raw
 * prefilter stays in front as defense in depth; the DOM gate is authoritative.
 */
function parseXmlResource(xml: string, limits: ParserLimits, basePath: string): XmlDocument {
  const document = parseXmlDocument(safeXmlText(xml), limits);
  assertDomResourceReferences(document, basePath, limits);
  return document;
}

function parseXmlDocument(xml: string, limits: ParserLimits): XmlDocument {
  if (xml.length > limits.maxEpubXmlChars) throw new Error(SourceError.TOO_LARGE);
  const problems: string[] = [];
  let document: XmlDocument;
  try {
    document = new DOMParser({ onError: (level, message) => { problems.push(`${level}: ${message}`); } }).parseFromString(decodeHtmlNamedEntities(xml), "application/xml");
  } catch {
    throw new Error(SourceError.CORRUPTED);
  }
  if (!document.documentElement) throw new Error(SourceError.CORRUPTED);
  // Fail closed on ANY parser-reported problem — warning, error, or fatal
  // error. A well-formedness problem must never be silently repaired into
  // canonical body text.
  if (problems.length) throw new Error(SourceError.CORRUPTED);
  return document;
}

/**
 * Post-DOM gate: validates every resource-reference attribute using the
 * parser-decoded value. Raw-regex prefiltering is not authoritative — decoded
 * values defeat entity obfuscation and padded schemes. Allowed: #fragment and
 * archive-relative paths (including legal ../) that stay inside the archive
 * root. Everything else fails closed. No resource is ever fetched.
 */
function assertDomResourceReferences(document: XmlDocument, basePath: string, limits: ParserLimits): void {
  const root = document.documentElement;
  if (!root) throw new Error(SourceError.CORRUPTED);
  for (const element of iterXmlElements(root, limits)) {
    const attributes = element.attributes;
    for (let index = 0; index < attributes.length; index++) {
      const attribute = attributes.item(index)!;
      // xlink:href shares the localName "href" with its namespace binding, so
      // a localName check covers both plain and XLink references.
      const name = attribute.localName || attribute.nodeName;
      if (name !== "src" && name !== "href" && name !== "full-path") continue;
      const value = (attribute.value ?? "").trim();
      if (!value || value.startsWith("#")) continue;
      resolveArchiveHref(basePath, value);
    }
  }
}

/**
 * Bounded pre-order (document-order) element collection. The explicit stack
 * keeps the maxEpubDomNodes bound (no unbounded recursion); children are
 * pushed in REVERSE order so the LIFO pops yield true first-to-last sibling
 * order: root, a, b, c for <root><a/><b/><c/></root>.
 */
function iterXmlElements(root: XmlElement, limits: ParserLimits): XmlElement[] {
  const found: XmlElement[] = [];
  const stack: XmlNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (found.length >= limits.maxEpubDomNodes) throw new Error(SourceError.TOO_LARGE);
    if (node.nodeType !== 1) continue;
    const element = node as XmlElement;
    found.push(element);
    const children = element.childNodes;
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children.item(index);
      if (child) stack.push(child);
    }
  }
  return found;
}

function elementsByLocalName(root: XmlDocument | XmlElement, name: string, limits: ParserLimits): XmlElement[] {
  const scope: XmlElement | null = isXmlElementRoot(root) ? root : root.documentElement;
  if (!scope) return [];
  return iterXmlElements(scope, limits).filter((element) => localName(element) === name);
}

function isXmlElementRoot(value: XmlDocument | XmlElement): value is XmlElement {
  return (value as XmlDocument).documentElement === undefined;
}

/**
 * XHTML content documents routinely use HTML named entities that strict XML
 * leaves undefined. XML's five predefined entities (&amp; &lt; &gt; &quot;
 * &apos;) are NEVER touched — rewriting them before parsing would let escaped
 * text be re-interpreted as markup. Everything else in the fixed repo-local
 * HTML4 table is rewritten into a NUMERIC character reference, which the XML
 * parser itself expands as text data. Unknown entities stay untouched and
 * fail closed at the parser gate.
 */
const HTML_NAMED_ENTITIES: Record<string, string> = Object.fromEntries(
  (
    "nbsp:160 iexcl:161 cent:162 pound:163 curren:164 yen:165 brvbar:166 sect:167 uml:168 copy:169 ordf:170 laquo:171 not:172 shy:173 reg:174 " +
    "macr:175 deg:176 plusmn:177 sup2:178 sup3:179 acute:180 micro:181 para:182 middot:183 cedil:184 sup1:185 ordm:186 raquo:187 " +
    "frac14:188 frac12:189 frac34:190 iquest:191 Agrave:192 Aacute:193 Acirc:194 Atilde:195 Auml:196 Aring:197 AElig:198 Ccedil:199 " +
    "Egrave:200 Eacute:201 Ecirc:202 Euml:203 Igrave:204 Iacute:205 Icirc:206 Iuml:207 ETH:208 Ntilde:209 Ograve:210 Oacute:211 " +
    "Ocirc:212 Otilde:213 Ouml:214 times:215 Oslash:216 Ugrave:217 Uacute:218 Ucirc:219 Uuml:220 Yacute:221 THORN:222 szlig:223 " +
    "agrave:224 aacute:225 acirc:226 atilde:227 auml:228 aring:229 aelig:230 ccedil:231 egrave:232 eacute:233 ecirc:234 euml:235 " +
    "igrave:236 iacute:237 icirc:238 iuml:239 eth:240 ntilde:241 ograve:242 oacute:243 ocirc:244 otilde:245 ouml:246 divide:247 " +
    "oslash:248 ugrave:249 uacute:250 ucirc:251 uuml:252 yacute:253 thorn:254 yuml:255 " +
    "OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 fnof:402 circ:710 tilde:732 " +
    "Alpha:913 Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 Iota:921 Kappa:922 Lambda:923 Mu:924 Nu:925 " +
    "Xi:926 Omicron:927 Pi:928 Rho:929 Sigma:931 Tau:932 Upsilon:933 Phi:934 Chi:935 Psi:936 Omega:937 " +
    "alpha:945 beta:946 gamma:947 delta:948 epsilon:949 zeta:950 eta:951 theta:952 iota:953 kappa:954 lambda:955 mu:956 nu:957 " +
    "xi:958 omicron:959 pi:960 rho:961 sigmaf:962 sigma:963 tau:964 upsilon:965 phi:966 chi:967 psi:968 omega:969 " +
    "thetasym:977 upsih:978 piv:982 " +
    "ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 zwj:8205 lrm:8206 rlm:8207 ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 " +
    "ldquo:8220 rdquo:8221 bdquo:8222 dagger:8224 Dagger:8225 bull:8226 hellip:8230 permil:8240 prime:8242 Prime:8243 " +
    "lsaquo:8249 rsaquo:8250 oline:8254 frasl:8260 euro:8364 image:8465 weierp:8472 real:8476 trade:8482 alefsym:8501 " +
    "larr:8592 uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 lArr:8656 uArr:8657 rArr:8658 dArr:8659 hArr:8660 " +
    "forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 isin:8712 notin:8713 ni:8715 prod:8719 sum:8721 minus:8722 " +
    "lowast:8727 radic:8730 prop:8733 infin:8734 ang:8736 and:8743 or:8744 cap:8745 cup:8746 int:8747 there4:8756 sim:8764 " +
    "cong:8773 asymp:8776 ne:8800 equiv:8801 le:8804 ge:8805 sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 oplus:8853 " +
    "otimes:8855 perp:8869 sdot:8901 lceil:8968 rceil:8969 lfloor:8970 rfloor:8971 lang:9001 rang:9002 loz:9674 " +
    "spades:9824 clubs:9827 hearts:9829 diams:9830"
  )
    .split(/\s+/)
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      return [entry.slice(0, separator), `&#${entry.slice(separator + 1)};`];
    }),
);

function decodeHtmlNamedEntities(xml: string): string {
  if (!xml.includes("&")) return xml;
  // Lexical-context safety (RF02-02): entity rewriting must never mutate the
  // source inside CDATA sections (required) or comments and processing
  // instructions (preferred) — those bytes belong to the XML parser verbatim.
  let result = "";
  let cursor = 0;
  const regions: Array<{ opener: string; closer: string }> = [
    { opener: "<![CDATA[", closer: "]]>" },
    { opener: "<!--", closer: "-->" },
    { opener: "<?", closer: "?>" },
  ];
  while (cursor < xml.length) {
    let next = -1;
    let region: { opener: string; closer: string } | null = null;
    for (const candidate of regions) {
      const at = xml.indexOf(candidate.opener, cursor);
      if (at >= 0 && (next < 0 || at < next)) { next = at; region = candidate; }
    }
    if (!region || next < 0) {
      result += rewriteHtmlNamedEntities(xml.slice(cursor));
      break;
    }
    result += rewriteHtmlNamedEntities(xml.slice(cursor, next));
    const close = xml.indexOf(region.closer, next + region.opener.length);
    if (close < 0) {
      // Unterminated lexical region: kept verbatim; the strict parser gate
      // rejects the document rather than repairing it.
      result += xml.slice(next);
      cursor = xml.length;
      break;
    }
    const end = close + region.closer.length;
    result += xml.slice(next, end);
    cursor = end;
  }
  return result;
}

function rewriteHtmlNamedEntities(segment: string): string {
  if (!segment.includes("&")) return segment;
  return segment.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => HTML_NAMED_ENTITIES[name] ?? match);
}

/**
 * Raw pre-parse DTD/XXE defense (RF02-02): DOCTYPE/ENTITY/ATTLIST/NOTATION
 * and SYSTEM/PUBLIC constructs are rejected before the parser ever sees them.
 * Resource-reference rejection deliberately does NOT happen here — a plain
 * regex cannot tell an attribute from body text ("The attribute
 * href=\"https://...\" is external."); the authoritative decoded-attribute
 * gate is assertDomResourceReferences.
 */
function safeXmlText(xml: string): string {
  if (/<!DOCTYPE|<!ENTITY|<!ATTLIST|<!NOTATION/i.test(xml) || /<![^>[]*\b(?:SYSTEM|PUBLIC)\b/i.test(xml)) throw new Error(SourceError.ARCHIVE_UNSAFE);
  return xml;
}

function readZip(bytes: Uint8Array, limits: ParserLimits): ZipEntry[] {
  const data = Buffer.from(bytes);
  const eocd = findEndOfCentralDirectory(data);
  if (eocd < 0) throw new Error(SourceError.CORRUPTED);

  const diskNumber = data.readUInt16LE(eocd + 4);
  const directoryDisk = data.readUInt16LE(eocd + 6);
  const entriesOnDisk = data.readUInt16LE(eocd + 8);
  const count = data.readUInt16LE(eocd + 10);
  const directorySize = data.readUInt32LE(eocd + 12);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  const commentLength = data.readUInt16LE(eocd + 20);

  // EPUB is a single-file OCF container. Multi-disk and ZIP64 sentinels are
  // unsupported and fail closed instead of falling through 32-bit arithmetic.
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== count ||
      count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error(SourceError.ARCHIVE_UNSAFE);
  if (count > limits.maxArchiveEntries) throw new Error(SourceError.ARCHIVE_UNSAFE);
  if (eocd + 22 + commentLength !== data.length) throw new Error(SourceError.CORRUPTED);
  if (!hasZipRange(data, directoryOffset, directorySize) || directoryOffset + directorySize !== eocd) throw new Error(SourceError.CORRUPTED);

  let offset = directoryOffset;
  let total = 0;
  const entries: ZipEntry[] = [];
  const seenNames = new Set<string>();
  const localRanges: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < count; index++) {
    if (!hasZipRange(data, offset, 46) || data.readUInt32LE(offset) !== 0x02014b50) throw new Error(SourceError.CORRUPTED);
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const crc32 = data.readUInt32LE(offset + 16);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const diskNumberStart = data.readUInt16LE(offset + 34);
    const localOffset = data.readUInt32LE(offset + 42);
    const centralLength = 46 + nameLength + extraLength + commentLength;
    if (!hasZipRange(data, offset, centralLength) || offset + centralLength > eocd) throw new Error(SourceError.CORRUPTED);
    // EOCD single-disk fields are not sufficient: each central-directory
    // entry independently declares the disk that owns its local header.
    // Any nonzero diskNumberStart contradicts the single-file EPUB authority.
    if (diskNumberStart !== 0) throw new Error(SourceError.ARCHIVE_UNSAFE);

    const name = decodeZipName(data.subarray(offset + 46, offset + 46 + nameLength));
    const isDirectory = name.endsWith("/");
    const authorityPath = isDirectory ? name.slice(0, -1) : name;
    if (seenNames.has(name)) throw new Error(SourceError.ARCHIVE_UNSAFE);
    seenNames.add(name);
    if ((flags & 1) || (method !== 0 && method !== 8) || !isSafePath(authorityPath) ||
        uncompressedSize > limits.maxArchiveEntryBytes ||
        (compressedSize === 0 && uncompressedSize !== 0) ||
        (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxArchiveCompressionRatio)) throw new Error(SourceError.ARCHIVE_UNSAFE);
    if (isDirectory && uncompressedSize !== 0) throw new Error(SourceError.CORRUPTED);
    if (method === 0 && compressedSize !== uncompressedSize) throw new Error(SourceError.CORRUPTED);

    total += uncompressedSize;
    if (total > limits.maxArchiveTotalBytes) throw new Error(SourceError.ARCHIVE_UNSAFE);

    if (!hasZipRange(data, localOffset, 30) || localOffset >= directoryOffset || data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(SourceError.CORRUPTED);
    const localFlags = data.readUInt16LE(localOffset + 6);
    const localMethod = data.readUInt16LE(localOffset + 8);
    const localCrc32 = data.readUInt32LE(localOffset + 14);
    const localCompressedSize = data.readUInt32LE(localOffset + 18);
    const localUncompressedSize = data.readUInt32LE(localOffset + 22);
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const localHeaderLength = 30 + localNameLength + localExtraLength;
    if (!hasZipRange(data, localOffset, localHeaderLength)) throw new Error(SourceError.CORRUPTED);
    const localName = decodeZipName(data.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name || localFlags !== flags || localMethod !== method) throw new Error(SourceError.CORRUPTED);

    // With no data descriptor, the local CRC/size fields mirror the central
    // record exactly. With bit 3 set, local fields may be zero placeholders,
    // but any populated field must still agree with the central authority.
    if ((flags & 0x08) === 0) {
      if (localCrc32 !== crc32 || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) throw new Error(SourceError.CORRUPTED);
    } else if ((localCrc32 !== 0 && localCrc32 !== crc32) ||
               (localCompressedSize !== 0 && localCompressedSize !== compressedSize) ||
               (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)) {
      throw new Error(SourceError.CORRUPTED);
    }

    const start = localOffset + localHeaderLength;
    const dataEnd = start + compressedSize;
    if (!hasZipRange(data, start, compressedSize) || dataEnd > directoryOffset) throw new Error(SourceError.CORRUPTED);
    const localEnd = (flags & 0x08) !== 0 ? readZipDataDescriptorEnd(data, dataEnd, directoryOffset, crc32, compressedSize, uncompressedSize) : dataEnd;
    localRanges.push({ start: localOffset, end: localEnd });
    if (!isDirectory) entries.push({ name, method, flags, compressed: data.subarray(start, dataEnd), compressedSize, uncompressedSize, localOffset, localExtraLength });
    offset += centralLength;
  }

  if (offset !== eocd) throw new Error(SourceError.CORRUPTED);
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index++) {
    if (localRanges[index - 1]!.end > localRanges[index]!.start) throw new Error(SourceError.CORRUPTED);
  }
  return entries;
}

function findEndOfCentralDirectory(data: Buffer): number {
  // EOCD may be followed by up to 65,535 comment bytes, and the comment itself
  // may contain a second fully-formed EOCD. A ZIP with two candidates whose
  // declared comments both reach EOF has two competing central-directory
  // authorities; fail closed instead of choosing the last signature.
  const minimum = Math.max(0, data.length - 22 - 0xffff);
  let candidate = -1;
  for (let offset = data.length - 22; offset >= minimum; offset--) {
    if (data.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = data.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== data.length) continue;
    if (candidate !== -1) return -1;
    candidate = offset;
  }
  return candidate;
}

function hasZipRange(data: Buffer, offset: number, length: number): boolean {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= data.length && length <= data.length - offset;
}

/**
 * GPBF bit 3 moves CRC/sizes into a trailing data descriptor. The central
 * directory remains the size authority, but the descriptor itself must be
 * present, bounded, and identity-equal; otherwise bytes between local records
 * can alias as unvalidated archive structure. ZIP64 descriptors are excluded
 * by the archive's ZIP64 fail-closed policy.
 */
function readZipDataDescriptorEnd(data: Buffer, offset: number, directoryOffset: number, crc32: number, compressedSize: number, uncompressedSize: number): number {
  const unsigned = hasZipRange(data, offset, 12) && offset + 12 <= directoryOffset &&
    data.readUInt32LE(offset) === crc32 &&
    data.readUInt32LE(offset + 4) === compressedSize &&
    data.readUInt32LE(offset + 8) === uncompressedSize;
  const signed = hasZipRange(data, offset, 16) && offset + 16 <= directoryOffset &&
    data.readUInt32LE(offset) === 0x08074b50 &&
    data.readUInt32LE(offset + 4) === crc32 &&
    data.readUInt32LE(offset + 8) === compressedSize &&
    data.readUInt32LE(offset + 12) === uncompressedSize;
  if (unsigned === signed) throw new Error(SourceError.CORRUPTED);
  return signed ? offset + 16 : offset + 12;
}

function decodeZipName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(SourceError.CORRUPTED);
  }
}

function entryText(entries: Map<string, ZipEntry>, name: string, limits: ParserLimits): string {
  const entry = entries.get(name);
  if (!entry) throw new Error(SourceError.CORRUPTED);
  let data: Buffer;
  try {
    data = entry.method === 0 ? entry.compressed : entry.method === 8 ? inflateRawSync(entry.compressed, { maxOutputLength: limits.maxArchiveEntryBytes }) : (() => { throw new Error("unsupported"); })();
  } catch { throw new Error(SourceError.ARCHIVE_UNSAFE); }
  if (data.length !== entry.uncompressedSize) throw new Error(SourceError.CORRUPTED);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new Error(SourceError.CORRUPTED); }
}

/** ZIP entry names stay strict: no traversal segments of any kind. */
function isSafePath(path: string): boolean {
  return !!path && !path.includes("\\") && !/^(?:[\\/]|[a-zA-Z]:|\\\\)/.test(path) && !path.split("/").some((part) => part === "." || part === ".." || !part) && !/%2e|%2f|%5c/i.test(path);
}

// ---------------------------------------------------------------------------
// DOM helpers — namespace-aware (RF01-03)
// ---------------------------------------------------------------------------

/**
 * The element's namespace-clean local name. Preixed documents
 * (<opf:package>, <ncx:navMap>, <xhtml:p>) resolve to the same local names as
 * their default-namespace forms, so all structural matching below is prefix
 * independent. The tagName-suffix fallback only exists for parser builds
 * where localName may be unavailable.
 */
function localName(element: XmlElement): string {
  if (element.localName) return element.localName;
  const tagName = element.tagName || "";
  const colon = tagName.indexOf(":");
  return colon >= 0 ? tagName.slice(colon + 1) : tagName;
}

function directElementChildren(node: XmlNode): XmlElement[] {
  return Array.from(node.childNodes).filter((child): child is XmlElement => child.nodeType === 1);
}

function directElementChildrenByLocalName(node: XmlNode, name: string): XmlElement[] {
  return directElementChildren(node).filter((child) => localName(child) === name);
}

function epubType(element: XmlElement): string | null {
  const attributes = element.attributes;
  for (let index = 0; index < attributes.length; index++) {
    const attribute = attributes.item(index)!;
    if (attribute.localName === "type" && attribute.namespaceURI === EPUB_OPS_NAMESPACE) return attribute.value || null;
  }
  return element.getAttribute("epub:type") || null;
}

function collapsedText(element: XmlElement | null | undefined): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function normalizeBlockText(value: string): string {
  return normalizeCanonicalText(value.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ")).trim();
}

function fragmentIdFor(element: XmlElement): string | null {
  for (let node: XmlElement | null = element; node; node = parentElementOf(node)) {
    const id = node.getAttribute("id");
    if (id) return id;
  }
  return null;
}

function parentElementOf(element: XmlElement): XmlElement | null {
  const parent = element.parentNode;
  return parent && parent.nodeType === 1 ? (parent as XmlElement) : null;
}

/** Deterministic XPath-style path (localName-based, prefix independent); identical bytes always produce identical paths. */
function elementPathFor(element: XmlElement): string {
  const segments: string[] = [];
  for (let node: XmlElement | null = element; node; node = parentElementOf(node)) {
    const name = localName(node);
    let index = 1;
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (sibling.nodeType === 1 && localName(sibling as XmlElement) === name) index += 1;
    }
    segments.unshift(`/${name}[${index}]`);
  }
  return segments.join("");
}