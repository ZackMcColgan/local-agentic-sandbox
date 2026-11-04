"use client";

import { useState, useEffect, useCallback } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyThemeToDom(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const isDark = resolved === "dark";
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.classList.toggle("light", !isDark);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.colorScheme = resolved;

  if (document.body) {
    document.body.classList.toggle("dark", isDark);
    document.body.classList.toggle("light", !isDark);
    document.body.dataset.theme = resolved;
    document.body.setAttribute("data-theme", resolved);
  }
}

export function useTheme(initialTheme?: Theme) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (initialTheme) return initialTheme;
    if (typeof window === "undefined") return "dark";

    try {
      const urlParams = new URLSearchParams(window.location.search);
      const queryTheme = urlParams.get("theme");
      if (queryTheme === "light" || queryTheme === "dark") return queryTheme;

      const saved = localStorage.getItem("theme") || localStorage.getItem("app-theme") || localStorage.getItem("las_mockup_theme");
      if (saved === "light" || saved === "dark" || saved === "system") return saved as Theme;
    } catch {}

    return "dark";
  });

  const resolvedTheme: ResolvedTheme = theme === "system" ? getSystemTheme() : (theme as ResolvedTheme);

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme);
    const resolved: ResolvedTheme = nextTheme === "system" ? getSystemTheme() : (nextTheme as ResolvedTheme);
    applyThemeToDom(resolved);

    try {
      localStorage.setItem("theme", nextTheme);
      localStorage.setItem("app-theme", nextTheme);
      localStorage.setItem("las_mockup_theme", resolved);
      window.dispatchEvent(new Event("storage"));
    } catch {}
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  useEffect(() => {
    applyThemeToDom(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      applyThemeToDom(getSystemTheme());
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [theme]);

  // Sync across tabs/instances
  useEffect(() => {
    const handleStorage = () => {
      try {
        const saved = localStorage.getItem("theme") || localStorage.getItem("app-theme");
        if (saved && (saved === "light" || saved === "dark" || saved === "system")) {
          setThemeState(saved as Theme);
        }
      } catch {}
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return {
    theme,
    resolvedTheme,
    setTheme,
    toggleTheme,
    isDark: resolvedTheme === "dark"
  };
}
