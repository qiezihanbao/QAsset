import { invoke } from "@tauri-apps/api/core"

export type NativeImageImport =
  | {
      kind: "url"
      url: string
      pageUrl?: string
      pageTitle?: string
    }
  | {
      kind: "blob"
      blob: Blob
      fileName?: string
      contentType?: string
      sourceUrl?: string
      pageUrl?: string
      pageTitle?: string
    }

export interface NativeImageImportResult {
  ok: boolean
  asset_path: string
  relative_path: string
  source_url?: string | null
}

const QUICKASSET_DRAG_TYPES = new Set([
  "application/x-quickasset-assets",
  "application/x-quickasset-folder",
])

const URL_TRANSFER_TYPES = new Set([
  "text/uri-list",
  "text/html",
  "text/plain",
  "downloadurl",
  "application/x-moz-file-promise-url",
])

const IMAGE_URL_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico|svg)(?:[?#].*)?$/i

function nullable(value?: string): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function transferTypes(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer?.types) return []
  return Array.from(dataTransfer.types).map((type) => type.toLowerCase())
}

export function isQuickAssetInternalDrag(dataTransfer: DataTransfer | null): boolean {
  return transferTypes(dataTransfer).some((type) => QUICKASSET_DRAG_TYPES.has(type))
}

export function hasExternalImageTransferHint(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer || isQuickAssetInternalDrag(dataTransfer)) return false

  const types = transferTypes(dataTransfer)
  return types.some((type) => URL_TRANSFER_TYPES.has(type))
}

export function hasUrlTransferData(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer || isQuickAssetInternalDrag(dataTransfer)) return false
  return transferTypes(dataTransfer).some((type) => URL_TRANSFER_TYPES.has(type))
}

export function dataTransferHasImageFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer || isQuickAssetInternalDrag(dataTransfer)) return false

  const items = dataTransfer.items ? Array.from(dataTransfer.items) : []
  if (items.some((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))) {
    return true
  }

  const files = dataTransfer.files ? Array.from(dataTransfer.files) : []
  return files.some((file) => file.type.toLowerCase().startsWith("image/") || isLikelyImageFileName(file.name))
}

export function extractImageFileImports(dataTransfer: DataTransfer | null): NativeImageImport[] {
  if (!dataTransfer || isQuickAssetInternalDrag(dataTransfer)) return []

  const imports: NativeImageImport[] = []
  const seen = new Set<string>()

  const addFile = (file: File | null) => {
    if (!file) return
    const contentType = file.type || undefined
    if (!contentType?.toLowerCase().startsWith("image/") && !isLikelyImageFileName(file.name)) {
      return
    }

    const signature = `file:${file.name}:${file.size}:${file.type}:${file.lastModified}`
    if (seen.has(signature)) return
    seen.add(signature)

    imports.push({
      kind: "blob",
      blob: file,
      fileName: file.name || undefined,
      contentType,
      pageTitle: file.name ? stripFileExtension(file.name) : undefined,
    })
  }

  if (dataTransfer.items) {
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind !== "file") continue
      addFile(item.getAsFile())
    }
  }

  for (const file of Array.from(dataTransfer.files || [])) {
    addFile(file)
  }

  return imports
}

export async function extractImageImportsFromDataTransfer(dataTransfer: DataTransfer | null): Promise<NativeImageImport[]> {
  if (!dataTransfer || isQuickAssetInternalDrag(dataTransfer)) return []

  const imports: NativeImageImport[] = []
  const addImports = (next: NativeImageImport[]) => imports.push(...next)

  addImports(extractImportsFromDownloadUrl(dataTransfer.getData("DownloadURL")))
  addImports(importsFromUrlList(dataTransfer.getData("text/uri-list"), true))
  addImports(await extractImportsFromHtml(dataTransfer.getData("text/html")))
  addImports(importsFromPlainText(dataTransfer.getData("text/plain")))
  addImports(extractImageFileImports(dataTransfer))

  return dedupeImports(imports)
}

export async function extractImageImportsFromClipboardData(clipboardData: DataTransfer | null): Promise<NativeImageImport[]> {
  if (!clipboardData) return []

  const imports: NativeImageImport[] = []
  imports.push(...extractImageFileImports(clipboardData))
  imports.push(...await extractImportsFromHtml(clipboardData.getData("text/html")))
  imports.push(...importsFromUrlList(clipboardData.getData("text/uri-list"), true))
  imports.push(...importsFromPlainText(clipboardData.getData("text/plain")))

  return dedupeImports(imports)
}

export async function readNavigatorClipboardImageImports(): Promise<NativeImageImport[]> {
  const clipboard = navigator.clipboard as Clipboard & {
    read?: () => Promise<ClipboardItem[]>
  }
  if (!clipboard?.read) return []

  const imports: NativeImageImport[] = []
  const items = await clipboard.read()

  for (const item of items) {
    const imageType = item.types.find((type) => type.toLowerCase().startsWith("image/"))
    if (imageType) {
      const blob = await item.getType(imageType)
      imports.push({
        kind: "blob",
        blob,
        contentType: imageType,
        pageTitle: "clipboard-image",
      })
      continue
    }

    const htmlType = item.types.find((type) => type.toLowerCase() === "text/html")
    if (htmlType) {
      const html = await (await item.getType(htmlType)).text()
      imports.push(...await extractImportsFromHtml(html))
      continue
    }

    const textType = item.types.find((type) => type.toLowerCase() === "text/plain")
    if (textType) {
      const text = await (await item.getType(textType)).text()
      imports.push(...importsFromPlainText(text))
    }
  }

  return dedupeImports(imports)
}

export async function runNativeImageImport(item: NativeImageImport): Promise<NativeImageImportResult> {
  if (item.kind === "url") {
    return invoke<NativeImageImportResult>("import_image_url", {
      imageUrl: item.url,
      image_url: item.url,
      pageUrl: nullable(item.pageUrl),
      page_url: nullable(item.pageUrl),
      pageTitle: nullable(item.pageTitle),
      page_title: nullable(item.pageTitle),
    })
  }

  const bytesBase64 = await blobToBase64(item.blob)
  const contentType = item.contentType || item.blob.type || undefined
  return invoke<NativeImageImportResult>("import_image_bytes", {
    bytesBase64,
    bytes_base64: bytesBase64,
    sourceUrl: nullable(item.sourceUrl),
    source_url: nullable(item.sourceUrl),
    pageUrl: nullable(item.pageUrl),
    page_url: nullable(item.pageUrl),
    pageTitle: nullable(item.pageTitle),
    page_title: nullable(item.pageTitle),
    fileName: nullable(item.fileName),
    file_name: nullable(item.fileName),
    contentType: nullable(contentType),
    content_type: nullable(contentType),
  })
}

async function extractImportsFromHtml(rawHtml: string): Promise<NativeImageImport[]> {
  const html = rawHtml?.trim()
  if (!html) return []

  const sourceUrl = parseClipboardSourceUrl(html)
  const doc = new DOMParser().parseFromString(html, "text/html")
  const pageTitle = doc.querySelector("title")?.textContent?.trim() || undefined
  const imports: NativeImageImport[] = []

  const addUrl = async (rawUrl?: string | null, requireLikelyImage = false) => {
    const next = await importFromPotentialUrl(rawUrl, {
      pageUrl: sourceUrl,
      pageTitle,
      requireLikelyImage,
      resolveBaseUrl: sourceUrl,
    })
    if (next) imports.push(next)
  }

  for (const img of Array.from(doc.querySelectorAll("img"))) {
    await addUrl(
      img.getAttribute("src")
        || img.getAttribute("data-src")
        || img.getAttribute("data-original")
        || firstSrcsetUrl(img.getAttribute("srcset")),
    )
  }

  for (const source of Array.from(doc.querySelectorAll("source[srcset]"))) {
    await addUrl(firstSrcsetUrl(source.getAttribute("srcset")))
  }

  for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
    await addUrl(anchor.getAttribute("href"), true)
  }

  return dedupeImports(imports)
}

function extractImportsFromDownloadUrl(raw: string): NativeImageImport[] {
  const value = raw?.trim()
  if (!value) return []

  const match = value.match(/^[^:]*:([^:]*):(https?:\/\/.+)$/i)
  if (!match) {
    return importsFromUrlList(value, true)
  }

  return [{
    kind: "url",
    url: match[2],
    pageTitle: stripFileExtension(match[1]),
  }]
}

function importsFromUrlList(raw: string, acceptAnyHttpUrl: boolean): NativeImageImport[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))

  return lines
    .map((line) => importFromPotentialUrlSync(line, { acceptAnyHttpUrl }))
    .filter((item): item is NativeImageImport => Boolean(item))
}

function importsFromPlainText(raw: string): NativeImageImport[] {
  const text = raw?.trim()
  if (!text) return []

  return text
    .split(/\s+/)
    .map((part) => importFromPotentialUrlSync(part, { acceptAnyHttpUrl: false }))
    .filter((item): item is NativeImageImport => Boolean(item))
}

async function importFromPotentialUrl(
  rawUrl: string | null | undefined,
  options: {
    pageUrl?: string
    pageTitle?: string
    requireLikelyImage?: boolean
    resolveBaseUrl?: string
  },
): Promise<NativeImageImport | null> {
  const url = normalizePotentialUrl(rawUrl, options.resolveBaseUrl)
  if (!url) return null

  if (url.toLowerCase().startsWith("data:image/")) {
    const blob = await fetch(url).then((response) => response.blob())
    return {
      kind: "blob",
      blob,
      contentType: blob.type || dataUrlContentType(url),
      pageUrl: options.pageUrl,
      pageTitle: options.pageTitle || "embedded-image",
    }
  }

  if (!/^https?:\/\//i.test(url)) return null
  if (options.requireLikelyImage && !isLikelyImageUrl(url)) return null

  return {
    kind: "url",
    url,
    pageUrl: options.pageUrl,
    pageTitle: options.pageTitle,
  }
}

function importFromPotentialUrlSync(
  rawUrl: string | null | undefined,
  options: { acceptAnyHttpUrl: boolean },
): NativeImageImport | null {
  const url = normalizePotentialUrl(rawUrl)
  if (!url) return null

  if (url.toLowerCase().startsWith("data:image/")) {
    return null
  }

  if (!/^https?:\/\//i.test(url)) return null
  if (!options.acceptAnyHttpUrl && !isLikelyImageUrl(url)) return null

  return { kind: "url", url }
}

function normalizePotentialUrl(rawUrl: string | null | undefined, baseUrl?: string): string | null {
  let value = rawUrl?.trim().replace(/^["']+|["']+$/g, "")
  if (!value) return null

  if (value.startsWith("//")) {
    value = `https:${value}`
  }

  if (/^data:image\//i.test(value)) return value

  try {
    return new URL(value, baseUrl || undefined).toString()
  } catch {
    return null
  }
}

function parseClipboardSourceUrl(html: string): string | undefined {
  const match = html.match(/^SourceURL:(.+)$/im)
  const url = normalizePotentialUrl(match?.[1])
  return url && /^https?:\/\//i.test(url) ? url : undefined
}

function firstSrcsetUrl(srcset: string | null): string | null {
  if (!srcset) return null
  const first = srcset.split(",")[0]?.trim()
  return first?.split(/\s+/)[0] || null
}

function isLikelyImageUrl(url: string): boolean {
  if (url.toLowerCase().startsWith("data:image/")) return true
  try {
    const parsed = new URL(url)
    return IMAGE_URL_EXT_RE.test(parsed.pathname + parsed.search)
  } catch {
    return IMAGE_URL_EXT_RE.test(url)
  }
}

function isLikelyImageFileName(fileName: string): boolean {
  return IMAGE_URL_EXT_RE.test(fileName)
}

function stripFileExtension(fileName?: string): string | undefined {
  const name = fileName?.trim()
  if (!name) return undefined
  return name.replace(/\.[^.]+$/, "") || undefined
}

function dataUrlContentType(dataUrl: string): string | undefined {
  const match = dataUrl.match(/^data:([^;,]+)/i)
  return match?.[1]
}

function dedupeImports(imports: NativeImageImport[]): NativeImageImport[] {
  const seen = new Set<string>()
  const out: NativeImageImport[] = []

  for (const item of imports) {
    const signature = item.kind === "url"
      ? `url:${item.url}`
      : `blob:${item.fileName || ""}:${item.contentType || item.blob.type || ""}:${item.blob.size}`
    if (seen.has(signature)) continue
    seen.add(signature)
    out.push(item)
  }

  return out
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error("Failed to read image data"))
    reader.onload = () => {
      const dataUrl = String(reader.result || "")
      const comma = dataUrl.indexOf(",")
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl)
    }
    reader.readAsDataURL(blob)
  })
}
