// src/components/viewers/MarkdownViewer.tsx
import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { Loader2 } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"

interface MarkdownViewerProps {
  filePath: string
  fileName: string
}

export function MarkdownViewer({ filePath, fileName: _fileName }: MarkdownViewerProps) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)

    const loadText = async () => {
      try {
        const text = await invoke<string>("read_file_text", { path: filePath })
        if (!cancelled) setContent(text)
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    }

    loadText()
    return () => { cancelled = true }
  }, [filePath])

  if (error) {
    return (
      <div className="text-white/50 flex flex-col items-center justify-center h-full gap-2">
        <span className="text-4xl">⚠️</span>
        <p className="text-sm">无法读取文件</p>
        <p className="text-xs text-white/30 max-w-md text-center">{error}</p>
      </div>
    )
  }

  if (content === null) {
    return (
      <div className="text-white/50 flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="w-full h-full overflow-auto p-6 md:p-10">
      <div className="markdown-body max-w-3xl mx-auto">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}