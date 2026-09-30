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
    <html lang="en" className="dark h-full">
      <body className="h-full bg-slate-950 text-slate-100 font-sans antialiased overflow-x-hidden selection:bg-emerald-500/20 selection:text-emerald-300">
        {children}
      </body>
    </html>
  );
}
