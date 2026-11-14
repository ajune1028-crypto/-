// Serves the source files so index.html opens in a browser: node tools/dev.mjs [port]   (npm run dev)
// Without the Claude page runtime the app keeps rooms on this device only. Open two tabs
// as two people with ?dev=a and ?dev=b on the same address.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = await serve(root, process.argv[2] === undefined ? 8000 : Number(process.argv[2]));
console.log(`http://127.0.0.1:${server.address().port}/index.html`);
