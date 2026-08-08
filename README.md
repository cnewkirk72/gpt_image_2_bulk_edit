# gpt-image-2 bulk edit — remote MCP server

A remote [MCP](https://modelcontextprotocol.io) server that exposes OpenAI's `gpt-image-2` model for
single and bulk image editing, built to be used as a **Claude custom connector** (Cowork / claude.ai).

## Tools

| Tool | What it does |
| --- | --- |
| `generate_image` | Generate 1–4 images from a text prompt |
| `edit_image` | Edit / combine up to 8 input images (optional PNG mask) |
| `bulk_edit` | Up to 8 independent edits per call, 3 running in parallel |
| `list_outputs` | List generated files still available for download |

Inputs are public `https://` image URLs or base64 `data:` URIs (png / jpeg / webp, ≤50 MB each).
Outputs are saved server-side and returned as download URLs (disk mode: served from `/files/…`,
swept after ~6 h; Vercel Blob mode: permanent public blob URLs).

## Deploy on Railway

1. Create a new Railway project from this GitHub repo — the `Dockerfile` is detected automatically.
2. Set Variables:
   - `OPENAI_API_KEY` — your OpenAI key (org must have gpt-image-2 access).
   - `MCP_AUTH_TOKEN` — shared secret, e.g. `openssl rand -hex 32`. **Without it the endpoint is public.**
   - `PUBLIC_BASE_URL` — the public URL Railway gives you (no trailing slash), e.g. `https://<app>.up.railway.app`.
3. Generate a public domain (Settings → Networking) and redeploy.

Health check: `GET /healthz`. MCP endpoint: `POST /mcp` with `Authorization: Bearer <MCP_AUTH_TOKEN>`.

### Claude custom connector

Add a custom connector with URL `https://<your-app>.up.railway.app/mcp` and the auth token as a
bearer header. If your client can't send headers, set `MCP_PATH_SECRET` instead and use
`https://<your-app>.up.railway.app/mcp/<secret>` as the connector URL.

## Local development

```bash
npm install
cp .env.example .env   # fill in OPENAI_API_KEY
npm run dev            # http server on :3000
TRANSPORT=stdio npm run dev   # stdio mode for local MCP clients
```

## Vercel

`vercel.json` + `api/index.ts` are included for serverless deployment; connect a Vercel Blob store
(`BLOB_READ_WRITE_TOKEN`) since serverless disk is ephemeral.
