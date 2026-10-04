import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import crypto from "crypto";

export interface AgentSpan {
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  sessionId: string;
  name: "agent.turn" | "router.triage" | "model.reasoning" | "mcp.tool_call" | "sandbox.bash_exec" | "model.synthesis" | string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: "ok" | "error";
  attributes: Record<string, any>;
}

export interface TraceSession {
  sessionId: string;
  traceId: string;
  rootSpan?: AgentSpan;
  spans: AgentSpan[];
  startTime: number;
  endTime?: number;
  totalDurationMs?: number;
}

// In-memory trace store (retains last 50 trace sessions for instant UI query)
const traceStore: Map<string, TraceSession> = new Map();

function generateHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function formatTraceparent(traceId: string, spanId: string): string {
  const normTrace = traceId.padStart(32, "0").slice(-32);
  const normSpan = spanId.padStart(16, "0").slice(-16);
  return `00-${normTrace}-${normSpan}-01`;
}

export function parseTraceparent(traceparent: string): { traceId: string; spanId: string } | null {
  if (!traceparent) return null;
  const parts = traceparent.trim().split("-");
  if (parts.length >= 4 && parts[0] === "00" && parts[1].length === 32 && parts[2].length === 16) {
    return { traceId: parts[1], spanId: parts[2] };
  }
  return null;
}

export class TelemetryTracer {
  private sessionId: string;
  private traceId: string;
  private rootSpanId: string;

  constructor(sessionId?: string, traceId?: string) {
    this.sessionId = sessionId || `sess_${Date.now()}`;
    this.traceId = traceId || generateHex(16); // 32 hex chars
    this.rootSpanId = generateHex(8); // 16 hex chars

    if (!traceStore.has(this.sessionId)) {
      traceStore.set(this.sessionId, {
        sessionId: this.sessionId,
        traceId: this.traceId,
        spans: [],
        startTime: Date.now()
      });
    }
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getTraceId(): string {
    return this.traceId;
  }

  public getRootSpanId(): string {
    return this.rootSpanId;
  }

  public getTraceparent(spanId?: string): string {
    return formatTraceparent(this.traceId, spanId || this.rootSpanId);
  }

  public getSpanHierarchy(): Array<{ spanId: string; parentSpanId?: string; name: string }> {
    const session = traceStore.get(this.sessionId);
    if (!session) return [];
    return session.spans.map(s => ({
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      name: s.name
    }));
  }

  /**
   * Start a new span in this trace session
   */
  public startSpan(
    name: AgentSpan["name"],
    parentSpanId?: string,
    attributes: Record<string, any> = {}
  ): { spanId: string; end: (status?: "ok" | "error", extraAttrs?: Record<string, any>) => AgentSpan } {
    const spanId = name === "agent.turn" ? this.rootSpanId : generateHex(8);
    const effectiveParent = parentSpanId !== undefined ? parentSpanId : (name === "agent.turn" ? undefined : this.rootSpanId);
    const startTime = Date.now();

    const spanRecord: AgentSpan = {
      spanId,
      parentSpanId: effectiveParent,
      traceId: this.traceId,
      sessionId: this.sessionId,
      name,
      startTime,
      status: "ok",
      attributes: { ...attributes }
    };

    const session = traceStore.get(this.sessionId);
    if (session) {
      session.spans.push(spanRecord);
      if (name === "agent.turn") {
        session.rootSpan = spanRecord;
      }
    }

    return {
      spanId,
      end: (status: "ok" | "error" = "ok", extraAttrs: Record<string, any> = {}) => {
        const endTime = Date.now();
        spanRecord.endTime = endTime;
        spanRecord.durationMs = Math.max(1, endTime - startTime);
        spanRecord.status = status;
        spanRecord.attributes = { ...spanRecord.attributes, ...extraAttrs };

        if (name === "agent.turn" && session) {
          session.endTime = endTime;
          session.totalDurationMs = Math.max(1, endTime - session.startTime);
        }

        // Asynchronously export to OTLP collector if configured
        this.exportSpanToOTLP(spanRecord).catch(() => {});

        return spanRecord;
      }
    };
  }

  /**
   * Asynchronously push span to OpenTelemetry OTLP HTTP collector (e.g. Jaeger :4318/v1/traces)
   */
  private async exportSpanToOTLP(span: AgentSpan): Promise<void> {
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!otlpEndpoint) return;

    try {
      const url = `${otlpEndpoint.replace(/\/$/, "")}/v1/traces`;
      const payload = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: process.env.OTEL_SERVICE_NAME || "enterprise-ai-portal" } },
                { key: "session.id", value: { stringValue: span.sessionId } }
              ]
            },
            scopeSpans: [
              {
                scope: { name: "antigravity-router", version: "2.0.0" },
                spans: [
                  {
                    traceId: span.traceId,
                    spanId: span.spanId,
                    parentSpanId: span.parentSpanId || "",
                    name: span.name,
                    kind: 1, // SPAN_KIND_INTERNAL
                    startTimeUnixNano: `${span.startTime}000000`,
                    endTimeUnixNano: `${span.endTime || Date.now()}000000`,
                    attributes: Object.entries(span.attributes).map(([key, val]) => ({
                      key,
                      value: typeof val === "number" ? { intValue: val } : { stringValue: String(val) }
                    })),
                    status: {
                      code: span.status === "ok" ? 1 : 2
                    }
                  }
                ]
              }
            ]
          }
        ]
      };

      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(1500)
      }).catch(() => {});
    } catch {
      // Non-blocking: Silently handle when local Jaeger is not active
    }
  }
}

/**
 * Global accessor to retrieve traces for UI waterfall
 */
export function getTraceSession(sessionId: string): TraceSession | undefined {
  return traceStore.get(sessionId);
}

export function getAllTraceSessions(): TraceSession[] {
  return Array.from(traceStore.values()).sort((a, b) => b.startTime - a.startTime);
}
