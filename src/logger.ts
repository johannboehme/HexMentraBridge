import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

export const TRANSCRIPTS_DIR = join(import.meta.dir, '..', 'transcripts');
mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

export function logTranscript(mode: 'normal' | 'copilot', text: string, filterResult?: 'RELEVANT' | 'SKIP' | 'ERROR' | 'BYPASS') {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19);
  const filePath = join(TRANSCRIPTS_DIR, `${dateStr}.md`);

  let line = `[${timeStr}] (${mode})`;
  if (filterResult) line += ` [${filterResult}]`;
  line += ` ${text}\n`;

  try { appendFileSync(filePath, line); } catch (e: any) {
    console.error(`[Transcript] Write error: ${e.message}`);
  }
}
