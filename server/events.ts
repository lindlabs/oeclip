import type { JobState } from "./jobs";
import type { AgentPlan, AgentStep } from "../src/shared/schema";

export type ServerEvent =
  | { type: "hello"; at: string }
  | { type: "job"; job: JobState }
  | { type: "agent-step"; projectId: string; planId: string; step: AgentStep }
  | { type: "agent-plan"; projectId: string; planId: string; status: AgentPlan["status"] }
  | { type: "project"; projectId: string; revision: number }
  | { type: "motion-progress"; projectId: string; step?: string; response?: unknown; active?: boolean }
  | { type: "heartbeat"; at: string };

type Listener = (event: ServerEvent) => void;

class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(projectId: string, listener: Listener): () => void {
    const set = this.listeners.get(projectId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(projectId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(projectId);
    };
  }

  publish(projectId: string, event: ServerEvent): void {
    const set = this.listeners.get(projectId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // un cliente desconectado no debe interrumpir el procesamiento
      }
    }
  }
}

export const eventBus = new EventBus();
