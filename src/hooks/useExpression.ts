import { useState, useCallback } from "react";

export type Expression = "neutral" | "happy" | "concerned" | "thinking";

// Call setExpression() based on LLM response intent
// You detect intent from the AI reply text before playing TTS

const CONCERN_PATTERNS =
  /heartbeat|heart rate|bp|urgent|emergency|theek nahi|problem|dikkat|alert/i;
const HAPPY_PATTERNS =
  /shukriya|bahut accha|bilkul|zaroor|ho gaya|placed|booked|confirmed|haha|achha/i;

export function useExpression() {
  const [expression, setExpression] = useState<Expression>("neutral");

  // Auto-detect expression from AI reply text
  const detectExpression = useCallback((text: string): Expression => {
    if (CONCERN_PATTERNS.test(text)) return "concerned";
    if (HAPPY_PATTERNS.test(text)) return "happy";
    return "neutral";
  }, []);

  const applyFromText = useCallback(
    (text: string) => {
      setExpression(detectExpression(text));
      // Reset to neutral after 4 seconds
      setTimeout(() => setExpression("neutral"), 4000);
    },
    [detectExpression]
  );

  return { expression, setExpression, applyFromText };
}
