#!/usr/bin/env node
import { runCli } from '../dist/plug/cli.js';

runCli().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
