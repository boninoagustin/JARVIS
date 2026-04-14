import { getN8nTools } from './src/mcp/client.js';

async function test() {
  console.log("Loading N8N MCP tools...");
  const tools = await getN8nTools();
  console.log(`Loaded ${tools.length} tools:`);
  tools.forEach(t => console.log(`- ${t.name}`));
  process.exit(0);
}

test();
