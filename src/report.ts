/**
 * Report builder. Pulls member events + messages from the DB for a window,
 * computes the daily series, sentiment summary, top questions, themes, and
 * deterministic improvement suggestions, and packages everything for the
 * /community-report command (embed + chart + JSON summary for report_runs).
 */
import { AnalyticsDB, MessageRow } from "./db";
import { DailyPoint } from "./chart";
import {
  summarizeSentiment,
  detectThemes,
  suggestImprovements,
  SentimentSummary,
  ThemeHit,
} from "./sentiment";
import { topQuestions, QuestionCluster } from "./questions";

export interface ReportWindow {
  sinceIso: string;
  untilIso: string;
  days: number;
  channelId?: string;
}

export interface DataQuality {
  joinsBackfilled: boolean;
  leavesLiveOnly: boolean;
  messageContentAccessible: boolean;
  messagesAnalyzed: number;
}

export interface ReportData {
  window: ReportWindow;
  daily: DailyPoint[];
  joinCount: number;
  leaveCount: number;
  netGrowth: number;
  sentiment: SentimentSummary;
  questions: QuestionCluster[];
  themes: ThemeHit[];
  suggestions: string[];
  dataQuality: DataQuality;
}

/** Return YYYY-MM-DD (UTC) for an ISO timestamp. */
function utcDateKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Build an inclusive list of UTC day keys between two ISO timestamps. */
function dayRange(sinceIso: string, untilIso: string): string[] {
  const days: string[] = [];
  const start = new Date(utcDateKey(sinceIso) + "T00:00:00.000Z");
  const end = new Date(utcDateKey(untilIso) + "T00:00:00.000Z");
  for (let d = start.getTime(); d <= end.getTime(); d += 86_400_000) {
    days.push(new Date(d).toISOString().slice(0, 10));
  }
  return days;
}

export function buildReportData(
  db: AnalyticsDB,
  guildId: string,
  window: ReportWindow,
): ReportData {
  const { sinceIso, untilIso, channelId } = window;

  const joinEvents = db.getMemberEvents(guildId, sinceIso, untilIso, ["join"]);
  const leaveEvents = db.getMemberEvents(guildId, sinceIso, untilIso, [
    "leave",
    "kick",
    "ban",
    "prune",
  ]);
  const messages: MessageRow[] = db.getMessages(guildId, sinceIso, untilIso, channelId);

  // Daily series.
  const dayKeys = dayRange(sinceIso, untilIso);
  const joinsByDay = new Map<string, number>();
  const leavesByDay = new Map<string, number>();
  for (const k of dayKeys) {
    joinsByDay.set(k, 0);
    leavesByDay.set(k, 0);
  }
  for (const e of joinEvents) {
    const k = utcDateKey(e.occurred_at);
    if (joinsByDay.has(k)) joinsByDay.set(k, (joinsByDay.get(k) ?? 0) + 1);
  }
  for (const e of leaveEvents) {
    const k = utcDateKey(e.occurred_at);
    if (leavesByDay.has(k)) leavesByDay.set(k, (leavesByDay.get(k) ?? 0) + 1);
  }
  const daily: DailyPoint[] = dayKeys.map((date) => ({
    date,
    joins: joinsByDay.get(date) ?? 0,
    leaves: leavesByDay.get(date) ?? 0,
  }));

  const joinCount = joinEvents.length;
  const leaveCount = leaveEvents.length;
  const netGrowth = joinCount - leaveCount;

  // Sentiment + themes + questions (ignore null/empty content).
  const sentiment = summarizeSentiment(messages);
  const contentList = messages.map((m) => m.content);
  const themes = detectThemes(contentList);

  const questionTexts = messages
    .filter((m) => m.has_question === 1 && m.content && m.content.trim() !== "")
    .map((m) => m.content as string);
  const questions = topQuestions(questionTexts, 5);
  const repeatedQuestionCount = questions.filter((q) => q.count >= 2).length;

  const suggestions = suggestImprovements(themes, repeatedQuestionCount);

  const messagesWithContent = messages.filter((m) => m.content && m.content.trim() !== "").length;
  const dataQuality: DataQuality = {
    joinsBackfilled: db.hasBackfilledJoins(guildId),
    leavesLiveOnly: true, // leaves are only ever captured live or via audit log
    messageContentAccessible: messagesWithContent > 0,
    messagesAnalyzed: messages.length,
  };

  return {
    window,
    daily,
    joinCount,
    leaveCount,
    netGrowth,
    sentiment,
    questions,
    themes,
    suggestions,
    dataQuality,
  };
}

/** Compact JSON summary persisted to report_runs. */
export function summaryJson(data: ReportData): string {
  return JSON.stringify({
    days: data.window.days,
    channelId: data.window.channelId ?? null,
    joinCount: data.joinCount,
    leaveCount: data.leaveCount,
    netGrowth: data.netGrowth,
    sentiment: {
      average: Number(data.sentiment.averageScore.toFixed(4)),
      label: data.sentiment.label,
      positive: data.sentiment.positiveCount,
      neutral: data.sentiment.neutralCount,
      negative: data.sentiment.negativeCount,
    },
    topThemes: data.themes.slice(0, 5).map((t) => ({ label: t.label, count: t.count })),
    topQuestions: data.questions.map((q) => ({ example: q.example, count: q.count })),
    suggestions: data.suggestions,
    dataQuality: data.dataQuality,
  });
}
