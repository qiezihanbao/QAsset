import React, { useEffect } from "react"
import { useAssetStore } from "@/store/useAssetStore"
import { useShallow } from "zustand/react/shallow"
import { LeftSidebar } from "./LeftSidebar"
import { WindowTitleBar } from "./WindowTitleBar"
import { isMobile } from "@/lib/utils"

export function MainLayout({ children }: { children: React.ReactNode }) {
  const [
    isLeftSidebarVisible,
    isRightSidebarVisible,
    setLeftSidebarVisible,
    setRightSidebarVisible,
    toggleLeftSidebar,
    toggleRightSidebar,
  ] = useAssetStore(useShallow((s) => ([
    s.isLeftSidebarVisible,
    s.isRightSidebarVisible,
    s.setLeftSidebarVisible,
    s.setRightSidebarVisible,
    s.toggleLeftSidebar,
    s.toggleRightSidebar,
  ])))

  // Only auto-hide sidebars on mobile at initial load
  useEffect(() => {
    if (!isMobile) return

    if (window.innerWidth < 1024) {
      setLeftSidebarVisible(false)
    }
    if (window.innerWidth < 1280) {
      setRightSidebarVisible(false)
    }
  }, [setLeftSidebarVisible, setRightSidebarVisible])

  return (
    <div className="relative flex h-dvh w-full min-w-0 flex-col overflow-hidden bg-white text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
      <button id="global-left-sidebar-btn" className="hidden" onClick={toggleLeftSidebar} />
      <button id="global-right-sidebar-btn" className="hidden" onClick={toggleRightSidebar} />
      <WindowTitleBar />

      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        {/* Mobile overlay - only on mobile platforms */}
        {isMobile && (isLeftSidebarVisible || isRightSidebarVisible) && (
          <button
            aria-label="关闭侧边栏"
            className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px]"
            onClick={() => {
              setLeftSidebarVisible(false)
              setRightSidebarVisible(false)
            }}
          />
        )}

        {isLeftSidebarVisible && <LeftSidebar />}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-zinc-50/50 dark:bg-zinc-900/50">
          {children}
        </main>
      </div>
    </div>
  )
}
