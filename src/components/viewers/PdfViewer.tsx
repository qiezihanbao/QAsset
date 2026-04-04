// src/components/viewers/PdfViewer.tsx
import { useEffect, useState, useRef, useCallback } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2, BookOpen, FileText } from "lucide-react"
import * as pdfjsLib from "pdfjs-dist"

// Set worker source - use local file from public directory
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('/pdf.worker.min.mjs', window.location.origin).href

interface PdfViewerProps {
  filePath: string
  fileName: string
}

export function PdfViewer({ filePath }: PdfViewerProps) {
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [scale, setScale] = useState(1.2)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [doublePage, setDoublePage] = useState(false)
  const [offsetByOne, setOffsetByOne] = useState(false) // 错位开关：双页模式下起始偏移一页
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Load PDF document
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPdfDoc(null)
    setCurrentPage(1)
    setTotalPages(0)

    const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
    const url = isTauri ? convertFileSrc(filePath) : filePath

    const loadPdf = async () => {
      try {
        const doc = await pdfjsLib.getDocument(url).promise
        if (!cancelled) {
          setPdfDoc(doc)
          setTotalPages(doc.numPages)
          setLoading(false)
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e))
          setLoading(false)
        }
      }
    }

    loadPdf()
    return () => { cancelled = true }
  }, [filePath])

  // Render current page(s)
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return

    let cancelled = false

    const renderPages = async () => {
      try {
        const canvas = canvasRef.current!
        const ctx = canvas.getContext('2d')!

        if (!doublePage) {
          // Single page mode
          const page = await pdfDoc.getPage(currentPage)
          if (cancelled) return

          const viewport = page.getViewport({ scale })
          canvas.height = viewport.height
          canvas.width = viewport.width

          await page.render({ canvas, viewport }).promise
        } else {
          // Double page mode
          // Left page: currentPage, Right page: currentPage + 1 (or blank)
          // If offsetByOne is on, insert a blank first page (common for covers)
          const leftPageNum = currentPage
          const rightPageNum = currentPage + 1

          const leftPage = leftPageNum <= totalPages ? await pdfDoc.getPage(leftPageNum) : null
          const rightPage = rightPageNum <= totalPages ? await pdfDoc.getPage(rightPageNum) : null
          if (cancelled) return

          const leftViewport = leftPage ? leftPage.getViewport({ scale }) : null
          const rightViewport = rightPage ? rightPage.getViewport({ scale }) : null

          const singleWidth = Math.max(leftViewport?.width || 0, rightViewport?.width || 0)
          const height = Math.max(leftViewport?.height || 0, rightViewport?.height || 0)
          const gap = 4 * scale

          canvas.width = singleWidth * 2 + gap
          canvas.height = height

          // Clear canvas
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, canvas.width, canvas.height)

          // Render left page
          if (leftPage && leftViewport) {
            await leftPage.render({ canvas, viewport: leftViewport }).promise
          }

          // Render right page (translated right)
          if (rightPage && rightViewport) {
            ctx.save()
            ctx.translate(singleWidth + gap, 0)
            await rightPage.render({ canvas, viewport: rightViewport }).promise
            ctx.restore()
          }
        }
      } catch (e) {
        console.error('Failed to render page:', e)
      }
    }

    renderPages()
    return () => { cancelled = true }
  }, [pdfDoc, currentPage, scale, doublePage, totalPages])

  const goToPage = useCallback((page: number) => {
    const start = offsetByOne && doublePage ? 0 : 1
    // Ensure page snaps to correct parity for double-page mode
    let target = Math.max(start, Math.min(page, totalPages))
    if (doublePage) {
      // For double page, currentPage should always be odd (1, 3, 5...) in normal mode
      // or even (2, 4, 6...) in offset mode
      if (offsetByOne) {
        if (target % 2 !== 0) target = Math.max(2, target - 1)
      } else {
        if (target % 2 === 0) target = Math.max(1, target - 1)
      }
    }
    setCurrentPage(target)
  }, [totalPages, doublePage, offsetByOne])

  // Keyboard shortcuts for page navigation
  useEffect(() => {
    const step = doublePage ? 2 : 1

    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return

      if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault()
        goToPage(currentPage - step)
      } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault()
        goToPage(currentPage + step)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentPage, doublePage, goToPage])

  const handleZoomIn = useCallback(() => {
    setScale(s => Math.min(s + 0.2, 3))
  }, [])

  const handleZoomOut = useCallback(() => {
    setScale(s => Math.max(s - 0.2, 0.5))
  }, [])

  const toggleDoublePage = useCallback(() => {
    setDoublePage(d => {
      const newDouble = !d
      if (newDouble) {
        // Snap to correct parity
        if (offsetByOne) {
          setCurrentPage(p => (p % 2 === 0 ? p : Math.max(2, p - 1)))
        } else {
          setCurrentPage(p => (p % 2 !== 0 ? p : Math.max(1, p - 1)))
        }
      }
      return newDouble
    })
  }, [offsetByOne])

  const toggleOffset = useCallback(() => {
    setOffsetByOne(prev => {
      const newOffset = !prev
      // Re-snap current page
      if (doublePage) {
        if (newOffset) {
          setCurrentPage(p => (p % 2 === 0 ? p : Math.max(2, p - 1)))
        } else {
          setCurrentPage(p => (p % 2 !== 0 ? p : Math.max(1, p + 1)))
        }
      }
      return newOffset
    })
  }, [doublePage])

  if (loading) {
    return (
      <div className="text-white/50 flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-white/50 flex flex-col items-center justify-center h-full gap-2">
        <span className="text-4xl">⚠️</span>
        <p className="text-sm">无法加载 PDF</p>
        <p className="text-xs text-white/30 max-w-md text-center">{error}</p>
      </div>
    )
  }

  // Display info
  const step = doublePage ? 2 : 1
  const rightPage = doublePage ? Math.min(currentPage + 1, totalPages) : null

  return (
    <div className="w-full h-full flex flex-col items-center">
      {/* PDF content */}
      <div className="flex-1 overflow-auto flex items-start justify-center p-4">
        <canvas ref={canvasRef} className="shadow-2xl" />
      </div>

      {/* Page controls */}
      <div className="flex-shrink-0 flex items-center gap-2 py-3 px-4 text-white/70 text-sm bg-black/30 rounded-t-lg flex-wrap justify-center">
        <button
          onClick={() => goToPage(currentPage - step)}
          disabled={currentPage <= 1}
          className="p-1 hover:text-white hover:bg-white/10 rounded disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-white/70 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <span className="min-w-[70px] text-center">
          {doublePage ? (
            <>
              {currentPage}
              {rightPage && rightPage !== currentPage ? `-${rightPage}` : ''}
              {' / '}{totalPages}
            </>
          ) : (
            `${currentPage} / ${totalPages}`
          )}
        </span>

        <button
          onClick={() => goToPage(currentPage + step)}
          disabled={currentPage >= totalPages}
          className="p-1 hover:text-white hover:bg-white/10 rounded disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-white/70 transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        <div className="w-px h-4 bg-white/20" />

        {/* Single/Double page toggle */}
        <button
          onClick={toggleDoublePage}
          className={`p-1 rounded transition-colors ${doublePage ? 'text-blue-400 bg-blue-400/10' : 'hover:text-white hover:bg-white/10'}`}
          title={doublePage ? '切换为单页模式' : '切换为双页模式'}
        >
          {doublePage ? <BookOpen className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
        </button>

        {/* Offset toggle (only visible in double-page mode) */}
        {doublePage && (
          <button
            onClick={toggleOffset}
            className={`px-2 py-0.5 rounded text-xs transition-colors ${offsetByOne ? 'text-amber-400 bg-amber-400/10' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
            title="起始页错位：防止双页内容对不齐"
          >
            错位
          </button>
        )}

        <div className="w-px h-4 bg-white/20" />

        <button
          onClick={handleZoomOut}
          className="p-1 hover:text-white hover:bg-white/10 rounded transition-colors"
        >
          <ZoomOut className="w-4 h-4" />
        </button>

        <span className="text-xs text-white/50 w-12 text-center">{Math.round(scale * 100)}%</span>

        <button
          onClick={handleZoomIn}
          className="p-1 hover:text-white hover:bg-white/10 rounded transition-colors"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
