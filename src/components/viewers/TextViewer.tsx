// src/components/viewers/TextViewer.tsx
import { useEffect, useState, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { Loader2 } from "lucide-react"
import { getLanguageFromExt } from "./getViewerType"
import hljs from "highlight.js"

interface TextViewerProps {
  filePath: string
  fileName: string
}

export function TextViewer({ filePath, fileName }: TextViewerProps) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const codeRef = useRef<HTMLElement>(null)

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

  // Apply syntax highlighting after content loads
  useEffect(() => {
    if (content && codeRef.current) {
      const lang = getLanguageFromExt(fileName)
      if (lang) {
        try {
          hljs.highlightElement(codeRef.current)
        } catch {
          // Fallback: no highlighting
        }
      }
    }
  }, [content, fileName])

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

  const lines = content.split('\n')

  return (
    <div className="w-full h-full overflow-auto p-4">
      <div className="flex text-sm font-mono">
        {/* Line numbers */}
        <div className="flex-shrink-0 pr-4 text-right text-white/20 select-none border-r border-white/10 mr-4">
          {lines.map((_, i) => (
            <div key={i} className="leading-6">{i + 1}</div>
          ))}
        </div>
        {/* Code content */}
        <pre className="flex-1 overflow-x-auto text-white/80 leading-6 m-0">
          <code ref={codeRef} className={`language-${getLanguageFromExt(fileName) || 'plaintext'}`}>
            {content}
          </code>
        </pre>
      </div>
    </div>
  )
}