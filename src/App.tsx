import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import "./components/Avatar/avatar.css";
import { Avatar } from "./components/Avatar";
import type { AvatarControls } from "./components/Avatar";
import { isSarvamConfigured, llmReplyMock, llmReplySarvam, sttSarvam, ttsSarvam } from "./services/sarvamClient";

type ChatRole = "user" | "assistant";
type InputMode = "voice" | "chat";

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  timestamp: number;
  mode: InputMode;
}

const STORAGE_KEY = "sahaara.ai.chatHistory.v2";
const MAX_MESSAGES = 180;
const TRANSCRIPT_WORDS_PREVIEW = 22;

function App() {
  const avatarControlsRef = useRef<AvatarControls | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const aiTranscriptTimerRef = useRef<number | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);

  const [messages, setMessages] = useState<ChatMessage[]>(() => readHistory());
  const [draft, setDraft] = useState("");
  const [isChatOnly, setIsChatOnly] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [liveUserTranscript, setLiveUserTranscript] = useState("");
  const [liveAiTranscript, setLiveAiTranscript] = useState("");
  const [status, setStatus] = useState("Ready");

  const supportsRecording =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const supportsSpeechRecognition =
    typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const supportsVoiceInput = supportsSpeechRecognition || supportsRecording;

  useEffect(() => {
    messagesRef.current = messages;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)));
    } catch {}
  }, [messages]);

  const stopAiTranscriptAnimation = useCallback(() => {
    if (aiTranscriptTimerRef.current !== null) {
      window.clearInterval(aiTranscriptTimerRef.current);
      aiTranscriptTimerRef.current = null;
    }
  }, []);

  const stopAiVoice = useCallback(() => {
    stopAiTranscriptAnimation();
    window.speechSynthesis?.cancel();
    avatarControlsRef.current?.stopAudio();
    avatarControlsRef.current?.setMouthOverride(null);
    setIsSpeaking(false);
    setStatus("Voice stopped");
  }, [stopAiTranscriptAnimation]);

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message].slice(-MAX_MESSAGES));
  }, []);

  const animateAiTranscript = useCallback(
    (text: string) => {
      stopAiTranscriptAnimation();
      setLiveAiTranscript("");
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length === 0) return;
      let index = 0;
      aiTranscriptTimerRef.current = window.setInterval(() => {
        index += 1;
        setLiveAiTranscript(words.slice(0, index).join(" "));
        if (index >= words.length) {
          stopAiTranscriptAnimation();
        }
      }, 90);
    },
    [stopAiTranscriptAnimation]
  );

  const speakReply = useCallback(
    async (text: string) => {
      if (isChatOnly) return;
      setIsSpeaking(true);
      animateAiTranscript(text);

      if (isSarvamConfigured()) {
        try {
          const audioBuffer = await ttsSarvam(text);
          await avatarControlsRef.current?.playAudio(audioBuffer.slice(0));
          setLiveAiTranscript(text);
          setIsSpeaking(false);
          return;
        } catch (error) {
          setStatus(`TTS fallback: ${toErrorMessage(error)}`);
        }
      }

      if (!("speechSynthesis" in window)) {
        setIsSpeaking(false);
        setLiveAiTranscript(text);
        return;
      }

      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = "en-IN";
      utter.rate = 1.02;
      utter.onend = () => {
        setIsSpeaking(false);
        setLiveAiTranscript(text);
      };
      utter.onerror = () => {
        setIsSpeaking(false);
        setLiveAiTranscript(text);
      };
      window.speechSynthesis.speak(utter);
    },
    [animateAiTranscript, isChatOnly]
  );

  const submitUserMessage = useCallback(
    async (text: string, mode: InputMode) => {
      const normalized = text.trim();
      if (!normalized) return;

      const snapshot = messagesRef.current;

      appendMessage({
        id: crypto.randomUUID(),
        role: "user",
        text: normalized,
        timestamp: Date.now(),
        mode,
      });

      setIsThinking(true);
      setStatus("Thinking");

      let reply = "";

      if (isSarvamConfigured()) {
        try {
          reply = await llmReplySarvam(normalized, snapshot);
        } catch (error) {
          setStatus(`LLM fallback: ${toErrorMessage(error)}`);
          reply = await llmReplyMock(normalized, snapshot);
        }
      } else {
        reply = await llmReplyMock(normalized, snapshot);
      }

      appendMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        text: reply,
        timestamp: Date.now(),
        mode: "chat",
      });

      avatarControlsRef.current?.applyExpressionFromText(reply);
      setIsThinking(false);
      setStatus("Replied");

      if (!isChatOnly) {
        await speakReply(reply);
      }
    },
    [appendMessage, isChatOnly, speakReply]
  );

  const processVoiceBlob = useCallback(
    async (blob: Blob) => {
      if (blob.size < 1200 || isChatOnly) return;

      setStatus("Transcribing");
      setLiveUserTranscript("Listening...");

      let transcript = "";

      if (isSarvamConfigured()) {
        try {
          transcript = await sttSarvam(blob);
        } catch (error) {
          setStatus(`STT failed: ${toErrorMessage(error)}`);
          return;
        }
      }

      const clean = transcript.trim();
      if (!clean) return;
      setLiveUserTranscript(clean);
      await submitUserMessage(clean, "voice");
    },
    [isChatOnly, submitUserMessage]
  );

  const stopRecording = useCallback(
    (forceOffMic: boolean) => {
      if (flushTimerRef.current !== null) {
        window.clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }

      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }

      mediaRecorderRef.current = null;
      chunksRef.current = [];
      setIsRecording(false);

      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }

      if (forceOffMic) {
        setIsMicOn(false);
      }
    },
    []
  );

  const stopSpeechRecognition = useCallback(() => {
    if (!recognitionRef.current) return;
    recognitionRef.current.onstart = null;
    recognitionRef.current.onend = null;
    recognitionRef.current.onerror = null;
    recognitionRef.current.onresult = null;
    recognitionRef.current.stop();
    recognitionRef.current = null;
  }, []);

  const startRecording = useCallback(async () => {
    if (!supportsRecording || isChatOnly || !isSarvamConfigured()) return;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaStreamRef.current = stream;

    const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType: preferredType });
    mediaRecorderRef.current = recorder;

    recorder.onstart = () => {
      setIsRecording(true);
      setStatus("Mic on");
      setLiveUserTranscript("Listening...");
    };

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
      const ready = chunksRef.current;
      chunksRef.current = [];
      if (ready.length === 0) return;
      const blob = new Blob(ready, { type: preferredType });
      queueRef.current = queueRef.current
        .then(async () => processVoiceBlob(blob))
        .catch(() => undefined);
    };

    recorder.onerror = () => {
      setStatus("Mic error");
      stopRecording(true);
    };

    recorder.start(3200);

    flushTimerRef.current = window.setInterval(() => {
      if (recorder.state === "recording") {
        recorder.requestData();
      }
    }, 3200);
  }, [isChatOnly, processVoiceBlob, stopRecording, supportsRecording]);

  const startSpeechRecognition = useCallback(async () => {
    if (!supportsSpeechRecognition || isChatOnly) return;

    const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!RecognitionCtor) return;

    const recognition = new RecognitionCtor();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-IN";

    recognition.onstart = () => {
      setIsRecording(true);
      setStatus("Mic on");
      setLiveUserTranscript("Listening...");
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0]?.transcript?.trim() ?? "";
        if (!transcript) continue;
        if (event.results[i].isFinal) {
          setLiveUserTranscript(transcript);
          void submitUserMessage(transcript, "voice");
        } else {
          interim = `${interim} ${transcript}`.trim();
        }
      }
      if (interim) {
        setLiveUserTranscript(interim);
      }
    };

    recognition.onerror = () => {
      setStatus("Speech recognition error");
      setIsRecording(false);
      stopSpeechRecognition();
      if (isSarvamConfigured()) {
        void startRecording();
      }
    };

    recognition.onend = () => {
      if (isMicOn && !isChatOnly) {
        recognition.start();
      } else {
        setIsRecording(false);
      }
    };

    recognition.start();
  }, [isChatOnly, isMicOn, startRecording, stopSpeechRecognition, submitUserMessage, supportsSpeechRecognition]);

  useEffect(() => {
    if (isChatOnly && isMicOn) {
      setIsMicOn(false);
    }
  }, [isChatOnly, isMicOn]);

  useEffect(() => {
    if (!isMicOn || isChatOnly) {
      stopSpeechRecognition();
      stopRecording(false);
      return;
    }

    if (supportsSpeechRecognition) {
      void startSpeechRecognition().catch((error) => {
        setStatus(`Mic blocked: ${toErrorMessage(error)}`);
        if (isSarvamConfigured()) {
          void startRecording().catch(() => stopRecording(true));
        } else {
          stopRecording(true);
        }
      });
      return;
    }

    void startRecording().catch((error) => {
      setStatus(`Mic blocked: ${toErrorMessage(error)}`);
      stopRecording(true);
    });
  }, [
    isChatOnly,
    isMicOn,
    startRecording,
    stopRecording,
    startSpeechRecognition,
    stopSpeechRecognition,
    supportsSpeechRecognition,
  ]);

  useEffect(() => {
    return () => {
      stopSpeechRecognition();
      stopRecording(true);
      stopAiVoice();
      stopAiTranscriptAnimation();
    };
  }, [stopAiTranscriptAnimation, stopAiVoice, stopRecording, stopSpeechRecognition]);

  const handleSend = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const text = draft.trim();
      if (!text) return;
      setDraft("");
      await submitUserMessage(text, "chat");
    },
    [draft, submitUserMessage]
  );

  const clearHistory = useCallback(() => {
    setMessages([]);
    setDraft("");
    setLiveUserTranscript("");
    setLiveAiTranscript("");
    localStorage.removeItem(STORAGE_KEY);
    setStatus("History cleared");
  }, []);

  const toggleChatOnly = useCallback(() => {
    setIsChatOnly((prev) => {
      const next = !prev;
      if (next) {
        setIsMicOn(false);
        stopRecording(false);
        stopAiVoice();
      }
      setStatus(next ? "Chat mode" : "Voice mode");
      return next;
    });
  }, [stopAiVoice, stopRecording]);

  const transcriptUser = liveUserTranscript || lastRoleText(messages, "user");
  const transcriptAi = liveAiTranscript || lastRoleText(messages, "assistant");
  const recentMessages = useMemo(() => messages.slice(-24).reverse(), [messages]);

  return (
    <div className="app-shell">
      <main className={`main-layout ${isChatOnly ? "chat-mode" : "voice-mode"}`}>
        <section className="avatar-stage">
          <div className="avatar-frame">
            <Avatar
              isThinking={isThinking}
              onReady={(controls) => {
                avatarControlsRef.current = controls;
              }}
            />
          </div>

          <div className="avatar-controls" role="toolbar" aria-label="Avatar controls">
            <button
              className={`icon-btn ${isMicOn ? "danger" : "success"} ${isRecording ? "listening" : ""}`}
              onClick={() => setIsMicOn((prev) => !prev)}
              disabled={isChatOnly || !supportsVoiceInput}
              title={isMicOn ? "Mic off" : "Mic on"}
              aria-label={isMicOn ? "Mic off" : "Mic on"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 15.5a3.5 3.5 0 0 0 3.5-3.5V7a3.5 3.5 0 0 0-7 0v5a3.5 3.5 0 0 0 3.5 3.5zm-6-3.5a1 1 0 1 1 2 0 4 4 0 0 0 8 0 1 1 0 1 1 2 0 5.98 5.98 0 0 1-5 5.91V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.09A5.98 5.98 0 0 1 6 12z" />
              </svg>
            </button>
            <button
              className="icon-btn secondary"
              onClick={stopAiVoice}
              disabled={!isSpeaking}
              title="Stop voice"
              aria-label="Stop voice"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 7h10v10H7z" />
              </svg>
            </button>
            <button className="icon-btn secondary" onClick={clearHistory} title="Clear" aria-label="Clear">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 3a1 1 0 0 0-1 1v1H5a1 1 0 1 0 0 2h1v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7h1a1 1 0 1 0 0-2h-3V4a1 1 0 0 0-1-1H9zm1 2h4v1h-4V5zm-2 2h8v12H8V7zm2 2a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1zm4 0a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z" />
              </svg>
            </button>
            <button
              className={`icon-btn ${isChatOnly ? "success" : "secondary"}`}
              onClick={toggleChatOnly}
              title={isChatOnly ? "Voice mode" : "Chat mode"}
              aria-label={isChatOnly ? "Voice mode" : "Chat mode"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9.7l-3.95 3.36A1 1 0 0 1 4 18.98V16a3 3 0 0 1-3-3V5h3zm3-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h.86a1 1 0 0 1 1 1v1.82l2.62-2.22a1 1 0 0 1 .65-.24H17a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7z" />
              </svg>
            </button>
          </div>
        </section>

        {isChatOnly && (
          <section className="chat-panel">
            <div className="chat-list">
              {recentMessages.length === 0 && <div className="empty-chat">No chats</div>}
              {recentMessages.map((message) => (
                <article key={message.id} className={`msg ${message.role}`}>
                  <div className="meta">
                    <span>{message.role === "user" ? "You" : "AI"}</span>
                    <span>{formatTime(message.timestamp)}</span>
                  </div>
                  <p>{message.text}</p>
                </article>
              ))}
            </div>

            <form className="chat-form" onSubmit={handleSend}>
              <textarea
                rows={3}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Type"
              />
              <button type="submit" className="send-btn" aria-label="Send">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3.2 20.8a1 1 0 0 1-.18-1.8l16.2-7a1 1 0 0 0 0-1.84l-16.2-7a1 1 0 0 1 .26-1.91 1 1 0 0 1 .32.05l17.3 7.48a3 3 0 0 1 0 5.52L3.6 21.75a1 1 0 0 1-1.27-.95 1 1 0 0 1 .87-1z" />
                </svg>
              </button>
            </form>
          </section>
        )}
      </main>

      <p className="sr-status" aria-live="polite">
        {status}
      </p>

      {!isChatOnly && (
        <section className="floating-conversation" aria-label="Live conversation">
          <div className="floating-conversation-stream">
            <div className="mini-row user">
              <span className="who">You</span>
              <p>{toPreview(transcriptUser)}</p>
            </div>
            <div className="mini-row ai">
              <span className="who">AI</span>
              <p>{toPreview(transcriptAi)}</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function readHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MAX_MESSAGES);
  } catch {
    return [];
  }
}

function toPreview(text: string): string {
  if (!text) return "...";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= TRANSCRIPT_WORDS_PREVIEW) return text;
  return `${words.slice(words.length - TRANSCRIPT_WORDS_PREVIEW).join(" ")}...`;
}

function lastRoleText(messages: ChatMessage[], role: ChatRole): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === role) return messages[i].text;
  }
  return "";
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default App;