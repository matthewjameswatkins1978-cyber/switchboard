#!/usr/bin/env node
import { runPlugMcpServer } from '../dist/plug/mcp-server.js';

runPlugMcpServer().catch((err) => {
  console.error('Fatal MCP Server Error:', err);
  process.exit(1);
});
