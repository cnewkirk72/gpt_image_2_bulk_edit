// Vercel serverless entrypoint. All routes rewritten here via vercel.json.
import { createApp } from "../src/app.js";
import { initStorage } from "../src/storage.js";

await initStorage();
const app = createApp();
export default app;
