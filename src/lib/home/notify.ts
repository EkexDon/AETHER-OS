/**
 * Phase-end feedback for the Pomodoro timer: desktop notifications through
 * `@tauri-apps/plugin-notification` (permission checked first, like the
 * calendar reminders) and an optional short chime synthesised with Web
 * Audio (no audio assets). Both degrade silently where unavailable — the
 * in-app toast is the always-on channel.
 */
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isTauriRuntime } from "../ipc/core";

/** Whether desktop notifications may be shown (asks once if undecided). */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** Show a desktop notification; resolves `false` when it could not be shown. */
export async function sendDesktopNotification(title: string, body: string): Promise<boolean> {
  if (!(await ensureNotificationPermission())) return false;
  try {
    sendNotification({ title, body });
    return true;
  } catch {
    return false;
  }
}

type AudioContextCtor = typeof AudioContext;

/**
 * Two soft sine tones (E5 → A5), ~0.6 s. Returns `false` when Web Audio is
 * unavailable or blocked.
 */
export function playChime(): boolean {
  const Ctor: AudioContextCtor | undefined =
    typeof window !== "undefined"
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext)
      : undefined;
  if (!Ctor) return false;
  try {
    const ctx = new Ctor();
    const start = ctx.currentTime;
    [659.25, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = start + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.45);
    });
    window.setTimeout(() => void ctx.close().catch(() => undefined), 900);
    return true;
  } catch {
    return false;
  }
}
