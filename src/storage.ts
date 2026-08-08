import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OUTPUT_TTL_MS } from "./constants.js";

export interface StoredImage {
  filename: string;
  size_bytes: number;
  /** Fully-qualified public download URL. */
  download_url: string;
}

export interface OutputListing {
  filename: string;
  size_bytes: number;
  created_at: string;
  download_url: string;
}

const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve("output");

export function usingBlob(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function publicBase(): string {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "";
}

function safeName(prefix: string | undefined, format: string): string {
  const p = (prefix ?? "image").toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 40);
  return `${p}-${randomUUID()}.${format}`;
}

export async function initStorage(): Promise<void> {
  if (usingBlob()) return;
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  if (!process.env.VERCEL) {
    setInterval(() => void sweepDisk(), 15 * 60 * 1000).unref();
  }
}

export async function saveImage(
  b64: string,
  format: "png" | "jpeg" | "webp",
  prefix?: string
): Promise<StoredImage> {
  const filename = safeName(prefix, format);
  const buf = Buffer.from(b64, "base64");

  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    const blob = await put(`gpt-image-2/${filename}`, buf, {
      access: "public",
      contentType: `image/${format}`,
    });
    return { filename, size_bytes: buf.length, download_url: blob.url };
  }

  await fs.writeFile(path.join(OUTPUT_DIR, filename), buf);
  return {
    filename,
    size_bytes: buf.length,
    download_url: `${publicBase()}/files/${filename}`,
  };
}

export async function listOutputs(): Promise<OutputListing[]> {
  if (usingBlob()) {
    const { list } = await import("@vercel/blob");
    const res = await list({ prefix: "gpt-image-2/", limit: 1000 });
    return res.blobs
      .map((b) => ({
        filename: b.pathname.replace(/^gpt-image-2\//, ""),
        size_bytes: b.size,
        created_at: new Date(b.uploadedAt).toISOString(),
        download_url: b.url,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  const out: OutputListing[] = [];
  for (const filename of await fs.readdir(OUTPUT_DIR)) {
    try {
      const st = await fs.stat(path.join(OUTPUT_DIR, filename));
      if (!st.isFile()) continue;
      out.push({
        filename,
        size_bytes: st.size,
        created_at: st.mtime.toISOString(),
        download_url: `${publicBase()}/files/${filename}`,
      });
    } catch {
      /* raced with sweep */
    }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Disk mode only: resolve a served filename safely (blocks path traversal). */
export function resolveServedFile(filename: string): string | null {
  if (!/^[a-z0-9-_.]+\.(png|jpeg|webp)$/i.test(filename)) return null;
  const full = path.join(OUTPUT_DIR, filename);
  if (!full.startsWith(OUTPUT_DIR)) return null;
  return full;
}

async function sweepDisk(): Promise<void> {
  const cutoff = Date.now() - OUTPUT_TTL_MS;
  try {
    for (const filename of await fs.readdir(OUTPUT_DIR)) {
      const full = path.join(OUTPUT_DIR, filename);
      try {
        const st = await fs.stat(full);
        if (st.isFile() && st.mtimeMs < cutoff) await fs.unlink(full);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.error("[storage] sweep failed:", err);
  }
}

export function outputDirDescription(): string {
  return usingBlob() ? "vercel-blob" : OUTPUT_DIR;
}
