import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#020617",
};

export const metadata: Metadata = {
  title: "local-agentic-sandbox | Air-Gapped Agentic AI Platform",
  description: "Autonomous code generation, execution, and supply-chain verification inside zero-trust container sandboxes with Ollama and MCP.",
  keywords: ["AI Agent", "Sandboxed Execution", "MCP", "Ollama", "Model Context Protocol", "Zero-Trust", "Docker Sandbox"],
  authors: [{ name: "Zack McColgan" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var urlParams = new URLSearchParams(window.location.search);
                  var queryTheme = urlParams.get('theme');
                  var saved = queryTheme || localStorage.getItem('app-theme');
                  if (saved === 'light') {
                    document.documentElement.classList.remove('dark');
                  } else {
                    document.documentElement.classList.add('dark');
                  }
                } catch(e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="h-full bg-white dark:bg-zinc-950 text-slate-900 dark:text-zinc-100 font-sans antialiased overflow-x-hidden selection:bg-emerald-500/20 selection:text-emerald-700 dark:selection:text-emerald-300">
        {children}
      </body>
    </html>
  );
}
