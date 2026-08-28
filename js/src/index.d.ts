// Type declarations for @fetchitai/engine. Offsets are code points unless a
// result has been passed through toUtf16Offsets().

export const ENGINE_VERSION: string;
export const RULESET_VERSION: string;
export const MIN_CHARS: number;
export const MIN_WORDS: number;

export type Severity = "auto" | "suggest" | "info";
export type OffsetUnit = "codePoint" | "utf16CodeUnit";

export interface Edit {
  id: string;
  ruleId: string;
  category: "invisible" | "space" | "dash";
  severity: "auto";
  start: number;
  end: number;
  original: string;
  replacement: string;
  message: string;
}

export interface Flag {
  id: string;
  ruleId: string;
  category: "ai-wording";
  severity: "suggest";
  start: number;
  end: number;
  text: string;
  replacement: null;
  message: string;
}

export interface AiSignal {
  id: string;
  points: number;
  message: string;
}

export type AiReport =
  | { status: "empty" }
  | { status: "too_short" }
  | { status: "ok"; score: number; level: "low" | "moderate" | "high"; signals: AiSignal[] };

export interface CleanResult {
  engineVersion: string;
  rulesetVersion: string;
  offsetUnit: OffsetUnit;
  input: { length: number };
  cleaned: { text: string; length: number };
  edits: Edit[];
  flags: Flag[];
  aiReport: AiReport;
  summary: { invisible: number; oddSpaces: number; dashes: number; hidden: number; flagged: number };
}

export interface CleanOptions {
  /** Advisory only; the result is identical. Callers apply auto edits
   *  unattended and show suggest flags to a human. */
  mode?: "review" | "auto";
  rules?: {
    /** Rule ids to skip entirely (no transformation, no edit/flag). */
    disable?: string[];
    /** Extra phrases flagged as AI-associated wording. */
    customPhrases?: string[];
  };
}

export function clean(text: string, options?: CleanOptions): CleanResult;
export function applyEdits(text: string, acceptedIds: string[], edits: Edit[]): string;
export function rebuildText(text: string): { text: string; changed: number };
export function removeEmDashes(text: string): { text: string; count: number };
export function findAiSpans(text: string): Array<[number, number]>;
export function analyzeAiSignals(text: string): AiReport;
/** Remap a result's code-point offsets to UTF-16 code units for DOM painting. */
export function toUtf16Offsets(result: CleanResult, inputText: string): CleanResult;
