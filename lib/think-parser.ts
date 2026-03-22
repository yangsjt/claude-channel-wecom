/**
 * Parse <think>...</think> tags from LLM output.
 *
 * Handles thinking tags in streamed LLM output:
 * - Normalize tag variants to <think></think>
 * - Split visible/thinking text for analysis
 * - Ignore tags inside code blocks
 *
 * Ported from openclaw-plugin-wecom/think-parser.js.
 */

const QUICK_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought)\b/i;
const THINK_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought)\b[^<>]*>/gi;

/**
 * Find code regions (``` blocks and `inline`) to avoid processing think tags
 * that appear inside code.
 */
function findCodeRegions(text: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];

  // Fenced code blocks
  const blockRe = /```[\s\S]*?```/g;
  for (const m of text.matchAll(blockRe)) {
    regions.push([m.index!, m.index! + m[0].length]);
  }

  // Inline code
  const inlineRe = /`[^`\n]+`/g;
  for (const m of text.matchAll(inlineRe)) {
    if (!isInsideRegion(m.index!, regions)) {
      regions.push([m.index!, m.index! + m[0].length]);
    }
  }

  return regions;
}

function isInsideRegion(pos: number, regions: Array<[number, number]>): boolean {
  for (const [start, end] of regions) {
    if (pos >= start && pos < end) return true;
  }
  return false;
}

/**
 * Normalize think tag variants to canonical <think></think> form.
 */
export function normalizeThinkingTags(text: string): string {
  if (!text) return "";
  if (!QUICK_TAG_RE.test(text)) return String(text);

  const source = String(text);
  const codeRegions = findCodeRegions(source);
  const normalized: string[] = [];
  let lastIndex = 0;

  THINK_TAG_RE.lastIndex = 0;
  for (const match of source.matchAll(THINK_TAG_RE)) {
    const idx = match.index!;
    if (isInsideRegion(idx, codeRegions)) continue;

    normalized.push(source.slice(lastIndex, idx));
    normalized.push(match[1] === "/" ? "</think>" : "<think>");
    lastIndex = idx + match[0].length;
  }

  normalized.push(source.slice(lastIndex));
  return normalized.join("");
}

/**
 * Parse thinking content from text that may contain <think>...</think> tags.
 */
export function parseThinkingContent(text: string): {
  visibleContent: string;
  thinkingContent: string;
  isThinking: boolean;
} {
  if (!text) {
    return { visibleContent: "", thinkingContent: "", isThinking: false };
  }

  const source = String(text);

  if (!QUICK_TAG_RE.test(source)) {
    return { visibleContent: source, thinkingContent: "", isThinking: false };
  }

  const codeRegions = findCodeRegions(source);
  const visibleParts: string[] = [];
  const thinkingParts: string[] = [];
  let lastIndex = 0;
  let inThinking = false;

  THINK_TAG_RE.lastIndex = 0;
  for (const match of source.matchAll(THINK_TAG_RE)) {
    const idx = match.index!;
    const isClose = match[1] === "/";

    if (isInsideRegion(idx, codeRegions)) continue;

    const segment = source.slice(lastIndex, idx);

    if (!inThinking) {
      if (!isClose) {
        visibleParts.push(segment);
        inThinking = true;
      } else {
        visibleParts.push(segment);
      }
    } else {
      if (isClose) {
        thinkingParts.push(segment);
        inThinking = false;
      }
    }

    lastIndex = idx + match[0].length;
  }

  const remaining = source.slice(lastIndex);
  if (inThinking) {
    thinkingParts.push(remaining);
  } else {
    visibleParts.push(remaining);
  }

  return {
    visibleContent: visibleParts.join("").trim(),
    thinkingContent: thinkingParts.join("\n").trim(),
    isThinking: inThinking,
  };
}
