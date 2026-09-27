import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function runMediaProcess(binary, args, { signal, timeoutMs = 30000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let size = 0, failure;
    const stop = error => { failure ||= error; child.kill(); };
    const abort = () => stop(new Error("MEDIA_PROCESS_ABORTED"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error("MEDIA_PROCESS_TIMEOUT")), timeoutMs);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > maxOutputBytes) stop(new Error("MEDIA_PROCESS_OUTPUT_LIMIT"));
      else chunks.push(chunk);
    });
    // Drain stderr, but do not expose filenames/embedded media metadata in logs.
    child.stderr.resume();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.once("error", error => { cleanup(); reject(new Error("MEDIA_PROCESS_START_FAILED", { cause: error })); });
    child.once("close", code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`MEDIA_PROCESS_EXIT_${code}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
function nonnegative(value) {
  if (value === undefined || value === null || value === "N/A") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function absoluteFile(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new TypeError("absolute local media path required");
  return value;
}
export function normalizeProbe(probe) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find(s => s.codec_type === "video");
  const audio = streams.find(s => s.codec_type === "audio");
  const duration = nonnegative(probe.format?.duration ?? video?.duration ?? audio?.duration);
  const rate = String(video?.avg_frame_rate || "").split("/").map(Number);
  const rotation = Number(video?.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate);
  return {
    durationMs: duration === null ? null : Math.round(duration * 1000),
    video: video ? { width: nonnegative(video.width), height: nonnegative(video.height), codec: video.codec_name || null,
      rotation: Number.isFinite(rotation) ? rotation : null,
      frameRate: rate.length === 2 && rate[1] > 0 ? rate[0] / rate[1] : null } : null,
    audio: audio ? { codec: audio.codec_name || null, channels: nonnegative(audio.channels), sampleRate: nonnegative(audio.sample_rate) } : null
  };
}
export function createMediaProcessor({ ffmpeg = "ffmpeg", ffprobe = "ffprobe", run = runMediaProcess } = {}) {
  async function derivative(input, outputName, options, signal) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "marcel-media-process-"));
    const output = path.join(directory, outputName);
    try {
      await run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe",
        "-i", absoluteFile(input), ...options, "-fs", "67108864", "-y", output], { signal, timeoutMs: 120000 });
      if ((await stat(output)).size >= 67108864) throw new Error("MEDIA_DERIVATIVE_SIZE_LIMIT");
      return await readFile(output);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return Object.freeze({
    async inspectBytes(bytes, { signal, poster = false } = {}) {
      if (!Buffer.isBuffer(bytes)) throw new TypeError("media bytes required");
      const directory = await mkdtemp(path.join(os.tmpdir(), "marcel-media-probe-"));
      const input = path.join(directory, "source.bin");
      try {
        await writeFile(input, bytes, { flag: "wx" });
        const metadata = await this.probe(input, { signal });
        return { metadata, poster: poster && metadata.video ? await this.poster(input, { signal }) : null };
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
    async probe(input, { signal } = {}) {
      const json = await run(ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_format", "-show_streams", "-of", "json", absoluteFile(input)], { signal });
      return normalizeProbe(JSON.parse(json));
    },
    poster(input, { signal, seconds = 0 } = {}) {
      if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError("frame time invalid");
      return derivative(input, "poster.png", ["-ss", String(seconds), "-frames:v", "1", "-an", "-vf", "scale=960:960:force_original_aspect_ratio=decrease"], signal);
    },
    async frames(input, { timestamps, signal } = {}) {
      if (!Array.isArray(timestamps) || !timestamps.length || timestamps.length > 12) throw new TypeError("1..12 frame timestamps required");
      const output = [];
      for (const seconds of timestamps) output.push({ seconds, bytes: await this.poster(input, { seconds, signal }) });
      return output;
    },
    audioForAnalysis(input, { signal } = {}) {
      return derivative(input, "analysis.wav", ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"], signal);
    },
    videoPreview(input, { signal } = {}) {
      // Explicit opt-in conversion, never an automatic rewrite of every original.
      return derivative(input, "preview.mp4", ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264",
        "-pix_fmt", "yuv420p", "-vf", "scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-c:a", "aac", "-movflags", "+faststart"], signal);
    }
  });
}
