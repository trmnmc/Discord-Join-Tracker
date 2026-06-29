/**
 * Question detection, normalization, and grouping. Identifies messages that
 * look like questions, normalizes them, then clusters near-duplicates by token
 * Jaccard similarity to surface the most frequently asked questions.
 */

const QUESTION_LEAD_WORDS = [
  "who", "what", "when", "where", "why", "how",
  "can", "could", "should", "is", "are", "do", "does",
];

/** Does this raw message look like a question? */
export function isQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "") return false;
  if (trimmed.includes("?")) return true;
  const firstWord = trimmed.split(/\s+/)[0]?.replace(/[^a-z]/g, "");
  return QUESTION_LEAD_WORDS.includes(firstWord);
}

/** Normalize a question for comparison/display. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/<@!?\d+>/g, " ") // user mentions
    .replace(/<@&\d+>/g, " ") // role mentions
    .replace(/<#\d+>/g, " ") // channel mentions
    .replace(/<a?:\w+:\d+>/g, " ") // custom emojis
    .replace(/https?:\/\/\S+/g, " ") // urls
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?!.,\s]+$/g, ""); // strip trailing punctuation/space
}

function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(/\s+/).filter((t) => t.length > 0));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface QuestionCluster {
  example: string; // representative original text
  count: number;
}

const SIMILARITY_THRESHOLD = 0.6;

/**
 * Group similar questions and return the top N by frequency. Each input is the
 * original message text; we normalize internally and cluster by token overlap.
 */
export function topQuestions(rawQuestions: string[], topN = 5): QuestionCluster[] {
  interface Cluster {
    tokens: Set<string>;
    example: string;
    count: number;
  }
  const clusters: Cluster[] = [];

  for (const raw of rawQuestions) {
    const normalized = normalizeQuestion(raw);
    if (normalized === "") continue;
    const tokens = tokenSet(normalized);

    let best: Cluster | null = null;
    let bestSim = 0;
    for (const cluster of clusters) {
      const sim = jaccard(tokens, cluster.tokens);
      if (sim > bestSim) {
        bestSim = sim;
        best = cluster;
      }
    }

    if (best && bestSim >= SIMILARITY_THRESHOLD) {
      best.count += 1;
      // Prefer the shorter, cleaner example as representative.
      if (raw.trim().length < best.example.length) best.example = raw.trim();
    } else {
      clusters.push({ tokens, example: raw.trim(), count: 1 });
    }
  }

  return clusters
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
    .map((c) => ({ example: c.example, count: c.count }));
}
