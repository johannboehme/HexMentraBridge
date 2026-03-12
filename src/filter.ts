import { FILTER_LLM_URL, FILTER_LLM_API_KEY, FILTER_LLM_MODEL, ASSISTANT_NAME } from './config';

const FILTER_SYSTEM_PROMPT = `You are a relevance filter for an AI assistant named "${ASSISTANT_NAME}" that silently listens to conversations through smart glasses. Decide if the overheard text needs AI attention.

Reply RELEVANT if:
- The assistant is addressed directly by name OR by device/role cues (e.g. "Hey Brille", "Hey Assistant", "Antworten bitte", "Sag mal", "Kannst du...").
- Someone explicitly requests AI help in third person:
  (e.g., "Sowas könnte die AI sagen", "Kann eine AI dazu was sagen?", "Das könnte man mit AI checken", "Frag mal die AI").
- A factual question is asked that can be answered with info, dates, prices, definitions, or forecasts.
  (Example: weather, product facts, timelines, stats.)
- A factual claim is made that might be wrong or worth verifying.
- Numbers, prices, dates, or statistics are mentioned that could be checked.
- A term or concept could use a short definition.
- Someone refers to past conversation ("what did we say about...", "was war nochmal...").

Reply SKIP if:
- Opinions, taste, feelings, or social judgments about people.
  (Example: "Wie findest du den neuen Kollegen?")
- Casual chitchat, greetings, filler words, small talk.
- Garbled, unclear, or fragmentary transcription.
- Single words or meaningless fragments ("Hm", "Na", ".").
- Movie/TV/podcast/game audio in background.
- People addressing each other by name (not the AI).
- Statements that don't benefit from factual context or correction.

Reply ONLY "RELEVANT" or "SKIP".`;

export async function filterWithLLM(text: string): Promise<'RELEVANT' | 'SKIP' | 'ERROR'> {
  if (!FILTER_LLM_URL || !FILTER_LLM_API_KEY) {
    return 'RELEVANT';
  }

  try {
    const res = await fetch(FILTER_LLM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': FILTER_LLM_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: FILTER_LLM_MODEL,
        system: FILTER_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: text },
        ],
        max_tokens: 5,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`[Filter] HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      return 'ERROR';
    }

    const data = await res.json() as any;
    const reply = (data.content?.[0]?.text || '').trim().toUpperCase();

    if (reply.startsWith('RELEVANT')) return 'RELEVANT';
    if (reply.startsWith('SKIP')) return 'SKIP';

    console.warn(`[Filter] Unexpected reply: "${reply}" — defaulting to RELEVANT`);
    return 'RELEVANT';
  } catch (e: any) {
    console.error(`[Filter] Error: ${e.message}`);
    return 'ERROR';
  }
}

export function containsAssistantName(text: string): boolean {
  if (!ASSISTANT_NAME) return false;
  const name = ASSISTANT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[\\s,.!?;:'"()])${name}(?=[\\s,.!?;:'"()!]|$)`, 'i');
  return pattern.test(text);
}
