import { useState, useEffect, useRef } from "react";
import { useBlink } from "../../hooks/useBlink";
import type { EyeState } from "../../hooks/useBlink";
import { useLipSync } from "../../hooks/useLipSync";
import type { LipSyncMetrics } from "../../hooks/useLipSync";
import type { LipSyncTuning } from "../../hooks/useLipSync";
import type { MouthState } from "../../hooks/useLipSync";
import { useExpression } from "../../hooks/useExpression";
import type { Expression } from "../../hooks/useExpression";

import baseImg from "../../assets/avatar/base.png";
import eyeQuarterClosed from "../../assets/avatar/eyes/quarter_closed.png";
import eyeHalfClosed from "../../assets/avatar/eyes/half_closed.png";
import eyeClosed from "../../assets/avatar/eyes/closed.png";
import eyeLookingRight from "../../assets/avatar/eyes/looking_right.png";
import eyeLookingUp from "../../assets/avatar/eyes/looking_up.png";

import mouthNeutral from "../../assets/avatar/mouth/neutral.png";
import mouthAEI from "../../assets/avatar/mouth/a_e_i.png";
import mouthBMP from "../../assets/avatar/mouth/B_M_P.png";
import mouthCDNSTXYZ from "../../assets/avatar/mouth/c_d_n_s_t_x_y_z.png";
import mouthGK from "../../assets/avatar/mouth/g_k.png";
import mouthL from "../../assets/avatar/mouth/L.png";
import mouthO from "../../assets/avatar/mouth/o.png";
import mouthJCHSH from "../../assets/avatar/mouth/j_ch_sh.png";
import mouthU from "../../assets/avatar/mouth/u.png";
import mouthFV from "../../assets/avatar/mouth/F_V.png";
import mouthEE from "../../assets/avatar/mouth/ee.png";
import mouthQW from "../../assets/avatar/mouth/q_w.png";
import mouthTH from "../../assets/avatar/mouth/th.png";
import thinkingCloud from "../../assets/avatar/thinking.png";

const EYE_MAP: Partial<Record<EyeState, string>> = {
  quarter_closed: eyeQuarterClosed,
  half_closed: eyeHalfClosed,
  closed: eyeClosed,
  looking_right: eyeLookingRight,
  looking_up: eyeLookingUp,
};

const MOUTH_MAP: Record<MouthState, string> = {
  neutral: mouthNeutral,
  a_e_i: mouthAEI,
  b_m_p: mouthBMP,
  c_d_n_s_t_x_y_z: mouthCDNSTXYZ,
  g_k: mouthGK,
  l: mouthL,
  o: mouthO,
  j_ch_sh: mouthJCHSH,
  u: mouthU,
  f_v: mouthFV,
  ee: mouthEE,
  q_w: mouthQW,
  th: mouthTH,
};

const EXPRESSION_FILTER: Record<Expression, string> = {
  neutral: "none",
  happy: "brightness(1.05)",
  concerned: "brightness(0.92) saturate(0.85)",
  thinking: "none",
};

const THINKING_CLOUD_ANIM_MS = 220;

export interface AvatarControls {
  playAudio: (data: ArrayBuffer) => Promise<void>;
  stopAudio: () => void;
  applyExpressionFromText: (text: string) => void;
  setMouthOverride: (state: MouthState | null) => void;
  setEyeOverride: (state: EyeState | null) => void;
  setExpressionOverride: (state: Expression | null) => void;
  setLipSyncTuning: (tuning: Partial<LipSyncTuning>) => void;
}

export interface AvatarRenderState {
  eye: EyeState;
  mouth: MouthState;
  expression: Expression;
  speaking: boolean;
  metrics: LipSyncMetrics;
}

interface AvatarProps {
  isThinking?: boolean;
  onReady?: (controls: AvatarControls) => void;
  onStateChange?: (state: AvatarRenderState) => void;
}

const EMPTY_METRICS: LipSyncMetrics = {
  speaking: false,
  openness: 0,
  onsetBoost: 0,
  rms: 0,
  amplitude: 0,
  dominantHz: 0,
  highBandRatio: 0,
  lowBandRatio: 0,
  midBandRatio: 0,
  zcr: 0,
  calibrationProgress: 0,
  calibrated: false,
  mouth: "neutral",
};

export function Avatar({ isThinking = false, onReady, onStateChange }: AvatarProps) {
  const [mouthState, setMouthState] = useState<MouthState>("neutral");
  const [mouthOverride, setMouthOverride] = useState<MouthState | null>(null);
  const [eyeOverride, setEyeOverride] = useState<EyeState | null>(null);
  const [expressionOverride, setExpressionOverride] = useState<Expression | null>(null);
  const [metrics, setMetrics] = useState<LipSyncMetrics>(EMPTY_METRICS);
  const [showThinkingCloud, setShowThinkingCloud] = useState(false);
  const [thinkingCloudActive, setThinkingCloudActive] = useState(false);

  const [renderEye, setRenderEye] = useState<EyeState>("open");
  const [prevEye, setPrevEye] = useState<EyeState | null>(null);
  const [eyeTransitionProgress, setEyeTransitionProgress] = useState(1);

  const [renderMouth, setRenderMouth] = useState<MouthState>("neutral");
  const [prevMouth, setPrevMouth] = useState<MouthState | null>(null);
  const [transitionProgress, setTransitionProgress] = useState(1);

  const eyeTransitionTimerRef = useRef<number | null>(null);
  const eyeTransitionRafRef = useRef<number | null>(null);
  const prevEyeRef = useRef<EyeState>("open");
  const thinkingCloudTimerRef = useRef<number | null>(null);

  const transitionTimerRef = useRef<number | null>(null);
  const transitionRafRef = useRef<number | null>(null);
  const prevMouthRef = useRef<MouthState>("neutral");

  const { expression, applyFromText } = useExpression();
  const eyeState = useBlink(isThinking, metrics.speaking);
  const { playAudio, stop, setTuning } = useLipSync(setMouthState, {
    onMetrics: (next) => setMetrics(next),
  });

  const activeMouth = mouthOverride ?? mouthState;
  const activeEye = eyeOverride ?? eyeState;
  const activeExpression: Expression = isThinking
    ? "thinking"
    : expressionOverride ?? expression;
  const morphAmount = clamp01(
    metrics.openness * 0.68 +
    metrics.amplitude * 2.3 +
    metrics.onsetBoost * 0.24 +
    (metrics.speaking ? 0.08 : 0)
  );
  const activeLayerOpacity = 1;
  const morphScaleY = 1 + morphAmount * 0.016;
  const morphScaleX = 1 - morphAmount * 0.006;
  const morphTranslateY = (1 - morphAmount) * 0.35;

  useEffect(() => {
    onReady?.({
      playAudio,
      stopAudio: stop,
      applyExpressionFromText: applyFromText,
      setMouthOverride,
      setEyeOverride,
      setExpressionOverride,
      setLipSyncTuning: setTuning,
    });
  }, [applyFromText, onReady, playAudio, setTuning, stop]);

  useEffect(() => {
    Object.values(MOUTH_MAP).forEach((src) => {
      const img = new Image();
      img.src = src;
    });

    Object.values(EYE_MAP).forEach((src) => {
      if (!src) return;
      const img = new Image();
      img.src = src;
    });
  }, []);

  useEffect(() => {
    if (activeEye === renderEye) return;

    const duration = getEyeTransitionDuration(prevEyeRef.current, activeEye);

    setPrevEye(renderEye);
    setRenderEye(activeEye);
    prevEyeRef.current = activeEye;
    setEyeTransitionProgress(0);

    if (eyeTransitionRafRef.current !== null) {
      cancelAnimationFrame(eyeTransitionRafRef.current);
    }

    const startedAt = performance.now();
    const step = (now: number) => {
      const t = clamp01((now - startedAt) / Math.max(duration, 1));
      setEyeTransitionProgress(easeInOutCubic(t));
      if (t < 1) {
        eyeTransitionRafRef.current = requestAnimationFrame(step);
      }
    };
    eyeTransitionRafRef.current = requestAnimationFrame(step);

    if (eyeTransitionTimerRef.current !== null) {
      window.clearTimeout(eyeTransitionTimerRef.current);
    }

    eyeTransitionTimerRef.current = window.setTimeout(() => {
      setPrevEye(null);
    }, duration + 8);

    return () => {
      if (eyeTransitionRafRef.current !== null) {
        cancelAnimationFrame(eyeTransitionRafRef.current);
        eyeTransitionRafRef.current = null;
      }
    };
  }, [activeEye, renderEye]);

  useEffect(() => {
    if (activeMouth === renderMouth) return;

    const duration = getTransitionDuration(prevMouthRef.current, activeMouth);

    setPrevMouth(renderMouth);
    setRenderMouth(activeMouth);
    prevMouthRef.current = activeMouth;
    setTransitionProgress(0);

    if (transitionRafRef.current !== null) {
      cancelAnimationFrame(transitionRafRef.current);
    }

    const startedAt = performance.now();
    const step = (now: number) => {
      const t = clamp01((now - startedAt) / Math.max(duration, 1));
      setTransitionProgress(easeInOutCubic(t));
      if (t < 1) {
        transitionRafRef.current = requestAnimationFrame(step);
      }
    };
    transitionRafRef.current = requestAnimationFrame(step);

    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }

    transitionTimerRef.current = window.setTimeout(() => {
      setPrevMouth(null);
    }, duration + 8);

    return () => {
      if (transitionRafRef.current !== null) {
        cancelAnimationFrame(transitionRafRef.current);
        transitionRafRef.current = null;
      }
    };
  }, [activeMouth, renderMouth]);

  useEffect(() => {
    if (thinkingCloudTimerRef.current !== null) {
      window.clearTimeout(thinkingCloudTimerRef.current);
      thinkingCloudTimerRef.current = null;
    }

    if (isThinking) {
      setShowThinkingCloud(true);
      const raf = requestAnimationFrame(() => setThinkingCloudActive(true));
      return () => cancelAnimationFrame(raf);
    }

    setThinkingCloudActive(false);
    thinkingCloudTimerRef.current = window.setTimeout(() => {
      setShowThinkingCloud(false);
      thinkingCloudTimerRef.current = null;
    }, THINKING_CLOUD_ANIM_MS);

    return () => {
      if (thinkingCloudTimerRef.current !== null) {
        window.clearTimeout(thinkingCloudTimerRef.current);
        thinkingCloudTimerRef.current = null;
      }
    };
  }, [isThinking]);

  useEffect(() => {
    return () => {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
      }
      if (transitionRafRef.current !== null) {
        cancelAnimationFrame(transitionRafRef.current);
      }
      if (eyeTransitionTimerRef.current !== null) {
        window.clearTimeout(eyeTransitionTimerRef.current);
      }
      if (eyeTransitionRafRef.current !== null) {
        cancelAnimationFrame(eyeTransitionRafRef.current);
      }
      if (thinkingCloudTimerRef.current !== null) {
        window.clearTimeout(thinkingCloudTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    onStateChange?.({
      eye: activeEye,
      mouth: activeMouth,
      expression: activeExpression,
      speaking: metrics.speaking,
      metrics,
    });
  }, [activeEye, activeExpression, activeMouth, metrics, onStateChange]);

  const headClass = isThinking ? "avatar-thinking" : "avatar-idle";
  const outgoingOpacity = prevMouth ? 1 - transitionProgress : 0;
  const incomingOpacity = prevMouth ? transitionProgress : 1;

  const prevEyeOpacity = prevEye ? 1 - eyeTransitionProgress : 0;
  const currentEyeOpacity = renderEye === "open" ? 0 : prevEye ? eyeTransitionProgress : 1;

  const prevEyeTransform = getEyeMorphTransform(prevEye ?? "open", eyeTransitionProgress, false);
  const currentEyeTransform = getEyeMorphTransform(renderEye, eyeTransitionProgress, true);

  const prevEyeBlur = prevEye ? eyeTransitionProgress * 0.5 : 0;
  const currentEyeBlur = (1 - eyeTransitionProgress) * 0.5;

  const outgoingScaleX = morphScaleX * (1 - transitionProgress * 0.018);
  const outgoingScaleY = morphScaleY * (1 + transitionProgress * 0.024);
  const incomingScaleX = morphScaleX * (0.988 + transitionProgress * 0.012);
  const incomingScaleY = morphScaleY * (1.024 - transitionProgress * 0.024);

  const outgoingTranslateY = morphTranslateY + transitionProgress * 0.35;
  const incomingTranslateY = morphTranslateY + (1 - transitionProgress) * 0.25;

  const outgoingBlur = transitionProgress * 0.45;
  const incomingBlur = (1 - transitionProgress) * 0.45;

  return (
    <div
      className={`avatar-root ${headClass}`}
      style={{
        filter: EXPRESSION_FILTER[activeExpression],
        transition: "filter 0.4s ease",
      }}
    >
      <div className="avatar-layer-wrap">
        <div className="avatar-layer-stack">
          <img
            src={baseImg}
            alt="Priya"
            className="avatar-layer"
            draggable={false}
          />

          {prevEye && prevEye !== "open" && EYE_MAP[prevEye] && (
            <img
              src={EYE_MAP[prevEye]!}
              alt=""
              className="avatar-layer"
              style={{
                opacity: prevEyeOpacity,
                transform: prevEyeTransform,
                filter: `blur(${prevEyeBlur}px)`,
                transition: "transform 130ms cubic-bezier(0.2, 0.72, 0.3, 1), filter 120ms linear",
                willChange: "opacity, transform, filter",
              }}
              draggable={false}
            />
          )}

          {renderEye !== "open" && EYE_MAP[renderEye] && (
            <img
              src={EYE_MAP[renderEye]!}
              alt=""
              className="avatar-layer"
              style={{
                opacity: currentEyeOpacity,
                transform: currentEyeTransform,
                filter: `blur(${currentEyeBlur}px)`,
                transition: "transform 130ms cubic-bezier(0.2, 0.72, 0.3, 1), filter 120ms linear",
                willChange: "opacity, transform, filter",
              }}
              draggable={false}
            />
          )}

          {prevMouth && (
            <img
              src={MOUTH_MAP[prevMouth]}
              alt=""
              className="avatar-layer"
              style={{
                opacity: outgoingOpacity,
                transform: `translateY(${outgoingTranslateY}px) scaleX(${outgoingScaleX}) scaleY(${outgoingScaleY})`,
                filter: `blur(${outgoingBlur}px) saturate(0.95)`,
                transformOrigin: "50% 62%",
                transition: "transform 120ms cubic-bezier(0.2, 0.72, 0.3, 1), filter 120ms linear",
                willChange: "opacity, transform, filter",
              }}
              draggable={false}
            />
          )}

          <img
            src={MOUTH_MAP[renderMouth]}
            alt=""
            className="avatar-layer"
            style={{
              opacity: incomingOpacity * activeLayerOpacity,
              transform: `translateY(${incomingTranslateY}px) scaleX(${incomingScaleX}) scaleY(${incomingScaleY})`,
              filter: `blur(${incomingBlur}px) saturate(1.04)`,
              transformOrigin: "50% 62%",
              transition: "transform 120ms cubic-bezier(0.2, 0.72, 0.3, 1), filter 120ms linear",
              willChange: "opacity, transform, filter",
            }}
            draggable={false}
          />
        </div>
      </div>

      {showThinkingCloud && (
        <div
          className="avatar-thinking-cloud"
          style={{
            opacity: thinkingCloudActive ? 1 : 0,
            transform: thinkingCloudActive
              ? "translateY(0px)"
              : "translateY(6px)",
            transformOrigin: "80% 90%",
            transition: `opacity ${THINKING_CLOUD_ANIM_MS}ms ease, transform ${THINKING_CLOUD_ANIM_MS}ms cubic-bezier(0.22, 0.72, 0.3, 1)`,
            willChange: "opacity, transform",
          }}
        >
          <img
            src={thinkingCloud}
            alt=""
            draggable={false}
          />
        </div>
      )}
    </div>
  );
}

function mouthFamily(mouth: MouthState): "vowel" | "fricative" | "plosive" | "other" {
  if (mouth === "a_e_i" || mouth === "ee" || mouth === "o" || mouth === "u" || mouth === "q_w") {
    return "vowel";
  }
  if (mouth === "f_v" || mouth === "th" || mouth === "j_ch_sh" || mouth === "c_d_n_s_t_x_y_z") {
    return "fricative";
  }
  if (mouth === "b_m_p" || mouth === "g_k") {
    return "plosive";
  }
  return "other";
}

function getTransitionDuration(previous: MouthState, current: MouthState): number {
  if (previous === current) return 80;

  const fromFamily = mouthFamily(previous);
  const toFamily = mouthFamily(current);

  if (toFamily === "plosive" || fromFamily === "plosive") return 84;
  if (toFamily === "fricative" && fromFamily === "fricative") return 90;
  if (toFamily === "vowel" && fromFamily === "vowel") return 98;
  if (current === "neutral" || previous === "neutral") return 88;
  return 90;
}

function getEyeTransitionDuration(previous: EyeState, current: EyeState): number {
  if (previous === current) return 80;
  if (previous === "open" || current === "open") return 110;
  if (previous === "looking_right" || previous === "looking_up" || current === "looking_right" || current === "looking_up") {
    return 130;
  }
  return 96;
}

function getEyeMorphTransform(state: EyeState, progress: number, incoming: boolean): string {
  const direction = incoming ? 1 : -1;

  if (state === "looking_right") {
    const x = incoming ? (1 - progress) * 1.8 : progress * 1.8;
    return `translateX(${x * direction}px) translateY(-0.2px) scaleX(1.01) scaleY(1.01)`;
  }

  if (state === "looking_up") {
    const y = incoming ? (1 - progress) * -1.3 : progress * -1.3;
    return `translateY(${y * direction}px) scaleX(1) scaleY(1.01)`;
  }

  if (state === "quarter_closed") {
    const y = incoming ? (1 - progress) * 0.35 : progress * 0.35;
    return `translateY(${y * direction}px) scaleY(${incoming ? 0.994 + progress * 0.006 : 1 - progress * 0.006})`;
  }

  if (state === "half_closed") {
    const y = incoming ? (1 - progress) * 0.55 : progress * 0.55;
    return `translateY(${y * direction}px) scaleY(${incoming ? 0.988 + progress * 0.012 : 1 - progress * 0.012})`;
  }

  if (state === "closed") {
    return `scaleY(${incoming ? 0.98 + progress * 0.02 : 1 - progress * 0.02})`;
  }

  return "translateX(0) translateY(0) scaleX(1) scaleY(1)";
}

function clamp01(value: number) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function easeInOutCubic(t: number) {
  if (t < 0.5) return 4 * t * t * t;
  return 1 - Math.pow(-2 * t + 2, 3) / 2;
}
