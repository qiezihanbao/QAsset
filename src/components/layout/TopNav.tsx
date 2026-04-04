import { Search, LayoutGrid, List, LayoutDashboard } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAssetStore } from "@/store/useAssetStore"
import { useShallow } from "zustand/react/shallow"

export function TopNav() {
  const [searchQuery, setSearchQuery] = useAssetStore(useShallow((s) => [s.searchQuery, s.setSearchQuery]))

  return (
    <header className="flex h-14 items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-4 shrink-0">
      <div className="flex items-center gap-4">
        <div className="font-semibold text-lg tracking-tight">QuickAsset</div>
        <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-800" />
        <select className="bg-transparent text-sm font-medium focus:outline-none border-none cursor-pointer">
          <option>默认素材库</option>
          <option>项目 A</option>
        </select>
      </div>

      <div className="flex-1 max-w-xl px-8">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-zinc-500" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索资产（名称）..."
            className="w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 px-8 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-zinc-300 dark:focus:ring-zinc-700"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon">
          <LayoutGrid className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon">
          <LayoutDashboard className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon">
          <List className="h-4 w-4" />
        </Button>
      </div>
    </header>
  )
}
