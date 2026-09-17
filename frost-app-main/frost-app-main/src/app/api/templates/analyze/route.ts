import { NextResponse } from "next/server";
import { safeAPI } from "@/lib/api";
import { FrostError } from "@/types";
import { env } from "@/env";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/** Strip HTML tags and collapse whitespace to get plain text */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const SYSTEM_PROMPT = `You are an expert email deliverability analyst specializing in cold outreach.
Your job is to analyze an email's subject line and body, then return a structured JSON response.

Analyze the following:
1. SPAM SCORE: Rate the email from 0 (perfectly clean) to 100 (guaranteed spam folder) based on:
   - Spam trigger words (FREE, GUARANTEED, ACT NOW, CLICK HERE, BUY NOW, LIMITED TIME, etc.)
   - All-caps usage
   - Excessive punctuation (!!!, ???)
   - Over-promotional tone
   - Missing personalization
   - Pushy or salesy language

2. FLAGGED PHRASES: List the exact phrases or words that contributed to the spam score.

3. SUGGESTION: Write 2-3 sentences of actionable advice to improve deliverability and make the email feel more human and professional.

4. REVISED SUBJECT: Rewrite the subject line to be more natural, personalized, and deliverability-friendly. Keep it under 60 characters.

Return ONLY a valid JSON object with this exact structure, no markdown, no extra text:
{
  "spamScore": <number 0-100>,
  "flaggedPhrases": ["phrase1", "phrase2"],
  "suggestion": "<actionable advice>",
  "revisedSubject": "<rewritten subject line>"
}`;

export const POST = safeAPI(async (req: Request) => {
  const body = await req.json();
  const { subject, body: emailBody } = body as { subject: string; body: string };

  if (!subject && !emailBody) {
    throw new FrostError("Subject and body are required", 400);
  }

  const plainBody = stripHtml(emailBody || "");

  const userPrompt = `Subject: ${subject || "(no subject)"}

Body:
${plainBody || "(no body)"}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: `${SYSTEM_PROMPT}\n\n${userPrompt}` }],
        },
      ],
      config: {
        temperature: 0.2,
        maxOutputTokens: 1024,
      },
    });

    const rawText = response.text?.trim() ?? "";

    // Parse and validate the JSON response
    let parsed: {
      spamScore: number;
      flaggedPhrases: string[];
      suggestion: string;
      revisedSubject: string;
    };

    try {
      // Strip potential markdown code fences the model sometimes adds
      const cleaned = rawText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      parsed = JSON.parse(cleaned);
    } catch {
      throw new FrostError("AI returned an unparseable response. Please try again.", 500);
    }

    // Clamp spamScore to [0, 100]
    parsed.spamScore = Math.max(0, Math.min(100, Math.round(parsed.spamScore)));

    return NextResponse.json(parsed);
  } catch (error: unknown) {
    if (error instanceof FrostError) throw error;
    const message = error instanceof Error ? error.message : "Unknown AI error";
    throw new FrostError(`AI analysis failed: ${message}`, 500);
  }
});
