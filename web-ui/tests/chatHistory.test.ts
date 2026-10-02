import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getInitialWelcomeMessage,
  loadChatHistory,
  saveChatHistory,
  clearChatHistory,
  STORAGE_KEY,
  TabContainerState
} from "../lib/chatHistory";
import { ChatMessage } from "../components/ChatStream";

// Mock localStorage implementation for Node test environment
class MockLocalStorage {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.store[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }
}

describe("Task 1 — Chat History Persistence & Tab Switching Suite", () => {
  let mockStorage: MockLocalStorage;

  beforeEach(() => {
    mockStorage = new MockLocalStorage();
    (globalThis as any).window = {
      localStorage: mockStorage
    };
    (globalThis as any).localStorage = mockStorage;
  });

  it("provides valid initial-welcome seed message", () => {
    const welcome = getInitialWelcomeMessage("gemma4:e4b");
    assert.equal(welcome.id, "initial-welcome");
    assert.equal(welcome.role, "assistant");
    assert.ok(welcome.content.includes("Welcome"));
    assert.equal(welcome.modelUsed, "gemma4:e4b");
  });

  it("persists chat history across tab switches without data loss", () => {
    // 1. Initialize TabContainerState (mirrors Home component state management in page.tsx)
    const container = new TabContainerState("gemma4:e4b");
    assert.equal(container.getActiveTab(), "chat");
    assert.equal(container.getMessages().length, 1);
    assert.equal(container.getMessages()[0].id, "initial-welcome");

    // 2. Send >= 2 messages in Chat
    const userMsg1: ChatMessage = {
      id: "user-1",
      role: "user",
      content: "What is the status of the kubernetes cluster?"
    };
    const assistantMsg1: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "All pods are running 1/1 in namespace local-agentic-sandbox."
    };
    const userMsg2: ChatMessage = {
      id: "user-2",
      role: "user",
      content: "Run security verification suite."
    };
    const assistantMsg2: ChatMessage = {
      id: "assistant-2",
      role: "assistant",
      content: "Security posture verified: UID 10001, rootfs read-only."
    };

    container.addMessage(userMsg1);
    container.addMessage(assistantMsg1);
    container.addMessage(userMsg2);
    container.addMessage(assistantMsg2);

    assert.equal(container.getMessages().length, 5); // 1 welcome + 4 messages

    // 3. Switch to 'security' (System) tab — in React this unmounts <ChatStream>
    container.switchTab("security");
    assert.equal(container.getActiveTab(), "security");

    // 4. Switch back to 'chat' tab — in React this remounts <ChatStream>
    container.switchTab("chat");
    assert.equal(container.getActiveTab(), "chat");

    // 5. Assert both messages (and full conversation) are still present
    const messagesAfterTabSwitch = container.getMessages();
    assert.equal(messagesAfterTabSwitch.length, 5);
    assert.equal(messagesAfterTabSwitch[1].content, "What is the status of the kubernetes cluster?");
    assert.equal(messagesAfterTabSwitch[3].content, "Run security verification suite.");
  });

  it("persists chat history across full page reload via localStorage", () => {
    // 1. Simulate active session before reload
    const activeMessages: ChatMessage[] = [
      getInitialWelcomeMessage("gemma4:e4b"),
      { id: "msg-1", role: "user", content: "Analyze repository dependencies" },
      { id: "msg-2", role: "assistant", content: "Dependencies analyzed: zero vulnerabilities found." }
    ];

    saveChatHistory(activeMessages);

    // Verify written to versioned storage key
    const rawStored = mockStorage.getItem(STORAGE_KEY);
    assert.ok(rawStored, `Expected localStorage to have key ${STORAGE_KEY}`);

    // 2. Simulate page reload: instantiate fresh tab container from localStorage
    const reloadedHistory = loadChatHistory("gemma4:e4b");
    assert.equal(reloadedHistory.length, 3);
    assert.equal(reloadedHistory[1].content, "Analyze repository dependencies");
    assert.equal(reloadedHistory[2].content, "Dependencies analyzed: zero vulnerabilities found.");
  });

  it("resets history to welcome seed when clearChatHistory is invoked", () => {
    const activeMessages: ChatMessage[] = [
      getInitialWelcomeMessage("gemma4:e4b"),
      { id: "msg-1", role: "user", content: "Delete all files" }
    ];
    saveChatHistory(activeMessages);

    // Call clear
    const resetMessages = clearChatHistory("gemma4:e4b");
    assert.equal(resetMessages.length, 1);
    assert.equal(resetMessages[0].id, "initial-welcome");

    // Verify localStorage reflects reset
    const reloaded = loadChatHistory("gemma4:e4b");
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].id, "initial-welcome");
  });

  it("handles corrupt or old localStorage format safely without breaking the app", () => {
    mockStorage.setItem(STORAGE_KEY, "invalid-json{{[");
    const safeHistory = loadChatHistory("gemma4:e4b");
    assert.equal(safeHistory.length, 1);
    assert.equal(safeHistory[0].id, "initial-welcome");

    mockStorage.setItem(STORAGE_KEY, JSON.stringify({ notAnArray: true }));
    const safeHistory2 = loadChatHistory("gemma4:e4b");
    assert.equal(safeHistory2.length, 1);
    assert.equal(safeHistory2[0].id, "initial-welcome");
  });

  it("sanitizes messages before persisting to ensure raw base64 is never saved", () => {
    const messageWithHeavyAttachment: ChatMessage = {
      id: "msg-att",
      role: "user",
      content: "Here is an image",
      attachments: [
        {
          name: "diagram.png",
          type: "image/png",
          size: 50000,
          previewUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ...",
          isImage: true
        }
      ]
    };

    saveChatHistory([messageWithHeavyAttachment]);
    const stored = JSON.parse(mockStorage.getItem(STORAGE_KEY) || "[]");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, "msg-att");
    // Ensure base64 payload is stripped or previewUrl omitted from persistence to keep localStorage lean
    assert.ok(
      !stored[0].attachments?.[0]?.previewUrl?.startsWith("data:"),
      "Raw data URLs must be stripped before persistence"
    );
  });
});
