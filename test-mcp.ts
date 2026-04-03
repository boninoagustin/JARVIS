import { getN8nTools } from './src/mcp/client.js';

async function test() {
  console.log("Loading N8N MCP tools...");
  const tools = await getN8nTools();
  console.log(`Loaded ${tools.length} tools.`);
  if (tools.length > 0) {
    console.log("Sample tool:");
    console.log(tools[0].name);
    console.log(tools[0].description);
  }
  process.exit(0);
}

test();
