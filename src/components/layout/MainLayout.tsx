import React from "react"
import { useAssetStore } from "@/store/useAssetStore"
import { LeftSidebar } from "./LeftSidebar"

export function MainLayout({ children }: { children: React.ReactNode }) {
  const { isLeftSidebarVisible, toggleLeftSidebar, toggleRightSidebar } = useAssetStore()

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white dark:bg-zinc-950 text-zinc-950 dark:text-zinc-50">
      {/* Hidden buttons for global shortcut handling */}
      <button id="global-left-sidebar-btn" className="hidden" onClick={toggleLeftSidebar} />
      <button id="global-right-sidebar-btn" className="hidden" onClick={toggleRightSidebar} />

      {isLeftSidebarVisible && <LeftSidebar />}
      <main className="flex-1 flex flex-col overflow-hidden bg-zinc-50/50 dark:bg-zinc-900/50">
        {children}
      </main>
    </div>
  )
}
