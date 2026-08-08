import OpenAI, { toFile } from "openai";
import {
  MODEL,
  MAX_INPUT_BYTES,
  type ImageQuality,
  type ImageSize,
} from "./constants.js";

let client: OpenAI | null = null;

export function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Set it in the server's environment (never in code)."
      );
    }
    client = new OpenAI({ apiKey, timeout: 10 * 60 * 1000, maxRetries: 2 });
  }
  return client;
}

export interface GeneratedImage {
  b64: string;
  format: "png" | "jpeg" | "webp";
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface ImagesResult {
  images: GeneratedImage[];
  usage?: Usage;
  applied_size?: string;
  applied_quality?: string;
}

type FetchedInput = Awaited<ReturnType<typeof toFile>>;

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Fetch an input image from an https URL or decode a data: URI.
 * Enforces size and mime-type limits and blocks non-https schemes
 * (prevents the server being used to probe internal networks).
 */
export async function fetchInputImage(
  source: string,
  index: number
): Promise<FetchedInput> {
  if (source.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(source);
    if (!match) {
      throw new Error(
        `Input ${index + 1}: data URIs must look like data:image/png;base64,... (png, jpeg or webp).`
      );
    }
    const buf = Buffer.from(match[2], "base64");
    if (buf.length > MAX_INPUT_BYTES) {
      throw new Error(`Input ${index + 1}: exceeds the 50MB per-image limit.`);
    }
    const ext = match[1].split("/")[1];
    return toFile(buf, `input-${index + 1}.${ext}`, { type: match[1] });
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(
      `Input ${index + 1}: "${source.slice(0, 80)}" is not a valid https URL or data URI. ` +
        `Local file paths cannot be read by this remote server — upload the file somewhere reachable or pass it as a base64 data URI.`
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(`Input ${index + 1}: only https:// URLs are allowed (got ${url.protocol}//).`);
  }

  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(
      `Input ${index + 1}: download failed with HTTP ${res.status} from ${url.hostname}. Check the URL is public.`
    );
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_INPUT_BYTES) {
    throw new Error(`Input ${index + 1}: exceeds the 50MB per-image limit.`);
  }
  const mime = ALLOWED_MIME.has(contentType) ? contentType : sniffMime(buf);
  if (!mime) {
    throw new Error(
      `Input ${index + 1}: content from ${url.hostname} is not a PNG, JPEG or WEBP image (got "${contentType || "unknown"}").`
    );
  }
  return toFile(buf, `input-${index + 1}.${mime.split("/")[1]}`, { type: mime });
}

function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  return null;
}

export async function generateImages(params: {
  prompt: string;
  n: number;
  size: ImageSize;
  quality: ImageQuality;
  output_format: "png" | "jpeg" | "webp";
}): Promise<ImagesResult> {
  const res = await getClient().images.generate({
    model: MODEL,
    prompt: params.prompt,
    n: params.n,
    size: params.size,
    quality: params.quality,
    output_format: params.output_format,
  } as never);
  return normalize(res, params.output_format);
}

export async function editImage(params: {
  prompt: string;
  images: FetchedInput[];
  mask?: FetchedInput;
  size: ImageSize;
  quality: ImageQuality;
  output_format: "png" | "jpeg" | "webp";
}): Promise<ImagesResult> {
  const res = await getClient().images.edit({
    model: MODEL,
    prompt: params.prompt,
    image: params.images.length === 1 ? params.images[0] : params.images,
    ...(params.mask ? { mask: params.mask } : {}),
    size: params.size,
    quality: params.quality,
    output_format: params.output_format,
  } as never);
  return normalize(res, params.output_format);
}

function normalize(res: unknown, format: "png" | "jpeg" | "webp"): ImagesResult {
  const r = res as {
    data?: Array<{ b64_json?: string }>;
    usage?: Usage;
    size?: string;
    quality?: string;
  };
  const images: GeneratedImage[] = (r.data ?? [])
    .filter((d): d is { b64_json: string } => typeof d.b64_json === "string")
    .map((d) => ({ b64: d.b64_json, format }));
  if (images.length === 0) {
    throw new Error("The API returned no image data. Try again or simplify the prompt.");
  }
  return { images, usage: r.usage, applied_size: r.size, applied_quality: r.quality };
}

/** Rough USD estimate from token usage (gpt-image-2 image output token pricing). */
export function estimateCostUsd(usage?: Usage): number | undefined {
  if (!usage?.total_tokens) return undefined;
  const input = (usage.input_tokens ?? 0) * (10 / 1_000_000);
  const output = (usage.output_tokens ?? 0) * (40 / 1_000_000);
  const est = input + output;
  return Math.round(est * 10_000) / 10_000;
}

/** Convert OpenAI SDK errors into actionable, non-leaky messages. */
export function toActionableError(err: unknown): string {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 401) return "OpenAI rejected the API key (401). Rotate/verify OPENAI_API_KEY on the server.";
    if (status === 403)
      return "OpenAI returned 403 — gpt-image-2 may require Organization Verification on your OpenAI org. Check the OpenAI dashboard.";
    if (status === 429) {
      if (err.code === "insufficient_quota") {
        return "OpenAI says the account is out of credits (429 insufficient_quota). Add billing credit on platform.openai.com, then retry.";
      }
      return `OpenAI rate limit hit (429 ${err.code ?? ""}): ${err.message}. Reduce bulk size or wait ~60s and retry.`;
    }
    if (status === 400) return `OpenAI rejected the request (400): ${err.message}`;
    return `OpenAI API error (${status ?? "network"}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
