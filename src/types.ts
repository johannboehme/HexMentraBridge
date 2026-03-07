import type { WebSocket } from 'ws';
import type { DisplayManager } from './display';

export type SessionHandle = {
  display: DisplayManager;
  toggleMic: () => void;
  getMicState: () => boolean;
  toggleCopilot: () => boolean;
  getCopilotState: () => boolean;
  getDebugStatus: () => {
    lastTranscriptAt: number | null;
    lastTranscriptText: string;
    copilotBufferSize: number;
    copilotPipelineSize: number;
    copilotInflight: boolean;
    copilotFilteredCount: number;
    copilotPassedCount: number;
    listening: boolean;
    copilot: boolean;
  };
};

export interface AppClientState {
  ws: WebSocket;
  copilotMode: boolean;
  copilotBuffer: string[];
  copilotDebounceTimer: ReturnType<typeof setTimeout> | null;
  copilotInflight: boolean;
  copilotPipelineSize: number;
  copilotFilteredCount: number;
  copilotPassedCount: number;
  copilotContextWindow: string[];
  lastTranscriptAt: number | null;
  lastTranscriptText: string;
  manualMode: boolean;
  manualBuffer: string[];
}
