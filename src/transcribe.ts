/**
 * Local speech-to-text transcription using OpenAI Whisper.
 *
 * Requires: ffmpeg, openai-whisper (Python) installed in the container.
 * Set STT_ENABLED=true to activate. WHISPER_MODEL defaults to "base".
 */

import { execFile } from "child_process";
import { writeFile, readFile, unlink, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Supported audio MIME types and their file extensions */
const AUDIO_MIME_MAP: Record<string, string> = {
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/m4a": ".m4a",
  "audio/webm": ".webm",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "video/webm": ".webm", // MediaRecorder sometimes produces video/webm with audio only
};

/** Check if STT is enabled via environment variable */
export function isSttEnabled(): boolean {
  return process.env.STT_ENABLED?.toLowerCase() === "true";
}

/** Check if a MIME type is a supported audio format */
export function isAudioMime(mime: string): boolean {
  return mime.toLowerCase() in AUDIO_MIME_MAP;
}

/** Get file extension for a MIME type */
function extForMime(mime: string): string {
  return AUDIO_MIME_MAP[mime.toLowerCase()] || ".ogg";
}

/**
 * Transcribe an audio buffer to text using local Whisper.
 *
 * Pipeline: audio buffer → temp file → ffmpeg (→ 16kHz mono WAV) → whisper CLI → text
 *
 * @param audioBuffer - Raw audio data
 * @param mimeType - MIME type of the audio (e.g. "audio/ogg")
 * @returns Transcribed text
 * @throws If transcription fails or produces empty output
 */
export async function transcribe(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const model = process.env.WHISPER_MODEL || "base";
  const tmpDir = await mkdtemp(join(tmpdir(), "whisper-"));
  const ext = extForMime(mimeType);
  const inputPath = join(tmpDir, `input${ext}`);
  const wavPath = join(tmpDir, "input.wav");

  try {
    // Write audio to temp file
    await writeFile(inputPath, audioBuffer);

    // Convert to 16kHz mono WAV (Whisper's preferred format)
    await execFileAsync("ffmpeg", [
      "-i", inputPath,
      "-ar", "16000",
      "-ac", "1",
      "-f", "wav",
      "-y",
      wavPath,
    ], { timeout: 30_000 });

    // Run Whisper CLI
    const { stdout, stderr } = await execFileAsync("whisper", [
      wavPath,
      "--model", model,
      "--output_format", "txt",
      "--output_dir", tmpDir,
      "--language", process.env.WHISPER_LANGUAGE || "en",
      "--fp16", "False", // CPU-safe
    ], { timeout: 120_000 });

    // Whisper writes output to <basename>.txt
    const txtPath = join(tmpDir, "input.txt");
    const text = (await readFile(txtPath, "utf-8")).trim();

    if (!text) {
      throw new Error("Whisper produced empty transcription");
    }

    console.log(`[STT] Transcribed ${audioBuffer.length} bytes → ${text.length} chars (model=${model})`);
    return text;
  } finally {
    // Clean up temp files
    await cleanup(inputPath, wavPath, join(tmpDir, "input.txt"), tmpDir);
  }
}

/** Best-effort cleanup of temp files */
async function cleanup(...paths: string[]) {
  for (const p of paths) {
    try {
      await unlink(p);
    } catch {
      // ignore — might not exist
    }
  }
  // Try to remove the temp directory
  try {
    const { rmdir } = await import("fs/promises");
    await rmdir(paths[paths.length - 1]);
  } catch {
    // ignore
  }
}
