#!/usr/bin/env node
// PreToolUse hook for the project subagents in .claude/agents/.
//
//   node subagent-bash-guard.mjs read-only   # code-reviewer
//   node subagent-bash-guard.mjs guard       # verifier, debugger
//
// read-only: allowlist. A Bash command passes only if every part of it is a
//   known read-only command (git diff/log/show/status..., grep, cat, ls, ...).
//   Anything the parser can't prove safe is denied: command substitution,
//   subshells, variable expansion, unquoted globs, output redirection to a file.
//
// guard: denylist backstop. Denies commits, pushes, history rewrites, branch
//   switches, and the deploy/release/packaging/e2e/soak/perf scripts the
//   subagent prompts already forbid. Everything else goes through the normal
//   permission flow.
//
// The hook never approves anything: a command that passes exits 0 with no
// output, so the session's permission rules still apply. A crash exits non-zero,
// which the frontmatter's `onFailure: block` turns into a denial.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

class Unparseable extends Error {}

// ---------------------------------------------------------------------------
// Shell tokenizer: splits a command into simple-command segments on ; & && | ||
// and newlines, tracking redirections. Throws Unparseable for constructs whose
// effect can't be determined statically.
// ---------------------------------------------------------------------------
export function tokenize(src) {
  const segments = [];
  let seg = newSegment();
  let word = null;
  let pendingRedirect = null;

  function newSegment() {
    return { words: [], redirects: [], expansion: false, glob: false };
  }
  function pushWord() {
    if (word === null) return;
    if (pendingRedirect) {
      seg.redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else {
      seg.words.push(word);
    }
    word = null;
  }
  function endSegment() {
    pushWord();
    if (pendingRedirect) throw new Unparseable(`redirection ${pendingRedirect} has no target`);
    if (seg.words.length || seg.redirects.length) segments.push(seg);
    seg = newSegment();
  }
  const isNameStart = (ch) => ch !== undefined && /[A-Za-z0-9_{@*#?$!-]/.test(ch);

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];

    if (c === ' ' || c === '\t') { pushWord(); continue; }
    if (c === '\n' || c === ';') { endSegment(); continue; }

    if (c === '&' && next === '>') {
      pushWord();
      i++;
      pendingRedirect = '&>';
      if (src[i + 1] === '>') { i++; pendingRedirect = '&>>'; }
      continue;
    }
    if (c === '&') { if (next === '&') i++; endSegment(); continue; }
    if (c === '|') { if (next === '|' || next === '&') i++; endSegment(); continue; }

    if (c === '>' || c === '<') {
      let fd = '';
      if (word !== null && /^\d+$/.test(word)) { fd = word; word = null; } else pushWord();
      if (next === '(') throw new Unparseable('process substitution');
      let op = c;
      if (c === '>') {
        if (next === '>' || next === '|' || next === '&') { op += next; i++; }
      } else if (next === '<') {
        throw new Unparseable('here-documents and here-strings');
      } else if (next === '&' || next === '>') {
        op += next; i++;
      }
      pendingRedirect = fd + op;
      continue;
    }

    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Unparseable('unterminated single quote');
      word = (word ?? '') + src.slice(i + 1, j);
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = '';
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && j + 1 < src.length) { buf += src[j + 1]; j++; continue; }
        if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '(')) throw new Unparseable('command substitution');
        if (src[j] === '$' && isNameStart(src[j + 1])) seg.expansion = true;
        buf += src[j];
      }
      if (j >= src.length) throw new Unparseable('unterminated double quote');
      word = (word ?? '') + buf;
      i = j;
      continue;
    }
    if (c === '\\') {
      if (next === '\n') { i++; continue; }
      if (next !== undefined) { word = (word ?? '') + next; i++; }
      continue;
    }
    if (c === '`') throw new Unparseable('command substitution');
    if (c === '$' && next === '(') throw new Unparseable('command substitution');
    if (c === '(' || c === ')') throw new Unparseable('subshells and grouping');
    if (c === '$' && isNameStart(next)) seg.expansion = true;
    if (c === '*' || c === '?' || c === '[') seg.glob = true;
    word = (word ?? '') + c;
  }
  endSegment();
  return segments;
}

const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
const flagName = (a) => a.split('=')[0];

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

// Returns { sub, args } or throws a string reason.
function parseGit(words) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    const opt = words[i];
    if (opt === '-C') { i += 2; continue; }
    if (['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs'].includes(opt)) { i++; continue; }
    throw `git global option ${flagName(opt)} is not allowed`;
  }
  return { sub: words[i], args: words.slice(i + 1) };
}

const GIT_READ = new Set([
  'diff', 'log', 'show', 'status', 'blame', 'annotate', 'ls-files', 'ls-tree', 'rev-parse',
  'rev-list', 'merge-base', 'cat-file', 'shortlog', 'describe', 'name-rev', 'grep',
  'for-each-ref', 'show-ref', 'diff-tree', 'diff-index', 'diff-files', 'whatchanged',
  'count-objects', 'check-ignore', 'check-attr', 'range-diff',
]);

// Flags that put `git branch` / `git tag` in list mode.
const BRANCH_LIST = ['--list', '-l', '-a', '--all', '-r', '--remotes', '--contains', '--no-contains',
  '--merged', '--no-merged', '--points-at', '--show-current'];
const BRANCH_FLAGS = [...BRANCH_LIST, '-v', '-vv', '--verbose', '--sort', '--format', '--color', '--no-color',
  '--column', '--no-column', '--omit-empty', '-i', '--ignore-case'];
const TAG_LIST = ['-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '-n'];
const TAG_FLAGS = [...TAG_LIST, '--sort', '--format', '--color', '--no-color', '--column', '--no-column', '-i', '--ignore-case'];

function listModeOnly(args, listFlags, allowedFlags) {
  let listMode = false;
  let positional = false;
  for (const a of args) {
    if (a.startsWith('-')) {
      const name = /^-n\d*$/.test(a) ? '-n' : flagName(a);
      if (!allowedFlags.includes(name)) return false;
      if (listFlags.includes(name)) listMode = true;
    } else {
      positional = true;
    }
  }
  return listMode || !positional;
}

function gitIsReadOnly(sub, args) {
  switch (sub) {
    case undefined: return false;
    case 'branch': return listModeOnly(args, BRANCH_LIST, BRANCH_FLAGS);
    case 'tag': return listModeOnly(args, TAG_LIST, TAG_FLAGS);
    case 'remote': return args.length === 0 || ['-v', '--verbose', 'get-url', 'show'].includes(args[0]);
    case 'stash': return ['list', 'show'].includes(args[0]);
    case 'worktree': return args[0] === 'list';
    case 'reflog': return args.length === 0 || args[0] === 'show' || args[0].startsWith('-');
    case 'config': return args.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a));
    default: return GIT_READ.has(sub);
  }
}

function gitReadOnlyReason(words) {
  let parsed;
  try {
    parsed = parseGit(words);
  } catch (reason) {
    if (typeof reason === 'string') return reason;
    throw reason;
  }
  const { sub, args } = parsed;
  if (!gitIsReadOnly(sub, args)) return `git ${sub ?? ''} is not a read-only git command`.replace('  ', ' ');
  if (args.some((a) => a.startsWith('--output'))) return 'git --output writes a file';
  if (args.some((a) => a === '--ext-diff')) return 'git --ext-diff runs an external program';
  if (sub === 'grep' && args.some((a) => a.startsWith('-O') || a.startsWith('--open-files-in-pager'))) {
    return 'git grep -O runs a pager program';
  }
  return null;
}

const GIT_MUTATING = new Set(['push', 'commit', 'rebase', 'merge', 'pull', 'cherry-pick', 'revert', 'am',
  'checkout', 'switch', 'restore', 'clean', 'filter-branch', 'filter-repo', 'update-ref', 'gc', 'prune',
  'replace', 'notes', 'submodule', 'init', 'clone']);
const GIT_CONDITIONAL = new Set(['branch', 'tag', 'remote', 'stash', 'worktree', 'reflog', 'config']);

function gitGuardReason(words) {
  let parsed;
  try {
    parsed = parseGit(words);
  } catch {
    // Unknown global options (-c, --git-dir, ...): fall back to scanning the words.
    const sub = words.slice(1).find((w) => GIT_MUTATING.has(w));
    return sub ? `git ${sub} is reserved for the main conversation` : null;
  }
  const { sub, args } = parsed;
  if (GIT_MUTATING.has(sub)) return `git ${sub} is reserved for the main conversation`;
  if (sub === 'reset' && args.some((a) => ['--hard', '--merge', '--keep'].includes(a))) {
    return 'git reset --hard/--merge/--keep discards work';
  }
  if (GIT_CONDITIONAL.has(sub) && !gitIsReadOnly(sub, args)) {
    return `git ${sub} ${args.join(' ')} changes repository state`.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// read-only mode
// ---------------------------------------------------------------------------
const PLAIN_READ = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'diff', 'cmp',
  'comm', 'cut', 'tr', 'nl', 'stat', 'du', 'pwd', 'echo', 'basename', 'dirname', 'realpath', 'readlink',
  'which', 'true', 'cd', 'jq', 'date']);

function commandReadOnlyReason(words) {
  const [cmd, ...args] = words;
  if (isAssignment(cmd)) return 'environment variable assignments are not allowed';
  if (cmd.includes('/')) return `${cmd}: run commands by name, not by path`;
  if (PLAIN_READ.has(cmd)) return null;
  switch (cmd) {
    case 'git':
      return gitReadOnlyReason(words);
    case 'rg':
      return args.some((a) => a.startsWith('--pre')) ? 'rg --pre runs a program' : null;
    case 'find': {
      const bad = args.find((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a));
      return bad ? `find ${bad} can change files or run programs` : null;
    }
    case 'sort': {
      const bad = args.find((a) => a === '-o' || /^-o./.test(a) || a.startsWith('--output') || a.startsWith('--compress-program'));
      return bad ? `sort ${flagName(bad)} writes a file or runs a program` : null;
    }
    case 'uniq':
      // uniq [INPUT [OUTPUT]] writes OUTPUT, so only allow it as a filter.
      return args.every((a) => a.startsWith('-') || /^\d+$/.test(a)) ? null : 'uniq with file arguments can write a file';
    case 'sed': {
      if (!args.includes('-n') || args.some((a) => a === '-i' || a.startsWith('-i') || a.startsWith('--in-place'))) {
        return "only `sed -n '<start>,<end>p' FILE` is allowed";
      }
      const scripts = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-e') scripts.push(args[++i] ?? '');
        else if (!args[i].startsWith('-') && scripts.length === 0) scripts.push(args[i]);
      }
      const ok = scripts.length > 0 && scripts.every((s) => /^((\d+|\$)(,(\d+|\$))?p;?)+$/.test(s));
      return ok ? null : "only `sed -n '<start>,<end>p' FILE` is allowed";
    }
    default:
      return `${cmd} is not on the read-only allowlist`;
  }
}

function readOnlyReason(command) {
  let segments;
  try {
    segments = tokenize(command);
  } catch (e) {
    if (e instanceof Unparseable) return `${e.message} can't be checked for side effects`;
    throw e;
  }
  for (const seg of segments) {
    if (seg.expansion) return 'variable expansion is not allowed; write values out literally';
    if (seg.glob) return 'unquoted glob patterns are not allowed; use the Glob or Grep tool to find files';
    for (const r of seg.redirects) {
      const output = r.op.includes('>');
      if (!output) continue;
      if (r.op.endsWith('&') && /^(\d+|-)$/.test(r.target)) continue; // fd duplication, e.g. 2>&1
      if (r.target !== '/dev/null') return `output redirection to ${r.target} writes a file`;
    }
    if (seg.words.length === 0) continue;
    const reason = commandReadOnlyReason(seg.words);
    if (reason) return reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// guard mode
// ---------------------------------------------------------------------------
const BLOCKED_SCRIPT = /^(deploy(:.*)?|release|publish|pack|dist|clean|perf(:.*)?|test:soak(:.*)?|test:memory-gate(:.*)?|test:electron|test:.*e2e.*)$/;
const PKG_RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const PKG_EXECUTORS = new Set(['npx', 'pnpx', 'bunx']);
const PKG_VALUE_OPTS = new Set(['--filter', '-F', '--filter-prod', '-C', '--dir', '--prefix', '--workspace', '--test-pattern']);
const BLOCKED_PROGRAMS = new Set(['playwright', 'electron-builder', 'wrangler']);
const BLOCKED_FILES = /(^|\/)(soak\.mjs|e2e-prod\.mjs|perf-harness\.mjs|perf-budget\.mjs|upload-vidstab-r2\.sh|start-issue\.sh|run-android-checklist\.sh)$|electron\.test\.ts$/;
const BLOCKED_ENV = /^OPENREEL_(DESKTOP_[A-Z_]*(E2E|SOAK)[A-Z_]*|ELECTRON_TEST)=/;

function programReason(words) {
  const prog = words[0].split('/').pop();
  if (BLOCKED_PROGRAMS.has(prog)) {
    if (prog !== 'wrangler') return `${prog} is reserved for CI and release work`;
    if (words.some((w) => ['deploy', 'publish', 'secret', 'delete', 'rollback'].includes(w))) {
      return `wrangler ${words.slice(1).join(' ')} touches deployed infrastructure`;
    }
  }
  return null;
}

function packageReason(words) {
  const [runner, ...rest] = words;
  if (PKG_EXECUTORS.has(runner)) return rest.length ? programReason(rest) : null;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('-')) {
      if (PKG_VALUE_OPTS.has(a) || (runner === 'npm' && a === '-w')) i++;
      continue;
    }
    positional.push(a);
  }
  const [first, ...more] = positional;
  if (first === undefined) return null;
  if (['exec', 'dlx', 'x'].includes(first)) return more.length ? programReason(more) : null;
  const script = ['run', 'run-script'].includes(first) ? more[0] : first;
  if (script && BLOCKED_SCRIPT.test(script)) {
    return `\`${script}\` is a deploy, release, packaging, e2e, soak, perf or clean script; leave it to the main conversation or CI`;
  }
  return null;
}

function segmentGuardReason(words) {
  const env = [];
  let i = 0;
  while (i < words.length && isAssignment(words[i])) env.push(words[i++]);
  if (env.some((w) => BLOCKED_ENV.test(w))) return 'desktop e2e, soak and electron suites are reserved for CI';
  const cmd = words.slice(i);
  if (cmd.length === 0) return null;
  if (cmd.some((w) => BLOCKED_FILES.test(w))) return 'that script is reserved for CI, release or manual runs';
  const prog = cmd[0].split('/').pop();
  if (prog === 'git') return gitGuardReason(cmd);
  if (PKG_RUNNERS.has(prog) || PKG_EXECUTORS.has(prog)) return packageReason([prog, ...cmd.slice(1)]);
  return programReason(cmd);
}

// Used only when the tokenizer can't parse the command.
const RAW_PATTERNS = [
  [/\bgit\b[^\n;&|]*?\s(push|commit|rebase|merge|pull|cherry-pick|checkout|switch|restore|clean|filter-branch|update-ref)\b/, 'git command that changes history or the working tree'],
  [/\bgit\b[^\n;&|]*?\sreset\s[^\n;&|]*--(hard|merge|keep)\b/, 'git reset that discards work'],
  [/\b(pnpm|npm|yarn|bun)\b[^\n;&|]*\s(deploy|release|publish|pack|dist|clean|perf\S*|test:\S*e2e\S*|test:soak\S*|test:memory-gate\S*|test:electron)(\s|$)/, 'deploy, release, packaging, e2e, soak, perf or clean script'],
  [/\b(playwright|electron-builder)\b|\bwrangler\b[^\n;&|]*\s(deploy|publish|secret)\b/, 'CI or release tool'],
  [/(soak|e2e-prod|perf-harness|perf-budget)\.mjs|upload-vidstab-r2\.sh|start-issue\.sh|electron\.test\.ts|OPENREEL_(DESKTOP_\w*(E2E|SOAK)|ELECTRON_TEST)/, 'script reserved for CI or manual runs'],
];

function guardReason(command) {
  let segments;
  try {
    segments = tokenize(command);
  } catch (e) {
    if (!(e instanceof Unparseable)) throw e;
    for (const [re, what] of RAW_PATTERNS) if (re.test(command)) return `command looks like a ${what}`;
    return null;
  }
  for (const seg of segments) {
    if (seg.words.length === 0) continue;
    const reason = segmentGuardReason(seg.words);
    if (reason) return reason;
  }
  return null;
}

// Returns a denial reason, or null when the command may proceed.
export function evaluate(mode, command) {
  if (mode === 'read-only') {
    const reason = readOnlyReason(command);
    return reason && `Read-only subagent: ${reason}. Use Read, Grep, Glob, or a plain read-only command instead.`;
  }
  if (mode === 'guard') {
    const reason = guardReason(command);
    return reason && `Blocked by the subagent guard: ${reason}.`;
  }
  throw new Error(`unknown mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode !== 'read-only' && mode !== 'guard') throw new Error(`unknown mode: ${mode}`);
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const command = input?.tool_input?.command;
  const reason = typeof command === 'string' ? evaluate(mode, command) : null;
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  }
}
