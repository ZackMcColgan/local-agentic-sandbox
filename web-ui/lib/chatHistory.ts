import { ChatMessage } from "@/components/ChatStream";

export const STORAGE_KEY = "local_agent_chat_history_v1";

/**
 * Generates the clean initial welcome message seed.
 */
export function getInitialWelcomeMessage(modelUsed: string = "gemma4:e4b"): ChatMessage {
  return {
    id: "initial-welcome",
    role: "assistant",
    content: "Welcome! I'm your local AI agent. How can I help you today?",
    modelUsed
  };
}

/**
 * Sanitizes chat messages to ensure no heavy base64 strings or raw data URLs
 * are written to localStorage.
 */
export function sanitizeMessagesForStorage(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => ({
    id: msg.id,
    role: msg.role,
    content: msg.content,
    thought: msg.thought,
    traces: msg.traces,
    attachments: msg.attachments?.map((att) => ({
      name: att.name,
      type: att.type,
      size: att.size,
      // Strip any raw data URL from previewUrl to keep localStorage footprint minimal
      previewUrl: att.previewUrl?.startsWith("data:") ? undefined : att.previewUrl,
      isImage: att.isImage
    })),
    modelUsed: msg.modelUsed,
    durationMs: msg.durationMs
  }));
}

/**
 * Safely loads chat history from localStorage.
 * Validates integrity and falls back gracefully to the welcome message seed
 * on corruption, empty storage, or server-side rendering.
 */
export function loadChatHistory(defaultModel: string = "gemma4:e4b"): ChatMessage[] {
  if (typeof window === "undefined" || !window.localStorage) {
    return [getInitialWelcomeMessage(defaultModel)];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [getInitialWelcomeMessage(defaultModel)];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [getInitialWelcomeMessage(defaultModel)];
    }

    // Validate that items conform to ChatMessage structure
    const valid = parsed.every(
      (m: any) => m && typeof m === "object" && typeof m.id === "string" && typeof m.role === "string"
    );

    if (!valid) {
      return [getInitialWelcomeMessage(defaultModel)];
    }

    return parsed as ChatMessage[];
  } catch (err) {
    console.warn("[ChatHistory] Failed to parse localStorage chat history:", err);
    return [getInitialWelcomeMessage(defaultModel)];
  }
}

/**
 * Serializes and saves chat messages to localStorage.
 */
export function saveChatHistory(messages: ChatMessage[]): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    const sanitized = sanitizeMessagesForStorage(messages);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch (err) {
    console.warn("[ChatHistory] Failed to save chat history to localStorage:", err);
  }
}

/**
 * Clears chat history from localStorage and returns the initial welcome seed.
 */
export function clearChatHistory(defaultModel: string = "gemma4:e4b"): ChatMessage[] {
  const seed = [getInitialWelcomeMessage(defaultModel)];
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
  return seed;
}

/**
 * Container state manager modeling the lifted state in page.tsx for robust testing
 * and headless lifecycle management across tab switches.
 */
export class TabContainerState {
  private activeTab: "chat" | "security";
  private messages: ChatMessage[];
  private defaultModel: string;

  constructor(defaultModel: string = "gemma4:e4b") {
    this.defaultModel = defaultModel;
    this.activeTab = "chat";
    this.messages = loadChatHistory(defaultModel);
  }

  getActiveTab(): "chat" | "security" {
    return this.activeTab;
  }

  switchTab(tab: "chat" | "security"): void {
    this.activeTab = tab;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  setMessages(newMessages: ChatMessage[]): void {
    this.messages = newMessages;
    saveChatHistory(this.messages);
  }

  addMessage(msg: ChatMessage): void {
    this.messages = [...this.messages, msg];
    saveChatHistory(this.messages);
  }

  clear(): void {
    this.messages = clearChatHistory(this.defaultModel);
  }
}
