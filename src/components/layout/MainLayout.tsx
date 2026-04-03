import React from "react"
import { LeftSidebar } from "./LeftSidebar"
import { RightSidebar } from "./RightSidebar"

export function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-white dark:bg-zinc-950 text-zinc-950 dark:text-zinc-50">
      <LeftSidebar />
      <main className="flex-1 flex flex-col overflow-hidden bg-zinc-50/50 dark:bg-zinc-900/50">
        {children}
      </main>
      <RightSidebar />
    </div>
  )
}
