import { useEffect } from "react"
import { useAssetStore } from "@/store/useAssetStore"
import { useShallow } from "zustand/react/shallow"

export function TagsView() {
  const [setActiveView, setTagFilter, tagsSummary, isLoadingTagsSummary, refreshTagsSummary] =
    useAssetStore(useShallow(
      (s) => [s.setActiveView, s.setTagFilter, s.tagsSummary, s.isLoadingTagsSummary, s.refreshTagsSummary]
    ))

  useEffect(() => {
    // Only fetch if we don't have data yet
    if (Object.keys(tagsSummary).length === 0) {
      refreshTagsSummary()
    }
  }, [refreshTagsSummary, tagsSummary])

  // Group tags by first letter (Pinyin/English)
  const getFirstChar = (str: string) => {
    const char = str.charAt(0).toUpperCase()
    if (/[A-Z]/.test(char)) return char
    return '#'
  }

  const groupedTags: Record<string, Array<{name: string, count: number}>> = {}
  Object.entries(tagsSummary).forEach(([name, count]) => {
    const group = getFirstChar(name)
    if (!groupedTags[group]) groupedTags[group] = []
    groupedTags[group].push({ name, count })
  })

  // Sort groups
  const sortedGroups = Object.keys(groupedTags).sort()

  const handleTagClick = (tag: string) => {
    setTagFilter([tag])
    setActiveView('all')
  }

  if (isLoadingTagsSummary) {
    return (
      <div className="flex-1 flex flex-col h-full bg-white dark:bg-[#121212] overflow-hidden">
        <div className="flex-1 flex items-center justify-center text-zinc-500">
          <div className="flex flex-col items-center gap-3">
            <div className="w-6 h-6 border-2 border-zinc-300 border-t-indigo-500 rounded-full animate-spin" />
            <span>正在加载标签...</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-[#121212] overflow-hidden">
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold mb-8 text-zinc-900 dark:text-white">全部标签</h2>

          {Object.keys(tagsSummary).length === 0 ? (
            <div className="text-zinc-500 flex flex-col items-center justify-center py-20">
              <p>暂无标签</p>
              <p className="text-sm mt-2">请先在右侧边栏为资产添加标签。</p>
            </div>
          ) : (
            <div className="space-y-10">
              {sortedGroups.map(group => (
                <div key={group}>
                  <h3 className="text-lg font-semibold text-zinc-400 mb-4">{group}</h3>
                  <div className="flex flex-wrap gap-3">
                    {groupedTags[group].sort((a, b) => b.count - a.count).map(tag => (
                      <button
                        key={tag.name}
                        onClick={() => handleTagClick(tag.name)}
                        className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 text-zinc-700 dark:text-zinc-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                      >
                        <span className="text-sm font-medium">{tag.name}</span>
                        <span className="text-xs text-zinc-400">{tag.count}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
