// src/components/viewers/getViewerType.ts

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
  'tif', 'tiff', 'jfif', 'jpe', 'jxl', 'base64', 'heic', 'heif',
  'hif', 'icns', 'eps', 'ttf', 'insp'
])

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'go', 'sh', 'bat', 'css', 'html', 'sql', 'rb', 'php', 'swift', 'kt',
  'dart', 'lua', 'r', 'vue', 'svelte', 'mdx', 'ps1', 'conf', 'env',
  'gitignore', 'dockerfile', 'makefile', 'cmake', 'gradle', 'properties'
])

const MARKDOWN_EXTENSIONS = new Set(['md'])

const PDF_EXTENSIONS = new Set(['pdf'])

export type ViewerType = 'image' | 'pdf' | 'text' | 'markdown' | 'unsupported'

export function getViewerType(fileName: string, assetType: string): ViewerType {
  const ext = fileName.includes('.')
    ? fileName.split('.').pop()!.toLowerCase()
    : ''

  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext) || assetType === 'image' || assetType === 'vector') return 'image'
  return 'unsupported'
}

export function getLanguageFromExt(fileName: string): string | undefined {
  const ext = fileName.includes('.')
    ? fileName.split('.').pop()!.toLowerCase()
    : ''

  const extToLang: Record<string, string> = {
    'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
    'py': 'python', 'rs': 'rust', 'java': 'java', 'c': 'c', 'cpp': 'cpp',
    'h': 'c', 'hpp': 'cpp', 'go': 'go', 'sh': 'bash', 'bat': 'batch',
    'css': 'css', 'html': 'xml', 'sql': 'sql', 'rb': 'ruby', 'php': 'php',
    'swift': 'swift', 'kt': 'kotlin', 'dart': 'dart', 'lua': 'lua',
    'r': 'r', 'vue': 'xml', 'svelte': 'xml', 'json': 'json',
    'yaml': 'yaml', 'yml': 'yaml', 'xml': 'xml', 'toml': 'ini',
    'ini': 'ini', 'cfg': 'ini', 'csv': 'plaintext', 'log': 'log',
    'md': 'markdown', 'mdx': 'markdown',
  }

  return extToLang[ext]
}