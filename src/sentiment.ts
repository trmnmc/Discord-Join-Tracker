/**
 * Local, heuristic sentiment + theme analysis. No external services.
 * Uses the `sentiment` npm package for per-message scoring and adds simple
 * keyword-based theme detection tailored to community-server concerns.
 */
import Sentiment from "sentiment";

const analyzer = new Sentiment();

export type SentimentLabel = "positive" | "neutral" | "negative";

export interface ScoredMessage {
  score: number; // raw sentiment comparative-ish score
  label: SentimentLabel;
}

/** Score a single piece of text. Empty text is treated as neutral 0. */
export function scoreText(text: string | null | undefined): ScoredMessage {
  if (!text || text.trim() === "") return { score: 0, label: "neutral" };
  const result = analyzer.analyze(text);
  // `comparative` normalizes by token count; good for short chat messages.
  const score = result.comparative;
  return { score, label: labelForScore(score) };
}

export function labelForScore(score: number): SentimentLabel {
  if (score > 0.2) return "positive";
  if (score < -0.2) return "negative";
  return "neutral";
}

export interface SentimentSummary {
  averageScore: number;
  label: SentimentLabel;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  total: number;
  topNegativeTerms: string[];
}

/**
 * Aggregate sentiment over many already-scored messages. We also extract the
 * most frequent terms appearing in negative messages as candidate "pain"
 * themes (simple keyword extraction, stopwords removed).
 */
export function summarizeSentiment(
  messages: { content: string | null; sentiment_score: number | null }[],
): SentimentSummary {
  let positive = 0;
  let neutral = 0;
  let negative = 0;
  let sum = 0;
  let counted = 0;
  const negativeTermFreq = new Map<string, number>();

  for (const m of messages) {
    if (m.sentiment_score === null) continue;
    counted += 1;
    sum += m.sentiment_score;
    const label = labelForScore(m.sentiment_score);
    if (label === "positive") positive += 1;
    else if (label === "negative") {
      negative += 1;
      for (const term of extractKeywords(m.content)) {
        negativeTermFreq.set(term, (negativeTermFreq.get(term) ?? 0) + 1);
      }
    } else neutral += 1;
  }

  const averageScore = counted > 0 ? sum / counted : 0;
  const topNegativeTerms = [...negativeTermFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([term]) => term);

  return {
    averageScore,
    label: labelForScore(averageScore),
    positiveCount: positive,
    neutralCount: neutral,
    negativeCount: negative,
    total: counted,
    topNegativeTerms,
  };
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "this", "that", "these", "those",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "our", "their", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "for", "with", "at", "by", "from", "up", "out", "so",
  "do", "does", "did", "have", "has", "had", "can", "could", "should", "would",
  "will", "just", "not", "no", "yes", "get", "got", "im", "dont", "cant", "really",
  "very", "too", "all", "any", "some", "more", "much", "here", "there", "what",
  "when", "where", "why", "how", "who", "about", "like", "than", "as", "into",
]);

/** Lowercase word tokens, stripped of mentions/urls/emojis, stopwords removed. */
export function extractKeywords(text: string | null | undefined): string[] {
  if (!text) return [];
  const cleaned = text
    .toLowerCase()
    .replace(/<@!?\d+>/g, " ") // user mentions
    .replace(/<@&\d+>/g, " ") // role mentions
    .replace(/<#\d+>/g, " ") // channel mentions
    .replace(/<a?:\w+:\d+>/g, " ") // custom emojis
    .replace(/https?:\/\/\S+/g, " ") // urls
    .replace(/[^a-z0-9\s]/g, " ");
  return cleaned
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// ---- Server-specific theme detection ----

export type ThemeKey =
  | "onboarding"
  | "rules_moderation"
  | "events_activity"
  | "channels_navigation"
  | "bugs_support"
  | "pricing_billing"
  | "spam_safety"
  | "roles_permissions";

interface ThemeDef {
  key: ThemeKey;
  label: string;
  keywords: string[];
}

const THEME_DEFS: ThemeDef[] = [
  {
    key: "onboarding",
    label: "Onboarding / getting started",
    keywords: ["onboard", "onboarding", "getting started", "get started", "start", "begin",
      "newbie", "new here", "newcomer", "how do i", "where do i", "guide", "tutorial", "help"],
  },
  {
    key: "rules_moderation",
    label: "Rules / moderation",
    keywords: ["rule", "rules", "moderation", "moderator", "mod", "ban", "banned", "kick",
      "muted", "mute", "warning", "warn", "report", "abuse", "unfair"],
  },
  {
    key: "events_activity",
    label: "Events / activity",
    keywords: ["event", "events", "activity", "active", "dead", "quiet", "boring", "nothing",
      "happening", "schedule", "meetup", "game night", "stream"],
  },
  {
    key: "channels_navigation",
    label: "Channels / navigation",
    keywords: ["channel", "channels", "where is", "cant find", "find the", "navigate",
      "navigation", "confusing", "confused", "lost", "which channel"],
  },
  {
    key: "bugs_support",
    label: "Bugs / support",
    keywords: ["bug", "bugs", "broken", "error", "crash", "crashing", "issue", "problem",
      "not working", "doesnt work", "support", "fix", "glitch", "fail", "failed"],
  },
  {
    key: "pricing_billing",
    label: "Pricing / billing",
    keywords: ["price", "pricing", "cost", "billing", "invoice", "payment", "pay", "subscription",
      "subscribe", "refund", "charged", "expensive", "premium", "paywall"],
  },
  {
    key: "spam_safety",
    label: "Spam / safety",
    keywords: ["spam", "spammer", "scam", "scammer", "phishing", "bot raid", "raid", "nsfw",
      "harass", "harassment", "creepy", "unsafe", "dm me", "dms"],
  },
  {
    key: "roles_permissions",
    label: "Roles / permissions",
    keywords: ["role", "roles", "permission", "permissions", "access", "cant access", "locked",
      "verify", "verification", "color role", "self role", "reaction role"],
  },
];

export interface ThemeHit {
  key: ThemeKey;
  label: string;
  count: number;
}

/**
 * Count how many messages match each theme by keyword presence. A message can
 * contribute to multiple themes. Returns themes sorted by frequency (desc).
 */
export function detectThemes(texts: (string | null)[]): ThemeHit[] {
  const counts = new Map<ThemeKey, number>();
  for (const def of THEME_DEFS) counts.set(def.key, 0);

  for (const raw of texts) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    for (const def of THEME_DEFS) {
      if (def.keywords.some((kw) => lower.includes(kw))) {
        counts.set(def.key, (counts.get(def.key) ?? 0) + 1);
      }
    }
  }

  return THEME_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    count: counts.get(def.key) ?? 0,
  }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count);
}

/**
 * Deterministic improvement suggestions derived from detected themes and the
 * number of repeated questions. Thresholds are intentionally simple.
 */
export function suggestImprovements(themes: ThemeHit[], repeatedQuestionCount: number): string[] {
  const byKey = new Map<ThemeKey, number>(themes.map((t) => [t.key, t.count]));
  const suggestions: string[] = [];
  const has = (k: ThemeKey, min = 1) => (byKey.get(k) ?? 0) >= min;

  if (has("onboarding") || repeatedQuestionCount >= 3) {
    suggestions.push(
      "Add a pinned getting-started guide and an FAQ — onboarding/help questions are recurring.",
    );
  }
  if (has("channels_navigation")) {
    suggestions.push(
      "Add channel descriptions and a clearly marked #start-here channel — members seem unsure where to go.",
    );
  }
  if (has("rules_moderation")) {
    suggestions.push(
      "Publish clearer rules and a documented moderation/escalation path to address moderation concerns.",
    );
  }
  if (has("bugs_support")) {
    suggestions.push(
      "Create a dedicated support-triage channel or ticket flow for bug/support requests.",
    );
  }
  if (has("events_activity")) {
    suggestions.push(
      "Schedule recurring events and use announcements to drive activity — members mention quiet/low activity.",
    );
  }
  if (has("spam_safety")) {
    suggestions.push(
      "Tune AutoMod and post clear report instructions — spam/safety issues were raised.",
    );
  }
  if (has("roles_permissions")) {
    suggestions.push(
      "Review self-assignable roles and access/verification flow — members report permission confusion.",
    );
  }
  if (has("pricing_billing")) {
    suggestions.push(
      "Clarify pricing/billing in a pinned FAQ and provide a billing-support contact.",
    );
  }

  if (suggestions.length === 0) {
    suggestions.push(
      "No strong negative themes detected — keep current onboarding and moderation practices.",
    );
  }
  return suggestions;
}
