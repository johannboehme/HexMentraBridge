import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const TIMING_DIR = join(import.meta.dir, '..', 'timing');
mkdirSync(TIMING_DIR, { recursive: true });

let traceCounter = 0;

export interface TimingTrace {
  id: string;
  mode: 'normal' | 'copilot';
  text: string;
  steps: { label: string; ts: number }[];
  filterResult?: string;
}

export function createTrace(mode: 'normal' | 'copilot', text: string): TimingTrace {
  return {
    id: `T${++traceCounter}`,
    mode,
    text: text.substring(0, 80),
    steps: [{ label: 'created', ts: Date.now() }],
  };
}

export function traceStep(trace: TimingTrace, label: string) {
  trace.steps.push({ label, ts: Date.now() });
}

export function traceFinish(trace: TimingTrace) {
  traceStep(trace, 'done');
  const start = trace.steps[0].ts;
  const totalMs = Date.now() - start;

  const parts: string[] = [];
  for (let i = 1; i < trace.steps.length; i++) {
    const delta = trace.steps[i].ts - trace.steps[i - 1].ts;
    parts.push(`${trace.steps[i].label}=${delta}ms`);
  }

  const line = `[${new Date().toISOString().slice(11, 19)}] ${trace.id} ${trace.mode} total=${totalMs}ms | ${parts.join(' | ')}${trace.filterResult ? ` | filter=${trace.filterResult}` : ''} | "${trace.text}"\n`;

  console.log(`[Timing] ${trace.id} ${trace.mode} total=${totalMs}ms — ${parts.join(', ')}`);

  const dateStr = new Date().toISOString().slice(0, 10);
  const filePath = join(TIMING_DIR, `${dateStr}.log`);
  try { appendFileSync(filePath, line); } catch (e: any) {
    console.error(`[Timing] Write error: ${e.message}`);
  }
}
