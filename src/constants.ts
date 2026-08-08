export const MODEL = "gpt-image-2";

/** Max reference images the gpt-image-2 edits endpoint accepts per call. */
export const MAX_REF_IMAGES = 8;

/** Max items per bulk_edit call. Keeps a single HTTP request under proxy timeouts. */
export const MAX_BULK_ITEMS = 8;

/** How many OpenAI edit calls run in parallel inside bulk_edit. */
export const BULK_CONCURRENCY = 3;

/** Max bytes we will download for a single input image (50 MB, matches API cap). */
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;

/** Output files older than this are swept (default 6h). */
export const OUTPUT_TTL_MS = 6 * 60 * 60 * 1000;

export const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
export const QUALITIES = ["auto", "low", "medium", "high"] as const;

export type ImageSize = (typeof SIZES)[number];
export type ImageQuality = (typeof QUALITIES)[number];
