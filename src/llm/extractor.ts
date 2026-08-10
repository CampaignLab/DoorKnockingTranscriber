/**
 * Local LLM insight extraction via WebLLM.
 *
 * Takes a REDACTED transcript (PII already stripped by privacy/redact.ts —
 * the model only ever sees redacted text) and returns structured insights as
 * strict JSON. Malformed output is retried once with a corrective prompt.
 */

import type {
  InitProgressReport,
  MLCEngineInterface,
} from '@mlc-ai/web-llm';

// WebLLM is several MB of JS; load it on demand so the app shell stays fast.
type WebLLMModule = typeof import('@mlc-ai/web-llm');
let webllmModulePromise: Promise<WebLLMModule> | null = null;
function loadWebLLM(): Promise<WebLLMModule> {
  if (!webllmModulePromise) {
    webllmModulePromise = import('@mlc-ai/web-llm');
  }
  return webllmModulePromise;
}

export const PARTIES = [
  'labour',
  'conservative',
  'libdem',
  'green',
  'reform',
  'snp',
  'plaid_cymru',
  'other',
  'undecided',
  'not_stated',
] as const;

export const SENTIMENTS = [
  'supportive',
  'leaning',
  'undecided',
  'hostile',
  'not_home',
  'not_stated',
] as const;

export type Party = (typeof PARTIES)[number];
export type Sentiment = (typeof SENTIMENTS)[number];

export interface Insight {
  party_support: Party;
  key_issues: string[];
  sentiment: Sentiment;
  follow_up_requested: boolean;
  notes: string;
}

// Per product decision: always Llama 3.2 3B for extraction quality.
export const DEFAULT_LLM_MODEL = 'Llama-3.2-3B-Instruct-q4f16_1-MLC';

export const AVAILABLE_LLM_MODELS: { id: string; label: string; approxSizeMb: number }[] = [
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 1B — smallest, fastest',
    approxSizeMb: 700,
  },
  {
    id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 3B — better quality, needs ~2 GB',
    approxSizeMb: 1800,
  },
  {
    id: 'Phi-3.5-mini-instruct-q4f16_1-MLC',
    label: 'Phi 3.5 Mini — good quality, needs ~2.2 GB',
    approxSizeMb: 2200,
  },
];

export function hasWebGPU(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'gpu' in (navigator as Navigator & { gpu?: unknown })
  );
}

const SYSTEM_PROMPT = `You are an assistant that analyses transcripts of political doorstep conversations recorded by a canvasser.

The transcript has ALREADY been anonymised: names, addresses, phone numbers and postcodes appear as placeholders like [NAME], [ADDRESS], [POSTCODE], [PHONE], [EMAIL].

Extract structured insights and reply with ONLY a single JSON object, no markdown, no commentary, matching exactly this schema:
{
  "party_support": one of ${JSON.stringify(PARTIES)},
  "key_issues": array of short lowercase snake_case issue tags the voter mentioned caring about (e.g. "nhs", "cost_of_living", "housing", "immigration", "climate", "education", "crime", "tax", "pensions", "transport"), empty array if none,
  "sentiment": one of ${JSON.stringify(SENTIMENTS)},
  "follow_up_requested": true if the voter asked for information, a leaflet, or another visit, otherwise false,
  "notes": one or two sentences summarising the voter's views. NEVER include any names, addresses, or other identifying details, even placeholders.
}

If the transcript is empty, unintelligible, or nobody spoke to the canvasser, use party_support "not_stated", sentiment "not_home" or "not_stated" as appropriate, empty key_issues, and brief notes.`;

const CORRECTION_PROMPT =
  'Your previous reply was not valid JSON matching the schema. Reply with ONLY the corrected JSON object, nothing else.';

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/** Validate + normalise a parsed object into a well-formed Insight, or null. */
export function parseInsight(raw: string): Insight | null {
  const candidate = extractJsonObject(raw);
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;

  const party = PARTIES.includes(obj.party_support as Party)
    ? (obj.party_support as Party)
    : 'not_stated';
  const sentiment = SENTIMENTS.includes(obj.sentiment as Sentiment)
    ? (obj.sentiment as Sentiment)
    : 'not_stated';

  const issues = Array.isArray(obj.key_issues)
    ? obj.key_issues
        .filter((i): i is string => typeof i === 'string')
        .map((i) => i.trim().toLowerCase().replace(/\s+/g, '_'))
        .filter((i) => i.length > 0 && i.length <= 40)
        .slice(0, 10)
    : [];

  const notes =
    typeof obj.notes === 'string'
      ? // Belt-and-braces: strip any placeholder tokens that slipped through.
        obj.notes.replace(/\[(NAME|ADDRESS|POSTCODE|PHONE|EMAIL)\]/g, '[redacted]').slice(0, 500)
      : '';

  return {
    party_support: party,
    key_issues: issues,
    sentiment,
    follow_up_requested: obj.follow_up_requested === true,
    notes,
  };
}

export class InsightExtractor {
  private engine: MLCEngineInterface | null = null;
  private loadPromise: Promise<void> | null = null;

  get isReady(): boolean {
    return this.engine !== null;
  }

  async load(
    model: string = DEFAULT_LLM_MODEL,
    onProgress?: (report: InitProgressReport) => void,
  ): Promise<void> {
    if (this.loadPromise) return this.loadPromise;

    if (!hasWebGPU()) {
      throw new Error(
        'WebGPU is not available in this browser. Insight extraction needs a newer browser; transcription still works.',
      );
    }

    this.loadPromise = (async () => {
      const { CreateMLCEngine } = await loadWebLLM();
      this.engine = await CreateMLCEngine(model, {
        initProgressCallback: (report) => onProgress?.(report),
      });
    })();

    try {
      await this.loadPromise;
    } catch (err) {
      this.loadPromise = null;
      throw err;
    }
  }

  /** Extract structured insights from a REDACTED transcript. */
  async extract(redactedTranscript: string): Promise<Insight> {
    if (!this.engine) throw new Error('LLM not loaded yet');

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      {
        role: 'user' as const,
        content: `Transcript:\n"""\n${redactedTranscript}\n"""`,
      },
    ];

    const options = { temperature: 0.1, max_tokens: 400 };
    const first = await this.engine.chat.completions.create({ messages, ...options });
    const firstText = first.choices[0]?.message?.content ?? '';
    const parsedFirst = parseInsight(firstText);
    if (parsedFirst) return parsedFirst;

    // One corrective retry.
    const retry = await this.engine.chat.completions.create({
      messages: [
        ...messages,
        { role: 'assistant' as const, content: firstText },
        { role: 'user' as const, content: CORRECTION_PROMPT },
      ],
      ...options,
    });
    const retryText = retry.choices[0]?.message?.content ?? '';
    const parsedRetry = parseInsight(retryText);
    if (parsedRetry) return parsedRetry;

    throw new Error('LLM returned malformed JSON twice; giving up.');
  }

  async unload(): Promise<void> {
    if (this.engine) {
      await this.engine.unload();
      this.engine = null;
      this.loadPromise = null;
    }
  }
}
