import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { logger } from '../logger.js';
import type { ToolDefinition } from './types.js';

const execAsync = promisify(exec);

const MAX_FILE_SIZE = 32 * 1024; // 32 KB read cap
const BASH_TIMEOUT_MS = 15_000;

/** Dangerous shell patterns — block before execution */
const BASH_BLACKLIST = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*r[a-zA-Z]*)\s/i,
  /rm\s+.*--force/i,
  /:\s*\(\s*\)\s*\{.*\|\s*:/,     // fork bomb
  />\s*\/dev\/(s?d[a-z]|nvme)/i,  // disk writes
  /mkfs\b/i,
  /dd\s+.*of=/i,
  /chmod\s+777\s+\//i,
  /chown\s+.*\s+\//i,
  /sudo\b/i,
  /curl\s+.*\|\s*(bash|sh)\b/i,
  /wget\s+.*-O\s*-.*\|\s*(bash|sh)\b/i,
];

function isSafeCommand(cmd: string): boolean {
  return !BASH_BLACKLIST.some((re) => re.test(cmd));
}

// ── Input schemas ────────────────────────────────────────────────────────────

const ReadFileSchema = z.object({
  path: z.string().min(1).max(4096),
});

const WriteFileSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(1024 * 1024), // 1 MB cap
});

const RunBashSchema = z.object({
  command: z.string().min(1).max(8192),
});

const SearchWebSchema = z.object({
  query: z.string().min(1).max(500),
});

function formatOutput(out: string, maxLen = 8192): string {
  return out.length > maxLen ? out.slice(0, maxLen) + `\n... [truncated — ${out.length} chars total]` : out;
}

// ── Tool Definitions ────────────────────────────────────────────────────────

export const readFileTool: ToolDefinition = {
  name: 'readFile',
  description: 'Read a file from the local filesystem and return its contents.',
  args: {
    path: { type: 'string', description: 'Absolute or relative file path', required: true },
  },
  async execute(raw) {
    const parsed = ReadFileSchema.safeParse(raw);
    if (!parsed.success) return `Error: invalid arguments — ${parsed.error.issues[0]?.message}`;
    const { path } = parsed.data;
    logger.debug({ path }, 'tool:readFile');
    const stat = await fs.stat(path).catch(() => null);
    if (!stat) return `Error: file not found — ${path}`;
    if (stat.size > MAX_FILE_SIZE) {
      // Read first 32 KB only
      const fd = await fs.open(path, 'r');
      const buf = Buffer.alloc(MAX_FILE_SIZE);
      await fd.read(buf, 0, MAX_FILE_SIZE, 0);
      await fd.close();
      return buf.toString('utf-8') + `\n... [truncated — file is ${stat.size} bytes]`;
    }
    return fs.readFile(path, 'utf-8');
  },
};

export const writeFileTool: ToolDefinition = {
  name: 'writeFile',
  description: 'Write content to a file on the local filesystem. Creates directories if needed.',
  args: {
    path: { type: 'string', description: 'Absolute or relative file path', required: true },
    content: { type: 'string', description: 'Content to write', required: true },
  },
  async execute(raw) {
    const parsed = WriteFileSchema.safeParse(raw);
    if (!parsed.success) return `Error: invalid arguments — ${parsed.error.issues[0]?.message}`;
    const { path, content } = parsed.data;
    logger.debug({ path, size: content.length }, 'tool:writeFile');
    // Derive directory and create if missing
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    if (dir && dir !== '.') await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path, content, 'utf-8');
    return `Written ${content.length} bytes to ${path}`;
  },
};

export const runBashTool: ToolDefinition = {
  name: 'runBash',
  description:
    'Run a shell command and return stdout+stderr. Timeout: 15s. Avoid destructive commands — rm -rf, sudo, etc. are blocked.',
  args: {
    command: { type: 'string', description: 'Shell command to execute', required: true },
  },
  async execute(raw) {
    const parsed = RunBashSchema.safeParse(raw);
    if (!parsed.success) return `Error: invalid arguments — ${parsed.error.issues[0]?.message}`;
    const { command } = parsed.data;
    if (!isSafeCommand(command)) {
      return `Error: command blocked by safety filter — ${command}`;
    }
    logger.debug({ command }, 'tool:runBash');
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        shell: '/bin/bash',
      });
      const combined = [stdout, stderr].filter(Boolean).join('\n');
      return formatOutput(combined || '(no output)');
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
      return `Exit error:\n${formatOutput(combined)}`;
    }
  },
};

export const searchWebTool: ToolDefinition = {
  name: 'searchWeb',
  description:
    'Search the web using DuckDuckGo and return a summary of results. Best for quick factual lookups.',
  args: {
    query: { type: 'string', description: 'Search query', required: true },
  },
  async execute(raw) {
    const parsed = SearchWebSchema.safeParse(raw);
    if (!parsed.success) return `Error: invalid arguments — ${parsed.error.issues[0]?.message}`;
    const { query } = parsed.data;
    logger.debug({ query }, 'tool:searchWeb');
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'UAI-Agents/1.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return `Error: DuckDuckGo returned ${res.status}`;

      const data = await res.json() as {
        AbstractText?: string;
        AbstractSource?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
        Answer?: string;
        AnswerType?: string;
      };

      const parts: string[] = [];

      if (data.Answer) parts.push(`**Answer (${data.AnswerType}):** ${data.Answer}`);
      if (data.AbstractText) {
        parts.push(`**Summary (${data.AbstractSource}):** ${data.AbstractText}`);
        if (data.AbstractURL) parts.push(`Source: ${data.AbstractURL}`);
      }
      if (data.RelatedTopics?.length) {
        const topics = data.RelatedTopics
          .filter((t) => t.Text)
          .slice(0, 5)
          .map((t) => `- ${t.Text}${t.FirstURL ? ` (${t.FirstURL})` : ''}`);
        if (topics.length) parts.push(`**Related:**\n${topics.join('\n')}`);
      }

      return parts.length > 0
        ? parts.join('\n\n')
        : `No instant answer found for: "${query}". Try a more specific query.`;
    } catch (err) {
      return `Error searching for "${query}": ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ── Registry ────────────────────────────────────────────────────────────────

export const ALL_TOOLS: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  runBashTool,
  searchWebTool,
];

export const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function buildToolSchema(tools: ToolDefinition[]): string {
  return tools
    .map((t) => {
      const argLines = Object.entries(t.args)
        .map(([k, v]) => `    - ${k} (${v.type}${v.required ? ', required' : ''}): ${v.description}`)
        .join('\n');
      return `### ${t.name}\n${t.description}\nArgs:\n${argLines}`;
    })
    .join('\n\n');
}
