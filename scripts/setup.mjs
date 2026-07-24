#!/usr/bin/env node
/**
 * UAI Agents — interactive setup wizard.
 *
 * Cross-platform (Windows 10/11, Linux, macOS). Zero dependencies — pure Node.
 * Run with:  pnpm setup   (or)   node scripts/setup.mjs
 *
 * What it does:
 *   1. Checks prerequisites (Node ≥ 20, pnpm, Docker + Compose).
 *   2. Asks which LLM provider you use and collects the matching key.
 *   3. Generates a random UAI_API_KEY (server auth).
 *   4. Writes a ready-to-run .env (never overwrites without asking).
 *   5. Optionally installs deps + brings up infra + migrates + starts.
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const ENV_EXAMPLE = join(ROOT, '.env.example');
const IS_WIN = process.platform === 'win32';

// --- tiny ANSI helpers (skip colors if not a TTY / NO_COLOR set) ------------
const useColor = output.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const cyan = (s) => c('36', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const dim = (s) => c('2', s);

const rl = createInterface({ input, output });
const ask = (q, def = '') =>
  rl.question(`${q}${def ? dim(` (${def})`) : ''} `).then((a) => a.trim() || def);
const askYesNo = async (q, def = true) => {
  const hint = def ? 'Y/n' : 'y/N';
  const a = (await rl.question(`${q} ${dim(`[${hint}]`)} `)).trim().toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes' || a === 'e' || a === 'evet';
};

/** Run a command, return {ok, out}. Never throws. Cross-platform via shell. */
function run(cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: capture ? 'pipe' : 'inherit',
    shell: IS_WIN, // Windows needs shell to resolve pnpm/docker .cmd shims
    encoding: 'utf8',
  });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}
const has = (cmd, args = ['--version']) => run(cmd, args, { capture: true }).ok;

// --- provider catalog (mirrors apps/runtime/src/llm/config.ts) --------------
const PROVIDERS = {
  1: { id: 'openrouter', label: 'OpenRouter', keyEnv: 'OPENROUTER_API_KEY',
       hint: 'https://openrouter.ai/keys', keyed: true },
  2: { id: 'openai', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY',
       hint: 'https://platform.openai.com/api-keys', keyed: true },
  3: { id: 'gemini', label: 'Google Gemini', keyEnv: 'GEMINI_API_KEY',
       hint: 'https://aistudio.google.com/apikey', keyed: true },
  4: { id: 'ollama', label: 'Ollama (local, free, no key)', keyEnv: null,
       hint: 'http://localhost:11434 — must be running', keyed: false },
  5: { id: 'custom', label: 'Custom OpenAI-compatible (LM Studio / Groq / vLLM …)',
       keyEnv: 'LLM_API_KEY', hint: 'you provide the base URL', keyed: true, custom: true },
};

async function main() {
  console.log('');
  console.log(bold(cyan('  UAI Agents — Setup Wizard')));
  console.log(dim('  6-agent orchestration · BYOK · self-hostable'));
  console.log('');

  // 1) prerequisites -------------------------------------------------------
  console.log(bold('1) Checking prerequisites'));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeOk = nodeMajor >= 20;
  console.log(`   ${nodeOk ? green('✓') : red('✗')} Node ${process.versions.node}` +
    (nodeOk ? '' : red('  — need ≥ 20')));

  const pnpmOk = has('pnpm');
  console.log(`   ${pnpmOk ? green('✓') : yellow('!')} pnpm` +
    (pnpmOk ? '' : yellow('  — install: npm i -g pnpm')));

  const dockerOk = has('docker');
  const composeOk = dockerOk && run('docker', ['compose', 'version'], { capture: true }).ok;
  console.log(`   ${dockerOk ? green('✓') : yellow('!')} Docker` +
    (dockerOk ? '' : yellow('  — install Docker Desktop (Win/mac) or docker engine (Linux)')));
  console.log(`   ${composeOk ? green('✓') : yellow('!')} Docker Compose v2` +
    (composeOk ? '' : yellow('  — comes with Docker Desktop; on Linux: docker-compose-plugin')));

  if (!nodeOk) {
    console.log(red('\n  Node ≥ 20 is required. Aborting.'));
    rl.close();
    process.exit(1);
  }
  console.log('');

  // 2) .env guard ----------------------------------------------------------
  if (existsSync(ENV_PATH)) {
    const overwrite = await askYesNo(
      yellow('   .env already exists.') + ' Overwrite it?', false);
    if (!overwrite) {
      console.log(dim('   Keeping existing .env — skipping to install/start steps.'));
      await installAndStart({ pnpmOk, composeOk });
      return;
    }
  }

  // 3) provider ------------------------------------------------------------
  console.log(bold('2) Choose your LLM provider'));
  for (const [n, p] of Object.entries(PROVIDERS)) {
    console.log(`   ${cyan(n)}) ${p.label} ${dim('— ' + p.hint)}`);
  }
  let choice = await ask('   Provider number:', '1');
  if (!PROVIDERS[choice]) choice = '1';
  const provider = PROVIDERS[choice];
  console.log(green(`   → ${provider.label}`));
  console.log('');

  // 4) key + custom base url ----------------------------------------------
  const env = {
    LLM_PROVIDER: provider.id,
    DATABASE_URL: 'postgres://uai:uai_dev_2026@localhost:5434/uai',
    REDIS_URL: 'redis://localhost:6380',
    UAI_API_KEY: randomBytes(24).toString('hex'),
    LOG_LEVEL: 'info',
    PORT: '3000',
  };

  if (provider.custom) {
    console.log(bold('3) Custom endpoint details'));
    env.LLM_BASE_URL = await ask('   Base URL:', 'http://localhost:1234/v1');
  }

  if (provider.keyed) {
    console.log(bold(provider.custom ? '   API key' : '3) API key'));
    console.log(dim(`   Get one at: ${provider.hint}`));
    let key = '';
    while (!key) {
      key = await ask(`   ${provider.keyEnv}:`);
      if (!key) {
        const skip = await askYesNo(
          yellow('   No key entered.') + ' Continue anyway (fill it in .env later)?', false);
        if (skip) break;
      }
    }
    if (key) env[provider.keyEnv] = key;
  } else {
    console.log(dim('   Ollama needs no key — make sure `ollama serve` is running.'));
  }
  console.log('');

  // 5) write .env ----------------------------------------------------------
  writeEnv(env);
  console.log(green(`   ✓ Wrote .env`) + dim(`  (UAI_API_KEY auto-generated)`));
  console.log('');

  // 6) install + start -----------------------------------------------------
  await installAndStart({ pnpmOk, composeOk });
}

function writeEnv(env) {
  const lines = [
    '# Generated by `pnpm setup` — safe to edit by hand.',
    '# Never commit this file. Only .env.example is shared.',
    '',
    '# --- LLM (BYOK) ---',
    `LLM_PROVIDER=${env.LLM_PROVIDER}`,
  ];
  for (const k of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL']) {
    if (env[k]) lines.push(`${k}=${env[k]}`);
  }
  lines.push(
    '',
    '# --- Infrastructure (match docker-compose.yml host ports) ---',
    `DATABASE_URL=${env.DATABASE_URL}`,
    `REDIS_URL=${env.REDIS_URL}`,
    '',
    '# --- Server ---',
    `UAI_API_KEY=${env.UAI_API_KEY}`,
    `PORT=${env.PORT}`,
    `LOG_LEVEL=${env.LOG_LEVEL}`,
    '',
  );
  writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
}

async function installAndStart({ pnpmOk, composeOk }) {
  console.log(bold('4) Install & launch'));

  if (pnpmOk && await askYesNo('   Run `pnpm install` now?', true)) {
    const r = run('pnpm', ['install']);
    if (!r.ok) console.log(yellow('   pnpm install returned an error — check output above.'));
  }

  if (composeOk && await askYesNo('   Start infra (Postgres + Redis) & run migrations now?', true)) {
    console.log(dim('   docker compose up postgres redis -d --wait …'));
    const up = run('docker', ['compose', 'up', 'postgres', 'redis', '-d', '--wait']);
    if (up.ok) {
      run('pnpm', ['db:migrate']);
    } else {
      console.log(yellow('   Could not start containers — is Docker running?'));
    }
  }

  console.log('');
  console.log(green(bold('  Done.')) + ' Next:');
  console.log('    ' + cyan('pnpm dev') + dim('     # start runtime + dashboard (watch mode)'));
  console.log('    ' + cyan('pnpm start') + dim('   # one shot: infra → migrate → dev'));
  console.log(dim('    Health check: curl http://localhost:3000/health'));
  console.log('');
  rl.close();
}

// ensure a .env.example exists to reference; not fatal if missing
if (!existsSync(ENV_EXAMPLE) && existsSync(ENV_PATH)) {
  try { copyFileSync(ENV_PATH, ENV_EXAMPLE); } catch { /* ignore */ }
}

main().catch((err) => {
  console.error(red('\n  Setup failed:'), err?.message || err);
  rl.close();
  process.exit(1);
});
