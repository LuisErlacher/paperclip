# Build notes — SIMAA-2206

## Resumo

Fix cirúrgico em `server/src/services/issue-execution-policy.ts`: removida 1 linha (`exclude: existingState?.returnAssignee ?? null`) da chamada de `selectStageParticipant` dentro do branch de transição positiva (`approved`, linha ~719). A garantia anti-auto-aprovação é mantida por `principalsEqual(currentParticipant, actor)` (linha 693) — o `exclude` no path positivo bloqueava transições legítimas quando o `returnAssignee` era o único participant do próximo stage. Dois novos testes foram adicionados ao arquivo de testes existente.

## Arquivos tocados

- `server/src/services/issue-execution-policy.ts` — 1 linha removida (o `exclude: existingState?.returnAssignee ?? null` da chamada de `selectStageParticipant` no branch `approved`)
- `server/src/__tests__/issue-execution-policy.test.ts` — 2 novos testes adicionados no describe `returnAssignee como único participant no path approved (SIMAA-2206)`

## Checks locais

- `vitest run server/src/__tests__/issue-execution-policy.test.ts` → PASS (52/52 testes)
- `vitest run --project @paperclipai/server` → `issue-execution-policy.test.ts` (52) PASS, `issue-execution-policy-routes.test.ts` (10) PASS; 35 falhos em arquivos de plugin/HMR são **pre-existentes** no worktree (falta build do `@paperclipai/plugin-sdk`; mesmos testes passam no main)
- `pnpm --filter @paperclipai/server build` → PASS (após `pnpm --filter @paperclipai/plugin-sdk build` para preparar o worktree)
- `pnpm --filter @paperclipai/server typecheck` → PASS (sem erros em `issue-execution-policy.ts`)
- Inspeção visual do diff: 1 linha removida em `issue-execution-policy.ts`, 77 linhas adicionadas nos testes

## Divergências do contrato

Nenhuma. O fix seguiu exatamente o "Fora do escopo" — as outras 4 chamadas a `selectStageParticipant` (linhas 656, 664, 816, 841) não foram tocadas.

## PR

https://github.com/paperclipai/paperclip/pull/5951

Branch limpa: `fix/SIMAA-2206-selectStageParticipant-approved` (cherry-pick do commit `e2e7602f` sobre `origin/master`)
