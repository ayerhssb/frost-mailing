"use client";

import { useState } from "react";
import {
  Sparkles,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SpamAnalysisResult } from "@/types";
import { cn } from "@/lib/utils";

interface SpamAnalyzerProps {
  subject: string;
  body: string;
}

function ScoreGauge({ score }: { score: number }) {
  const isLow = score < 35;
  const isMid = score >= 35 && score < 65;
  const isHigh = score >= 65;

  const color = isLow
    ? "from-emerald-500 to-emerald-400"
    : isMid
    ? "from-amber-500 to-amber-400"
    : "from-red-500 to-red-400";

  const trackColor = isLow
    ? "bg-emerald-500/20"
    : isMid
    ? "bg-amber-500/20"
    : "bg-red-500/20";

  const textColor = isLow
    ? "text-emerald-400"
    : isMid
    ? "text-amber-400"
    : "text-red-400";

  const label = isLow ? "Low Risk" : isMid ? "Moderate Risk" : "High Risk";

  const Icon = isLow ? ShieldCheck : isMid ? ShieldAlert : ShieldX;

  return (
    <div className="flex items-center gap-4">
      {/* Circular score */}
      <div className="relative w-20 h-20 shrink-0">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
          {/* Track */}
          <circle
            cx="18" cy="18" r="15.9"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="text-white/10"
          />
          {/* Progress */}
          <circle
            cx="18" cy="18" r="15.9"
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${score} ${100 - score}`}
            strokeDashoffset="0"
            className={cn(
              "transition-all duration-700",
              isLow ? "stroke-emerald-400" : isMid ? "stroke-amber-400" : "stroke-red-400"
            )}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={cn("text-xl font-bold leading-none", textColor)}>{score}</span>
          <span className="text-[9px] text-slate-500 mt-0.5">/ 100</span>
        </div>
      </div>

      {/* Label and bar */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <Icon size={16} className={textColor} />
          <span className={cn("text-sm font-semibold", textColor)}>{label}</span>
        </div>
        {/* Progress bar */}
        <div className={cn("h-2 rounded-full overflow-hidden", trackColor)}>
          <div
            className={cn("h-full rounded-full bg-gradient-to-r transition-all duration-700", color)}
            style={{ width: `${score}%` }}
          />
        </div>
        <p className="text-xs text-slate-500 mt-1.5">
          {isLow
            ? "Great! Your email looks clean and professional."
            : isMid
            ? "Some improvements could boost deliverability."
            : "High chance of landing in the spam folder."}
        </p>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available */
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md bg-white/5 hover:bg-white/10 text-slate-400 hover:text-slate-200 transition-colors border border-white/10"
    >
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function SpamAnalyzer({ subject, body }: SpamAnalyzerProps) {
  const [result, setResult] = useState<SpamAnalysisResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const analyze = async () => {
    if (!subject && !body) {
      setError("Please fill in a subject or body before analyzing.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/templates/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "Analysis failed.");
      }

      setResult(data as SpamAnalysisResult);
      setIsOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm overflow-hidden">
      {/* Header / Trigger */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={() => result && setIsOpen((o) => !o)}
      >
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-violet-500/20 flex items-center justify-center">
            <Sparkles size={14} className="text-violet-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-200">AI Copy Analyzer</p>
            <p className="text-xs text-slate-500">
              {result
                ? `Last score: ${result.spamScore}/100 · ${result.flaggedPhrases.length} issue(s) found`
                : "Check your email for spam triggers before sending"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              analyze();
            }}
            isLoading={isLoading}
            className="gap-2 text-xs px-3 py-1.5 h-auto bg-violet-600 hover:bg-violet-500 shadow-lg shadow-violet-500/20"
          >
            {!isLoading && <Sparkles size={13} />}
            {isLoading ? "Analyzing..." : result ? "Re-analyze" : "Analyze Copy"}
          </Button>

          {result && (
            <button
              type="button"
              className="text-slate-500 hover:text-slate-300 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                setIsOpen((o) => !o);
              }}
            >
              {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          )}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="px-4 pb-3">
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </p>
        </div>
      )}

      {/* Loading skeleton */}
      {isLoading && (
        <div className="px-4 pb-4 flex flex-col gap-3">
          <div className="flex items-center gap-3 animate-pulse">
            <div className="w-20 h-20 rounded-full bg-white/5 shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-white/5 rounded w-1/3" />
              <div className="h-2 bg-white/5 rounded w-full" />
              <div className="h-2 bg-white/5 rounded w-4/5" />
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 size={12} className="animate-spin" />
            Gemini is analyzing your email copy...
          </div>
        </div>
      )}

      {/* Result panel */}
      {result && isOpen && !isLoading && (
        <div className="border-t border-white/5 px-4 pt-4 pb-5 space-y-5">

          {/* Score Gauge */}
          <ScoreGauge score={result.spamScore} />

          {/* Flagged Phrases */}
          {result.flaggedPhrases.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Flagged Phrases ({result.flaggedPhrases.length})
              </p>
              <div className="flex flex-wrap gap-2">
                {result.flaggedPhrases.map((phrase, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                    {phrase}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Suggestion */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              AI Suggestion
            </p>
            <div className="p-3 rounded-lg bg-violet-500/10 border border-violet-500/20 text-sm text-slate-300 leading-relaxed">
              {result.suggestion}
            </div>
          </div>

          {/* Revised Subject */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Suggested Subject Line
            </p>
            <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <p className="flex-1 text-sm text-emerald-300 font-medium">
                {result.revisedSubject}
              </p>
              <CopyButton text={result.revisedSubject} />
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
