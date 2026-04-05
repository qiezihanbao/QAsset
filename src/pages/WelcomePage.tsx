import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen, Plus, Clock } from 'lucide-react'
import { useAssetStore } from '@/store/useAssetStore'

export function WelcomePage({ onOpenLibrary }: { onOpenLibrary: (path: string) => void }) {
  const { recentLibraries } = useAssetStore()
  const [isCreating, setIsCreating] = useState(false)
  const [libraryName, setLibraryName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    setError(null)
    try {
      const path = await open({ directory: true, title: '选择素材库位置' })
      if (!path || typeof path !== 'string') return

      const name = libraryName.trim() || '我的素材库'
      await invoke('create_library', { path, name })
      onOpenLibrary(path)
    } catch (e: unknown) {
      setError(String(e) || '创建素材库失败')
    }
  }

  const handleOpen = async () => {
    setError(null)
    try {
      const path = await open({ directory: true, title: '选择素材库文件夹' })
      if (!path || typeof path !== 'string') return
      onOpenLibrary(path)
    } catch (e: unknown) {
      setError(String(e) || '打开素材库失败')
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="text-center max-w-md w-full px-6">
        <div className="w-16 h-16 rounded-2xl bg-indigo-500 flex items-center justify-center mx-auto mb-6 shadow-lg">
          <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">QuickAsset</h1>
        <p className="text-zinc-500 mb-8">选择一个素材库开始使用</p>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-lg text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {isCreating ? (
          <div className="space-y-3">
            <input
              autoFocus
              type="text"
              value={libraryName}
              onChange={(e) => setLibraryName(e.target.value)}
              placeholder="素材库名称 (可选)"
              className="w-full px-4 py-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-indigo-500 transition-colors"
            />
            <button
              onClick={handleCreate}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors"
            >
              <Plus className="w-5 h-5" />
              <span>选择位置并创建</span>
            </button>
            <button
              onClick={() => { setIsCreating(false); setLibraryName(''); setError(null) }}
              className="w-full px-4 py-2 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
            >
              取消
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <button
              onClick={() => setIsCreating(true)}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors"
            >
              <Plus className="w-5 h-5" />
              <span>新建素材库</span>
            </button>

            <button
              onClick={handleOpen}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-zinc-700 dark:text-zinc-300"
            >
              <FolderOpen className="w-5 h-5" />
              <span>打开素材库</span>
            </button>
          </div>
        )}

        {recentLibraries.length > 0 && (
          <div className="mt-8">
            <h3 className="text-sm font-medium text-zinc-500 mb-3">最近打开</h3>
            <div className="space-y-2">
              {recentLibraries.slice(0, 5).map((lib) => (
                <button
                  key={lib.path}
                  onClick={() => onOpenLibrary(lib.path)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-left"
                >
                  <Clock className="w-4 h-4 text-zinc-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 truncate">{lib.name}</p>
                    <p className="text-xs text-zinc-400 truncate">{lib.path}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
