import { SIMULATION_SCENARIOS } from "./scenarios";
import { SimulationScenario, SimulationScenarioKey, SimulationEvent } from "./types";
import { TaskManifest } from "../subagents/types";

/**
 * Parses user composer text or URL param for a /simulate command.
 * Examples:
 *   /simulate chat-fast
 *   /simulate chat-slow 10
 *   /simulate build-run 5
 */
export function parseSimulateCommand(text: string): {
  isSimulate: boolean;
  scenarioKey: SimulationScenarioKey;
  speed: number;
} | null {
  const trimmed = (text || "").trim();
  if (!trimmed.toLowerCase().startsWith("/simulate")) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const rawKey = (parts[1] || "chat-fast").toLowerCase() as SimulationScenarioKey;
  const scenarioKey: SimulationScenarioKey = SIMULATION_SCENARIOS[rawKey] ? rawKey : "chat-fast";

  const rawSpeed = parts[2] ? parseFloat(parts[2]) : undefined;
  // Default chat-slow to 1x for human eyeballing unless explicitly overridden; others default to 10x
  const defaultSpeed = scenarioKey === "chat-slow" ? 1 : 10;
  const speed = rawSpeed && !isNaN(rawSpeed) && rawSpeed > 0 ? rawSpeed : defaultSpeed;

  return {
    isSimulate: true,
    scenarioKey,
    speed
  };
}

export function getScenario(key: string): SimulationScenario | undefined {
  return SIMULATION_SCENARIOS[key];
}

/**
 * Creates a synthetic SSE Response that feeds the exact ChatStream reader loop
 * without any network or backend engine involvement.
 */
export async function createSimulatedChatResponse(
  scenarioKey: SimulationScenarioKey,
  speed = 1,
  signal?: AbortSignal
): Promise<Response> {
  const scenario = SIMULATION_SCENARIOS[scenarioKey];
  if (!scenario) {
    throw new Error(`Unknown simulation scenario: ${scenarioKey}`);
  }

  // Handle backend down scenario: immediate 503 Service Unavailable HTTP error
  if (scenarioKey === "backend-down") {
    const errorEvent = scenario.events.find((e) => e.type === "error");
    const errorMsg =
      errorEvent && errorEvent.type === "error"
        ? errorEvent.error
        : "Service Unavailable (HTTP 503): Agent engine is stopped.";
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 503,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }

  const encoder = new TextEncoder();
  const safeSpeed = Math.max(0.1, speed);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const timers: NodeJS.Timeout[] = [];
      let isClosed = false;

      const cleanup = () => {
        if (isClosed) return;
        isClosed = true;
        timers.forEach((t) => clearTimeout(t));
      };

      if (signal) {
        signal.addEventListener("abort", () => {
          cleanup();
          try {
            controller.close();
          } catch {}
        });
      }

      const events = [...scenario.events].sort((a, b) => a.timeMs - b.timeMs);

      for (const event of events) {
        const delayMs = Math.round(event.timeMs / safeSpeed);

        const timer = setTimeout(() => {
          if (isClosed || signal?.aborted) return;

          try {
            let ssePayload: any = null;

            if (event.type === "meta") {
              ssePayload = { type: "meta", model: event.model };
            } else if (event.type === "status") {
              ssePayload = { type: "status", status: event.status };
            } else if (event.type === "thought") {
              ssePayload = { type: "thought", thought: event.thought };
            } else if (event.type === "token") {
              ssePayload = { type: "token", content: event.content };
            } else if (event.type === "trace") {
              ssePayload = { type: "trace", trace: event.trace };
            } else if (event.type === "done") {
              ssePayload = {
                type: "done",
                content: event.content,
                thought: event.thought,
                durationMs: Math.round(event.timeMs)
              };
            } else if (event.type === "error") {
              ssePayload = { type: "error", error: event.error };
            }

            if (ssePayload) {
              const chunkStr = `data: ${JSON.stringify(ssePayload)}\n\n`;
              controller.enqueue(encoder.encode(chunkStr));
            }

            // Close stream on done or terminal error
            if (event.type === "done" || event.type === "error") {
              cleanup();
              controller.close();
            }
          } catch (err) {
            cleanup();
            try {
              controller.error(err);
            } catch {}
          }
        }, delayMs);

        timers.push(timer);
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}

/**
 * Runs a simulated engineering builder task over time, updating activeTask and LiveRunBlock.
 */
export function runSimulatedTask(
  scenarioKey: SimulationScenarioKey,
  speed = 1,
  callbacks: {
    onTaskUpdate: (task: TaskManifest) => void;
    onComplete?: (content: string) => void;
    onError?: (err: Error) => void;
  },
  signal?: AbortSignal
): () => void {
  const scenario = SIMULATION_SCENARIOS[scenarioKey];
  if (!scenario || !scenario.initialTask) {
    callbacks.onError?.(new Error(`Scenario ${scenarioKey} does not provide an initial task.`));
    return () => {};
  }

  const safeSpeed = Math.max(0.1, speed);
  const timers: NodeJS.Timeout[] = [];
  let isStopped = false;

  const cleanup = () => {
    isStopped = true;
    timers.forEach((t) => clearTimeout(t));
  };

  if (signal) {
    signal.addEventListener("abort", () => {
      cleanup();
    });
  }

  // Initial task dispatch immediately
  callbacks.onTaskUpdate({ ...scenario.initialTask });

  const events = [...scenario.events].sort((a, b) => a.timeMs - b.timeMs);

  for (const event of events) {
    const delayMs = Math.round(event.timeMs / safeSpeed);

    const timer = setTimeout(() => {
      if (isStopped || signal?.aborted) return;

      if (event.type === "task_update" && event.task) {
        callbacks.onTaskUpdate({ ...event.task });
      } else if (event.type === "done") {
        callbacks.onComplete?.(event.content || "Task completed.");
      } else if (event.type === "error") {
        callbacks.onError?.(new Error(event.error || "Simulation error."));
      }
    }, delayMs);

    timers.push(timer);
  }

  return cleanup;
}
