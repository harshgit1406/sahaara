import { useState, useEffect, useRef } from "react";

export type EyeState =
  | "open"
  | "quarter_closed"
  | "half_closed"
  | "closed"
  | "looking_right"
  | "looking_up";

// Blink sequence: open → quarter → half → closed → half → quarter → open
const BLINK_SEQUENCE: EyeState[] = [
  "quarter_closed",
  "half_closed",
  "closed",
  "half_closed",
  "quarter_closed",
  "open",
];
const BLINK_FRAME_MS = 60; // each blink frame duration
const GLANCE_MIN_HOLD_MS = 2000;
const GLANCE_MAX_HOLD_MS = 3000;

export function useBlink(isThinking: boolean, isSpeaking: boolean) {
  const [eyeState, setEyeState] = useState<EyeState>("open");
  const actionInProgressRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingLookRef = useRef<EyeState>("looking_right");

  // Thinking mode should look right/up. Speaking mode stays blink-only.
  useEffect(() => {
    if (isThinking) {
      actionInProgressRef.current = false;
      const next: EyeState = Math.random() < 0.5 ? "looking_right" : "looking_up";
      thinkingLookRef.current = next;
      setEyeState(next);
    } else if (isSpeaking) {
      actionInProgressRef.current = false;
      setEyeState("open");
    } else if (!actionInProgressRef.current) {
      setEyeState("open");
    }
  }, [isThinking, isSpeaking]);

  useEffect(() => {
    const playBlink = async () => {
      actionInProgressRef.current = true;
      for (const frame of BLINK_SEQUENCE) {
        setEyeState(frame);
        await new Promise((r) => setTimeout(r, BLINK_FRAME_MS));
      }
      actionInProgressRef.current = false;
    };

    const playGlance = async () => {
      actionInProgressRef.current = true;
      const target: EyeState = Math.random() < 0.5 ? "looking_right" : "looking_up";
      setEyeState(target);

      // Keep glance visible long enough to read clearly.
      const holdMs = GLANCE_MIN_HOLD_MS + Math.random() * (GLANCE_MAX_HOLD_MS - GLANCE_MIN_HOLD_MS);
      await new Promise((r) => setTimeout(r, holdMs));
      setEyeState("open");
      actionInProgressRef.current = false;
    };

    const scheduleIdleEyeAction = () => {
      // Thinking holds directional looks; speaking is blink-only; idle mixes both.
      const delay = isThinking
        ? GLANCE_MIN_HOLD_MS + Math.random() * (GLANCE_MAX_HOLD_MS - GLANCE_MIN_HOLD_MS)
        : isSpeaking
          ? 1800 + Math.random() * 1800
        : 2200 + Math.random() * 3200;
      timerRef.current = setTimeout(async () => {
        if (isThinking) {
          const next: EyeState = Math.random() < 0.5 ? "looking_right" : "looking_up";
          thinkingLookRef.current = next;
          setEyeState(next);
          scheduleIdleEyeAction();
          return;
        }

        if (actionInProgressRef.current) {
          scheduleIdleEyeAction();
          return;
        }

        // Mix glances only when idle; speaking remains blink-only.
        const shouldGlance = !isThinking && !isSpeaking && Math.random() < 0.38;
        if (shouldGlance) {
          await playGlance();
        } else {
          await playBlink();
        }

        scheduleIdleEyeAction();
      }, delay);
    };

    scheduleIdleEyeAction();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isThinking, isSpeaking]);

  return eyeState;
}
