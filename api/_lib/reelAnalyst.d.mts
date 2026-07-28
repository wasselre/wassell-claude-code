/**
 * Types for reelAnalyst.mjs, which is plain JavaScript.
 *
 * Without this the import resolved to `any`, so every field read off the
 * analysis result — `result.hook_type`, `result.psych_trigger` — was unchecked,
 * and a rename inside the .mjs would have been invisible to the endpoint that
 * writes those values onto the record.
 *
 * The shape mirrors the `patch` built in api/analyze-reel.ts.
 */
export declare const REEL_ANALYST_MODEL: string;
export declare const REEL_ANALYST_FALLBACK_MODEL: string;
export declare const MIN_TRANSCRIPT_CHARS: number;

export declare const HOOK_TYPES: string[];
export declare const ANGLES: string[];
export declare const PSYCH_TRIGGERS: string[];
export declare const TONES: string[];

export interface ReelAnalysis {
  clean_content: string;
  hook: string | null;
  hook_type: string | null;
  angle: string | null;
  psych_trigger: string | null;
  structure: string | null;
  tone: string | null;
  cta: string | null;
  cta_type: string | null;
  analysis_notes: string | null;
}

/** Throws when the key is missing or the transcript is shorter than
 *  MIN_TRANSCRIPT_CHARS — the endpoint maps both to a 502/400. */
export declare function cleanAndAnalyzeReel(
  apiKey: string,
  rawTranscript: string,
): Promise<ReelAnalysis>;
