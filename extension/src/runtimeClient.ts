import {
  AgentRequest,
  AgentResponse,
  Observation,
  PlanStep,
  RuntimeStreamCallbacks
} from "./types";

export class RuntimeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number
  ) {}

  async run(payload: AgentRequest): Promise<AgentResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${normalizeBaseUrl(this.baseUrl)}/v1/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Runtime request failed (${response.status}): ${text || response.statusText}`
        );
      }

      return (await response.json()) as AgentResponse;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Runtime request timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async runStream(
    payload: AgentRequest,
    callbacks: RuntimeStreamCallbacks
  ): Promise<AgentResponse> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const resetTimeout = (): void => {
      if (timer) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    };

    resetTimeout();

    try {
      const response = await fetch(`${normalizeBaseUrl(this.baseUrl)}/v1/agent/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Runtime stream failed (${response.status}): ${text || response.statusText}`
        );
      }

      if (!response.body) {
        throw new Error("Runtime stream did not return a readable body");
      }

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = "";
      let finalResponse: AgentResponse | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        resetTimeout();

        buffer += decoder.decode(value, { stream: true });
        const processed = processSSEBuffer(buffer, callbacks);
        buffer = processed.remaining;
        if (processed.doneResponse) {
          finalResponse = processed.doneResponse;
        }
      }

      if (buffer.trim().length > 0) {
        const processed = processSSEBuffer(buffer + "\n\n", callbacks);
        if (processed.doneResponse) {
          finalResponse = processed.doneResponse;
        }
      }

      if (!finalResponse) {
        throw new Error("Runtime stream ended before sending final response");
      }

      return finalResponse;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Runtime stream timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function processSSEBuffer(
  buffer: string,
  callbacks: RuntimeStreamCallbacks
): { remaining: string; doneResponse?: AgentResponse } {
  let remaining = buffer;
  let doneResponse: AgentResponse | undefined;

  for (;;) {
    const separatorIndex = remaining.indexOf("\n\n");
    if (separatorIndex < 0) {
      break;
    }

    const rawEvent = remaining.slice(0, separatorIndex);
    remaining = remaining.slice(separatorIndex + 2);

    const parsed = parseSSEEvent(rawEvent);
    if (!parsed) {
      continue;
    }

    const { event, payload } = parsed;
    switch (event) {
      case "status": {
        const status = typeof payload?.status === "string" ? payload.status : String(payload ?? "");
        callbacks.onStatus?.(status);
        break;
      }
      case "plan": {
        callbacks.onPlan?.(payload as PlanStep);
        break;
      }
      case "observation": {
        callbacks.onObservation?.(payload as Observation);
        break;
      }
      case "token": {
        const token = typeof payload?.text === "string" ? payload.text : "";
        if (token) {
          callbacks.onToken?.(token);
        }
        break;
      }
      case "done": {
        doneResponse = payload as AgentResponse;
        callbacks.onDone?.(doneResponse);
        break;
      }
      case "error": {
        const message = typeof payload?.message === "string" ? payload.message : "Unknown stream error";
        throw new Error(message);
      }
      default:
        break;
    }
  }

  return { remaining, doneResponse };
}

function parseSSEEvent(rawEvent: string): { event: string; payload: any } | undefined {
  let event = "message";
  const dataLines: string[] = [];

  for (const rawLine of rawEvent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  const rawData = dataLines.join("\n");
  let payload: any = rawData;
  try {
    payload = JSON.parse(rawData);
  } catch {
    payload = rawData;
  }

  return { event, payload };
}

