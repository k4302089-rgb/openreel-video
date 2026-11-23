// Run with: node --test .claude/hooks/subagent-bash-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate } from './subagent-bash-guard.mjs';

const allowed = (mode, cmd) => assert.equal(evaluate(mode, cmd), null, `expected allow: ${cmd}`);
const denied = (mode, cmd) => assert.notEqual(evaluate(mode, cmd), null, `expected deny: ${cmd}`);

test('read-only allows review commands', () => {
  for (const cmd of [
    'git diff HEAD',
    'git diff --cached --stat',
    'git --no-pager log --oneline -n 20 origin/main..HEAD',
    'git -C packages/core show HEAD~1:src/index.ts',
    'git status --porcelain',
    'git branch --show-current',
    'git branch -a --contains HEAD',
    'git stash list',
    'git diff origin/main...HEAD -- apps/web | head -200',
    'grep -rn "VideoFrame" packages/core/src 2>/dev/null',
    "grep -rn 'close()' apps/web/src | wc -l",
    'git log -p -n 3 -- src/a.ts 2>&1 | tail -50',
    "sed -n '10,80p' packages/core/src/index.ts",
    'ls -la apps && cat package.json',
    "find packages -name '*.test.ts' -newer package.json",
    'rg --type ts "useStore" apps/web/src | sort | uniq -c',
  ]) allowed('read-only', cmd);
});

test('read-only denies writes and execution', () => {
  for (const cmd of [
    'rm -rf node_modules',
    'git commit -m x',
    'git push origin HEAD',
    'git checkout -- src/a.ts',
    'git branch new-feature',
    'git branch -D main',
    'git tag v1',
    'git stash',
    'git config user.name x',
    'git -c core.pager=sh diff',
    'git diff --output=/tmp/x',
    'git grep -Ovim foo',
    'echo hi > file.txt',
    'cat a >> b',
    'git diff 2>err.log',
    'git log &>out.txt',
    'tee out.txt < in.txt',
    'find . -name x -delete',
    'find . -exec rm {} ;',
    "sed -i 's/a/b/' f",
    "sed -n 's/a/b/w out' f",
    'sort -o out in',
    'uniq in out',
    'rg --pre ./evil foo',
    'echo $(rm -rf /)',
    'echo `touch x`',
    'echo "$(touch x)"',
    '(rm x)',
    'X=-delete; find . $X',
    'find .${IFS}-delete',
    'find * ',
    'GIT_EXTERNAL_DIFF=./evil git diff',
    './node_modules/.bin/eslint --fix .',
    '/bin/rm x',
    'pnpm install',
    'node -e "require(\'fs\').writeFileSync(\'x\',\'\')"',
    'xargs rm < list',
    'cat <<EOF > f\nhi\nEOF',
    'diff <(ls) <(ls)',
    'git diff; touch x',
    'git diff && npm test',
  ]) denied('read-only', cmd);
});

test('guard allows verification and debugging commands', () => {
  for (const cmd of [
    'pnpm install --frozen-lockfile',
    'pnpm --filter @openreel/core typecheck',
    'pnpm --filter @openreel/web lint && pnpm --filter @openreel/web test:run',
    'pnpm --filter @openreel/core exec vitest run src/audio/mixer.test.ts -t "gain"',
    'pnpm build:wasm',
    'pnpm test',
    'git diff --name-only HEAD',
    'git status --porcelain',
    'git log -p -n 5 -- packages/core/src/video',
    'git stash list',
    'git branch --show-current',
    'git reset HEAD src/a.ts',
    'npx vitest run',
    'ls dist && rm -f /tmp/debug.log',
    'echo "$(git rev-parse HEAD)"',
  ]) allowed('guard', cmd);
});

test('guard denies commits, history changes and forbidden scripts', () => {
  for (const cmd of [
    'git commit -am fix',
    'git -C apps/web push',
    'git push --force',
    'git reset --hard HEAD~1',
    'git checkout main',
    'git switch -c x',
    'git restore src/a.ts',
    'git clean -fdx',
    'git rebase -i main',
    'git stash',
    'git stash pop',
    'git branch -D old',
    'git -c user.name=x commit -m y',
    'pnpm deploy',
    'pnpm --filter @openreel/web deploy:preview',
    'pnpm run release',
    'pnpm --filter @openreel/desktop dist',
    'pnpm --filter @openreel/desktop pack',
    'pnpm --filter @openreel/web test:e2e',
    'pnpm --filter @openreel/desktop test:desktop-e2e',
    'pnpm --filter @openreel/web test:memory-gate:long',
    'pnpm --filter @openreel/web perf:gate',
    'pnpm --filter @openreel/desktop test:electron',
    'pnpm clean',
    'npm publish',
    'npx playwright test',
    'pnpm --filter @openreel/web exec playwright test',
    'wrangler pages deploy dist --project-name=openreel',
    'OPENREEL_DESKTOP_E2E=1 vitest run test/ingest-electron.test.ts',
    'node apps/web/scripts/soak.mjs',
    'bash scripts/upload-vidstab-r2.sh',
    './scripts/start-issue.sh 42',
    'echo $(date) && git commit -m x',
    'echo `pwd`; pnpm deploy',
  ]) denied('guard', cmd);
});

test('hook speaks the PreToolUse JSON protocol', () => {
  const script = fileURLToPath(new URL('./subagent-bash-guard.mjs', import.meta.url));
  const run = (mode, command) =>
    execFileSync('node', [script, mode], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }) }).toString();

  assert.equal(run('read-only', 'git diff'), '');
  const out = JSON.parse(run('read-only', 'rm -rf /'));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /rm is not on the read-only allowlist/);
  assert.equal(JSON.parse(run('guard', 'git push')).hookSpecificOutput.permissionDecision, 'deny');

  assert.throws(() => execFileSync('node', [script, 'bogus'], { input: '{}', stdio: 'pipe' }));
});
