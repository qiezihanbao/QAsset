import { useEffect, useMemo, useState } from "react"

export type ThemeMode = "system" | "light" | "dark"
type Theme = "light" | "dark"

const THEME_MODE_STORAGE_KEY = "theme_mode"

const resolveTheme = (mode: ThemeMode): Theme => {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  }
  return mode
}

const applyThemeClass = (theme: Theme) => {
  document.documentElement.classList.remove("light", "dark")
  document.documentElement.classList.add(theme)
}

const readStoredThemeMode = (): ThemeMode => {
  const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY)
  if (saved === "light" || saved === "dark" || saved === "system") {
    return saved
  }
  return "system"
}

export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readStoredThemeMode)

  const theme = useMemo(() => resolveTheme(themeMode), [themeMode])

  useEffect(() => {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode)
    applyThemeClass(resolveTheme(themeMode))

    if (themeMode !== "system") return

    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => applyThemeClass(resolveTheme("system"))

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange)
      return () => media.removeEventListener("change", onChange)
    }

    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [themeMode])

  return {
    theme,
    themeMode,
    setThemeMode,
    isDark: theme === "dark",
  }
}
