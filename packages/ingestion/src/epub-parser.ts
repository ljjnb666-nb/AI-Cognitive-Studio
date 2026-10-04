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
 * The ZIP subsystem (central-directory walking, per-entry/total/compression
 * limits, encrypted-flag rejection) stays authoritative and untouched. v2
 * replaces regex-based structure discovery with namespace-aware XML DOM
 * parsing (@xmldom/xmldom, pure JS, no network, no entity expansion) and adds
 * durable EPUB format metadata, safe archive-relative href resolution, DOM
 * locators (fragmentId + elementPath) and semantic block kinds.
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

type ZipEntry = { name: string; method: number; flags: number; compressed: Buffer; compressedSize: number; uncompressedSize: number };
type ManifestItem = { id: string; href: string; mediaType: string | null; properties: string[] };
type EpubPackage = { path: string; version: string | null; renditionLayout: EpubRenditionLayout; manifest: Map<string, ManifestItem>; spineIds: string[]; spineTocId: string | null; dcTitle: string | null; dcLanguage: string | null; dcIdentifier: string | null };
type NavigationResult = { source: EpubNavigationSource; entries: EpubNavigationEntry[]; degraded: boolean };
type BlockContext = { spineIndex: number; docPath: string; provenance: BlockExtractionProvenance; footnote: boolean; warnings: Set<ExtractionQualityWarningCode> };

export function parseEpub(bytes: Uint8Array, limits: ParserLimits, parser: ParserDescriptor): Parsed {
  const entries = readZip(bytes, limits);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  if (entryText(byName, "mimetype", limits) !== "application/epub+zip") throw new Error(SourceError.CORRUPTED);
  if (byName.has("META-INF/encryption.xml")) throw new Error(SourceError.ARCHIVE_UNSAFE);
  const provenance: BlockExtractionProvenance = { sourceMethod: parser.sourceMethod, parserName: parser.name, parserVersion: parser.version };
  const opf = readPackage(byName, limits);
  const navigation = readNavigation(opf, byName, limits);
  const warnings = new Set<ExtractionQualityWarningCode>();
  const blocks: ParsedBlock[] = [];
  let textSpineItems = 0;
  let emptyTextSpineItems = 0;
  opf.spineIds.forEach((id, spineIndex) => {
    const item = opf.manifest.get(id);
    if (!item) throw new Error(SourceError.CORRUPTED);
    const mediaType = item.mediaType ?? "";
    // Reading order is spine order; only processable content documents are
    // parsed. Images, fonts, CSS and media are never decoded, and a declared
    // non-content spine item is never a failure on its own. A manifest item
    // without a declared media-type is spec-violating but seen in legacy
    // books: attempt content parsing (v1 parity) instead of skipping it.
    if (mediaType && !CONTENT_MEDIA_TYPES.has(mediaType) && mediaType !== SVG_MEDIA_TYPE) return;
    const resource = resolveArchiveHref(opf.path, item.href);
    if (!byName.has(resource.path)) throw new Error(SourceError.CORRUPTED);
    const document = parseXmlDocument(safeXmlText(entryText(byName, resource.path, limits)), limits);
    const root = document.documentElement;
    if (!root) throw new Error(SourceError.CORRUPTED);
    const context: BlockContext = { spineIndex, docPath: resource.path, provenance, footnote: false, warnings };
    const countBefore = blocks.length;
    if (mediaType === SVG_MEDIA_TYPE) emitSvgEvidence(root, context, blocks);
    else emitBlocksFor(root, context, blocks, 0);
    // A text media-type spine document that yields nothing is degradable
    // evidence (PARTIAL_EXTRACTION); only a fully text-less extraction fails.
    if (blocks.length > countBefore) textSpineItems += 1;
    else emptyTextSpineItems += 1;
  });
  if (opf.renditionLayout === "PRE_PAGINATED") warnings.add("EPUB_FIXED_LAYOUT");
  if (emptyTextSpineItems > 0 && textSpineItems > 0) warnings.add("PARTIAL_EXTRACTION");
  if (!blocks.length) throw new Error(opf.renditionLayout === "PRE_PAGINATED" ? SourceError.EPUB_FIXED_LAYOUT_UNSUPPORTED : SourceError.OCR_REQUIRED);
  if (navigation.degraded) warnings.add("EPUB_NAVIGATION_DEGRADED");
  const formatMetadata: EpubExtractionMetadata = parseEpubExtractionMetadata({
    kind: "epub",
    epubVersion: opf.version,
    packagePath: opf.path,
    renditionLayout: opf.renditionLayout,
    spineItemCount: opf.spineIds.length,
    navigationSource: navigation.source,
    navigation: navigation.entries,
    dcTitle: opf.dcTitle,
    dcLanguage: opf.dcLanguage,
    dcIdentifier: opf.dcIdentifier,
  });
  return { parser, pages: [{ physicalPageIndex: null, blocks }], qualityWarnings: [...warnings], formatMetadata };
}

// ---------------------------------------------------------------------------
// Package (container.xml + OPF)
// ---------------------------------------------------------------------------

function readPackage(byName: Map<string, ZipEntry>, limits: ParserLimits): EpubPackage {
  const container = parseXmlDocument(safeXmlText(entryText(byName, "META-INF/container.xml", limits)), limits);
  const candidates = Array.from(container.getElementsByTagName("rootfile")).filter((rootfile) => {
    const mediaType = rootfile.getAttribute("media-type");
    // OCF: a rootfile without media-type defaults to the OPF media type.
    return !mediaType || mediaType === OPF_MEDIA_TYPE;
  });
  let opfPath: string | null = null;
  for (const candidate of candidates) {
    const fullPath = candidate.getAttribute("full-path");
    if (!fullPath) continue;
    const resolved = resolveArchiveHref("", fullPath);
    if (byName.has(resolved.path)) { opfPath = resolved.path; break; }
  }
  if (!opfPath) throw new Error(SourceError.CORRUPTED);
  const opf = parseXmlDocument(safeXmlText(entryText(byName, opfPath, limits)), limits);
  const packageElement = opf.documentElement;
  if (!packageElement || localTag(packageElement) !== "package") throw new Error(SourceError.CORRUPTED);
  const manifestElement = opf.getElementsByTagName("manifest")[0];
  const spineElement = opf.getElementsByTagName("spine")[0];
  if (!manifestElement || !spineElement) throw new Error(SourceError.CORRUPTED);
  const manifest = new Map<string, ManifestItem>();
  for (const item of Array.from(manifestElement.getElementsByTagName("item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    manifest.set(id, { id, href, mediaType: item.getAttribute("media-type") || null, properties: (item.getAttribute("properties") || "").split(/\s+/).filter(Boolean) });
  }
  const spineIds = Array.from(spineElement.getElementsByTagName("itemref")).map((itemref) => itemref.getAttribute("idref")).filter((id): id is string => !!id);
  // Reading order is spine-authoritative; manifest order is never a fallback.
  if (!spineIds.length) throw new Error(SourceError.CORRUPTED);
  return {
    path: opfPath,
    version: packageElement.getAttribute("version") || null,
    renditionLayout: readRenditionLayout(packageElement, opf),
    manifest,
    spineIds,
    spineTocId: spineElement.getAttribute("toc") || null,
    dcTitle: dcElementText(opf, "title"),
    dcLanguage: dcElementText(opf, "language"),
    dcIdentifier: dcElementText(opf, "identifier"),
  };
}

function readRenditionLayout(packageElement: XmlElement, opf: XmlDocument): EpubRenditionLayout {
  for (const meta of Array.from(opf.getElementsByTagName("meta"))) {
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

function dcElementText(opf: XmlDocument, localName: string): string | null {
  const namespaces = [opf.getElementsByTagNameNS(DC_ELEMENTS_NAMESPACE, localName), opf.getElementsByTagName(`dc:${localName}`)];
  for (const list of namespaces) {
    const text = collapsedText(list[0]);
    if (text) return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Navigation (EPUB3 nav preferred, EPUB2 NCX fallback) — evidence only
// ---------------------------------------------------------------------------

function readNavigation(opf: EpubPackage, byName: Map<string, ZipEntry>, limits: ParserLimits): NavigationResult {
  try {
    const navItem = [...opf.manifest.values()].find((item) => item.properties.includes("nav"));
    if (navItem) {
      const document = loadNavigationResource(navItem, opf, byName, limits);
      const entries = flattenEpub3Nav(document, resolveNavDocumentPath(navItem, opf, byName), limits);
      return entries.length ? { source: "EPUB3_NAV", entries, degraded: false } : { source: "NONE", entries: [], degraded: true };
    }
    // No EPUB3 nav: EPUB2 NCX via spine toc, then any declared NCX manifest item.
    const ncxItem = (opf.spineTocId ? opf.manifest.get(opf.spineTocId) : undefined) ?? [...opf.manifest.values()].find((item) => item.mediaType === NCX_MEDIA_TYPE);
    if (ncxItem) {
      const document = loadNavigationResource(ncxItem, opf, byName, limits);
      const entries = flattenNcx(document, resolveNavDocumentPath(ncxItem, opf, byName), limits);
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

function loadNavigationResource(item: ManifestItem, opf: EpubPackage, byName: Map<string, ZipEntry>, limits: ParserLimits): XmlDocument {
  return parseXmlDocument(safeXmlText(entryText(byName, resolveNavDocumentPath(item, opf, byName), limits)), limits);
}

function resolveNavDocumentPath(item: ManifestItem, opf: EpubPackage, byName: Map<string, ZipEntry>): string {
  const resolved = resolveArchiveHref(opf.path, item.href);
  if (!byName.has(resolved.path)) throw new Error(SourceError.CORRUPTED);
  return resolved.path;
}

function flattenEpub3Nav(document: XmlDocument, navDocumentPath: string, limits: ParserLimits): EpubNavigationEntry[] {
  const navs = Array.from(document.getElementsByTagName("nav"));
  if (!navs.length) throw new Error(NAV_STRUCTURAL_FAILURE);
  const tocNav = navs.find((nav) => (epubType(nav) || "").split(/\s+/).includes("toc")) ?? navs.find((nav) => (nav.getAttribute("hidden") || "") !== "hidden") ?? navs[0]!;
  const firstList = directElementChildren(tocNav).find((child) => localTag(child) === "ol");
  if (!firstList) throw new Error(NAV_STRUCTURAL_FAILURE);
  const entries: EpubNavigationEntry[] = [];
  walkEpub3NavList(firstList, 0, entries, navDocumentPath, limits);
  return entries;
}

function walkEpub3NavList(list: XmlElement, depth: number, entries: EpubNavigationEntry[], navDocumentPath: string, limits: ParserLimits): void {
  if (depth > MAX_NAVIGATION_DEPTH) throw new Error(NAV_STRUCTURAL_FAILURE);
  for (const li of directElementChildren(list).filter((child) => localTag(child) === "li")) {
    assertNavigationCapacity(entries, limits);
    const anchor = directElementChildren(li).find((child) => localTag(child) === "a" || localTag(child) === "span");
    const label = collapsedText(anchor);
    const href = anchor && localTag(anchor) === "a" ? anchor.getAttribute("href") : null;
    if (label && href) {
      const resolved = resolveArchiveHref(navDocumentPath, href);
      entries.push({ ordinal: entries.length, depth, label, href: resolved.path, fragmentId: resolved.fragmentId });
    }
    for (const nested of directElementChildren(li).filter((child) => localTag(child) === "ol")) walkEpub3NavList(nested, depth + 1, entries, navDocumentPath, limits);
  }
}

function flattenNcx(document: XmlDocument, ncxPath: string, limits: ParserLimits): EpubNavigationEntry[] {
  const navMap = document.getElementsByTagName("navMap")[0];
  if (!navMap) throw new Error(NAV_STRUCTURAL_FAILURE);
  const entries: EpubNavigationEntry[] = [];
  for (const navPoint of directElementChildren(navMap).filter((child) => localTag(child) === "navpoint")) walkNcxNavPoint(navPoint, 0, entries, ncxPath, limits);
  return entries;
}

function walkNcxNavPoint(navPoint: XmlElement, depth: number, entries: EpubNavigationEntry[], ncxPath: string, limits: ParserLimits): void {
  if (depth > MAX_NAVIGATION_DEPTH) throw new Error(NAV_STRUCTURAL_FAILURE);
  assertNavigationCapacity(entries, limits);
  // Direct children only: a nested navPoint owns its own navLabel/content.
  const navLabel = directElementChildren(navPoint).find((child) => localTag(child) === "navlabel");
  const label = collapsedText(navLabel ? directElementChildren(navLabel).find((child) => localTag(child) === "text") : null);
  const src = directElementChildren(navPoint).find((child) => localTag(child) === "content")?.getAttribute("src") ?? null;
  if (label && src) {
    const resolved = resolveArchiveHref(ncxPath, src);
    entries.push({ ordinal: entries.length, depth, label, href: resolved.path, fragmentId: resolved.fragmentId });
  }
  for (const nested of directElementChildren(navPoint).filter((child) => localTag(child) === "navpoint")) walkNcxNavPoint(nested, depth + 1, entries, ncxPath, limits);
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
 * fragment is separated here and never participates in archive lookup.
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
  const tag = localTag(element);
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
    const tag = localTag(elementChild);
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
  const caption = directElementChildren(table).find((child) => localTag(child) === "caption");
  if (caption) emitInlineBlock(caption, context, blocks, "CAPTION", { flatten: true });
  let flattened = false;
  const sections = directElementChildren(table).filter((child) => ["thead", "tbody", "tfoot"].includes(localTag(child)));
  const rowSources = [...sections.flatMap((section) => directElementChildren(section).filter((child) => localTag(child) === "tr")), ...directElementChildren(table).filter((child) => localTag(child) === "tr")];
  const rows: string[] = [];
  for (const row of rowSources) {
    const cells: string[] = [];
    for (const cell of directElementChildren(row)) {
      const cellTag = localTag(cell);
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
  const annotations = [...Array.from(math.getElementsByTagName("annotation")), ...Array.from(math.getElementsByTagName("annotation-xml"))];
  const tex = annotations.find((annotation) => (annotation.getAttribute("encoding") || "").trim() === "application/x-tex");
  const alttext = (math.getAttribute("alttext") || "").trim();
  const text = (tex && collapsedText(tex)) || (alttext && alttext.replace(/\s+/g, " ")) || collapsedText(math);
  if (!text) return;
  emitOwnedBlocks(context.footnote ? "FOOTNOTE" : "EQUATION", text, math, context, blocks, null);
}

function emitSvgEvidence(svg: XmlElement, context: BlockContext, blocks: ParsedBlock[]): void {
  // SVG is never rendered or executed: only deterministic accessibility text.
  const text = collapsedText(svg.getElementsByTagName("title")[0]) || collapsedText(svg.getElementsByTagName("desc")[0]);
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

function parseXmlDocument(xml: string, limits: ParserLimits): XmlDocument {
  if (xml.length > limits.maxEpubXmlChars) throw new Error(SourceError.TOO_LARGE);
  const problems: string[] = [];
  let document: XmlDocument;
  try {
    document = new DOMParser({ onError: (level, message) => { if (level !== "warning") problems.push(`${level}: ${message}`); } }).parseFromString(decodeHtmlNamedEntities(xml), "application/xml");
  } catch {
    throw new Error(SourceError.CORRUPTED);
  }
  if (!document.documentElement) throw new Error(SourceError.CORRUPTED);
  // Non-fatal well-formedness problems (e.g. an entity the strict XML grammar
  // does not define) never silently leak literal markup into canonical text.
  if (problems.length) throw new Error(SourceError.CORRUPTED);
  return document;
}

/**
 * XHTML content documents routinely use HTML named entities that strict XML
 * leaves undefined. They are pre-mapped to real characters with a fixed,
 * repo-local HTML4 table before parsing; anything outside the table still
 * fails closed via the parser error gate above.
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
    "quot:34 amp:38 lt:60 gt:62 apos:39 " +
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
      return [entry.slice(0, separator), String.fromCodePoint(Number(entry.slice(separator + 1)))];
    }),
);

function decodeHtmlNamedEntities(xml: string): string {
  if (!xml.includes("&")) return xml;
  return xml.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => HTML_NAMED_ENTITIES[name] ?? match);
}

/** DTD constructs are rejected before the parser ever sees them. */
function safeXmlText(xml: string): string {
  if (/<!DOCTYPE|<!ENTITY|<!ATTLIST|<!NOTATION/i.test(xml) || /<![^>[]*\b(?:SYSTEM|PUBLIC)\b/i.test(xml)) throw new Error(SourceError.ARCHIVE_UNSAFE);
  if (/\b(?:src|href|xlink:href)\s*=\s*["'](?:https?:|file:)/i.test(xml)) throw new Error(SourceError.ARCHIVE_UNSAFE);
  return xml;
}

function readZip(bytes: Uint8Array, limits: ParserLimits): ZipEntry[] {
  const data = Buffer.from(bytes);
  const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > data.length) throw new Error(SourceError.CORRUPTED);
  const count = data.readUInt16LE(eocd + 10), directoryOffset = data.readUInt32LE(eocd + 16);
  if (count > limits.maxArchiveEntries || directoryOffset >= data.length) throw new Error(SourceError.ARCHIVE_UNSAFE);
  let offset = directoryOffset, total = 0;
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error(SourceError.CORRUPTED);
    const flags = data.readUInt16LE(offset + 8), method = data.readUInt16LE(offset + 10), compressedSize = data.readUInt32LE(offset + 20), uncompressedSize = data.readUInt32LE(offset + 24), nameLength = data.readUInt16LE(offset + 28), extraLength = data.readUInt16LE(offset + 30), commentLength = data.readUInt16LE(offset + 32), localOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if ((flags & 1) || !isSafePath(name) || uncompressedSize > limits.maxArchiveEntryBytes || (compressedSize && uncompressedSize / compressedSize > limits.maxArchiveCompressionRatio)) throw new Error(SourceError.ARCHIVE_UNSAFE);
    total += uncompressedSize;
    if (total > limits.maxArchiveTotalBytes || data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(SourceError.ARCHIVE_UNSAFE);
    const localName = data.readUInt16LE(localOffset + 26), localExtra = data.readUInt16LE(localOffset + 28), start = localOffset + 30 + localName + localExtra;
    entries.push({ name, method, flags, compressed: data.subarray(start, start + compressedSize), compressedSize, uncompressedSize });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryText(entries: Map<string, ZipEntry>, name: string, limits: ParserLimits): string {
  const entry = entries.get(name);
  if (!entry) throw new Error(SourceError.CORRUPTED);
  let data: Buffer;
  try {
    data = entry.method === 0 ? entry.compressed : entry.method === 8 ? inflateEntry(entry, limits) : (() => { throw new Error("unsupported"); })();
  } catch { throw new Error(SourceError.ARCHIVE_UNSAFE); }
  if (data.length !== entry.uncompressedSize) throw new Error(SourceError.CORRUPTED);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new Error(SourceError.CORRUPTED); }
}

function inflateEntry(entry: ZipEntry, limits: ParserLimits): Buffer {
  return inflateRawSync(entry.compressed, { maxOutputLength: limits.maxArchiveEntryBytes });
}

/** ZIP entry names stay strict: no traversal segments of any kind. */
function isSafePath(path: string): boolean {
  return !!path && !/^(?:[\\/]|[a-zA-Z]:|\\\\)/.test(path) && !path.split(/[\\/]/).some((part) => part === ".." || !part) && !/%2e|%2f|%5c/i.test(path);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function localTag(element: XmlElement): string {
  return (element.tagName || "").toLowerCase();
}

function directElementChildren(node: XmlNode): XmlElement[] {
  return Array.from(node.childNodes).filter((child): child is XmlElement => child.nodeType === 1);
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

/** Deterministic XPath-style path; identical bytes always produce identical paths. */
function elementPathFor(element: XmlElement): string {
  const segments: string[] = [];
  for (let node: XmlElement | null = element; node; node = parentElementOf(node)) {
    const tag = node.tagName;
    let index = 1;
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (sibling.nodeType === 1 && (sibling as XmlElement).tagName === tag) index += 1;
    }
    segments.unshift(`/${tag}[${index}]`);
  }
  return segments.join("");
}
