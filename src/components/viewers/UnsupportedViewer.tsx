// src/components/viewers/UnsupportedViewer.tsx
import { invoke } from "@tauri-apps/api/core"
import { FileText, ExternalLink } from "lucide-react"

interface UnsupportedViewerProps {
  fileName: string
  filePath: string
  fileSize: number
  assetType: string
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function UnsupportedViewer({ fileName, filePath, fileSize, assetType }: UnsupportedViewerProps) {
  const handleOpenExternally = async () => {
    try {
      await invoke("open_in_default_app", { path: filePath })
    } catch (e) {
      console.error("Failed to open file:", e)
    }
  }

  return (
    <div className="text-white/60 flex flex-col items-center justify-center h-full gap-3">
      <FileText className="w-16 h-16 text-white/30" />
      <p className="text-lg font-medium">不支持预览该文件格式</p>
      <div className="text-sm text-white/40 text-center space-y-1">
        <p>{fileName}</p>
        <p>{formatFileSize(fileSize)} · {assetType}</p>
      </div>
      <button
        onClick={handleOpenExternally}
        className="mt-2 flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 hover:text-white transition-colors text-sm"
      >
        <ExternalLink className="w-4 h-4" />
        用系统默认程序打开
      </button>
    </div>
  )
}