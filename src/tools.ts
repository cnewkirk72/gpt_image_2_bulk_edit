import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MAX_BULK_ITEMS,
  MAX_REF_IMAGES,
  BULK_CONCURRENCY,
  SIZES,
  QUALITIES,
  type ImageQuality,
  type ImageSize,
} from "./constants.js";
import {
  fetchInputImage,
  generateImages,
  editImage,
  estimateCostUsd,
  toActionableError,
  type Usage,
} from "./openaiClient.js";
import { saveImage, listOutputs, type StoredImage } from "./storage.js";

const sizeSchema = z.enum(SIZES).default("auto").describe("Output size. 'auto' lets the model pick.");
const qualitySchema = z
  .enum(QUALITIES)
  .default("auto")
  .describe("Rendering quality. Higher costs more tokens.");
const formatSchema = z
  .enum(["png", "jpeg", "webp"])
  .default("png")
  .describe("Output file format.");
const imageSourceSchema = z
  .string()
  .describe("A public https:// image URL or a data:image/...;base64,... URI (png, jpeg or webp).");
const prefixSchema = z
  .string()
  .max(40)
  .optional()
  .describe("Optional filename prefix for the saved output(s).");

interface SavedResult {
  files: StoredImage[];
  usage?: Usage;
  applied_size?: string;
  applied_quality?: string;
}

async function saveAll(
  images: { b64: string; format: "png" | "jpeg" | "webp" }[],
  prefix?: string
): Promise<StoredImage[]> {
  const out: StoredImage[] = [];
  for (const img of images) {
    out.push(await saveImage(img.b64, img.format, prefix));
  }
  return out;
}

function resultText(r: SavedResult): string {
  return JSON.stringify(
    {
      ok: true,
      files: r.files,
      applied_size: r.applied_size,
      applied_quality: r.applied_quality,
      usage: r.usage,
      estimated_cost_usd: estimateCostUsd(r.usage),
    },
    null,
    2
  );
}

function errorText(err: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: toActionableError(err) }) }],
    isError: true,
  };
}

/** Simple promise pool: run tasks with bounded concurrency, preserving order. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function registerTools(server: McpServer): void {
  server.tool(
    "generate_image",
    "Generate 1-4 new images from a text prompt with OpenAI gpt-image-2. Returns download URLs for the saved files.",
    {
      prompt: z.string().min(1).max(32000).describe("What to generate."),
      n: z.number().int().min(1).max(4).default(1).describe("Number of images (1-4)."),
      size: sizeSchema,
      quality: qualitySchema,
      output_format: formatSchema,
      filename_prefix: prefixSchema,
    },
    async ({ prompt, n, size, quality, output_format, filename_prefix }) => {
      try {
        const res = await generateImages({
          prompt,
          n,
          size: size as ImageSize,
          quality: quality as ImageQuality,
          output_format,
        });
        const files = await saveAll(res.images, filename_prefix);
        return {
          content: [
            {
              type: "text",
              text: resultText({ files, usage: res.usage, applied_size: res.applied_size, applied_quality: res.applied_quality }),
            },
          ],
        };
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.tool(
    "edit_image",
    `Edit or combine up to ${MAX_REF_IMAGES} input images with a text prompt using gpt-image-2. ` +
      "Optionally restrict the edit to the transparent region of a PNG mask. Returns download URLs.",
    {
      prompt: z.string().min(1).max(32000).describe("Edit instruction."),
      images: z
        .array(imageSourceSchema)
        .min(1)
        .max(MAX_REF_IMAGES)
        .describe(`Input image(s), ${MAX_REF_IMAGES} max. First image is the primary edit target.`),
      mask: imageSourceSchema
        .optional()
        .describe("Optional PNG mask; transparent areas mark where the first image may change."),
      size: sizeSchema,
      quality: qualitySchema,
      output_format: formatSchema,
      filename_prefix: prefixSchema,
    },
    async ({ prompt, images, mask, size, quality, output_format, filename_prefix }) => {
      try {
        const fetched = await Promise.all(images.map((s, i) => fetchInputImage(s, i)));
        const fetchedMask = mask ? await fetchInputImage(mask, images.length) : undefined;
        const res = await editImage({
          prompt,
          images: fetched,
          mask: fetchedMask,
          size: size as ImageSize,
          quality: quality as ImageQuality,
          output_format,
        });
        const files = await saveAll(res.images, filename_prefix);
        return {
          content: [
            {
              type: "text",
              text: resultText({ files, usage: res.usage, applied_size: res.applied_size, applied_quality: res.applied_quality }),
            },
          ],
        };
      } catch (err) {
        return errorText(err);
      }
    }
  );

  server.tool(
    "bulk_edit",
    `Apply edits to up to ${MAX_BULK_ITEMS} images in one call (${BULK_CONCURRENCY} run in parallel). ` +
      "Each item is an independent gpt-image-2 edit; a shared prompt applies unless an item overrides it. " +
      "Items succeed or fail independently — check each result's ok flag.",
    {
      prompt: z
        .string()
        .max(32000)
        .optional()
        .describe("Shared edit instruction applied to every item that has no prompt of its own."),
      items: z
        .array(
          z.object({
            images: z
              .array(imageSourceSchema)
              .min(1)
              .max(MAX_REF_IMAGES)
              .describe("Input image(s) for this item."),
            prompt: z.string().max(32000).optional().describe("Per-item override of the shared prompt."),
            filename_prefix: prefixSchema,
          })
        )
        .min(1)
        .max(MAX_BULK_ITEMS)
        .describe(`Edits to perform, ${MAX_BULK_ITEMS} max per call.`),
      size: sizeSchema,
      quality: qualitySchema,
      output_format: formatSchema,
    },
    async ({ prompt, items, size, quality, output_format }) => {
      const missing = items.findIndex((it) => !(it.prompt ?? prompt));
      if (missing !== -1) {
        return errorText(
          new Error(`Item ${missing + 1} has no prompt and no shared prompt was provided.`)
        );
      }
      const results = await pool(items, BULK_CONCURRENCY, async (item, i) => {
        try {
          const fetched = await Promise.all(item.images.map((s, j) => fetchInputImage(s, j)));
          const res = await editImage({
            prompt: (item.prompt ?? prompt) as string,
            images: fetched,
            size: size as ImageSize,
            quality: quality as ImageQuality,
            output_format,
          });
          const files = await saveAll(res.images, item.filename_prefix);
          return {
            item: i + 1,
            ok: true as const,
            files,
            usage: res.usage,
            estimated_cost_usd: estimateCostUsd(res.usage),
          };
        } catch (err) {
          return { item: i + 1, ok: false as const, error: toActionableError(err) };
        }
      });
      const succeeded = results.filter((r) => r.ok).length;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: succeeded > 0, succeeded, failed: results.length - succeeded, results },
              null,
              2
            ),
          },
        ],
        ...(succeeded === 0 ? { isError: true as const } : {}),
      };
    }
  );

  server.tool(
    "list_outputs",
    "List previously generated/edited images still available on the server (outputs expire after ~6h in disk mode).",
    {},
    async () => {
      try {
        const outputs = await listOutputs();
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, count: outputs.length, outputs }, null, 2) },
          ],
        };
      } catch (err) {
        return errorText(err);
      }
    }
  );
}
