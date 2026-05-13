# Contrato — SIMAA-2206 fix: selectStageParticipant aceitar returnAssignee quando único participant

## Builder proposal (round 1)

### O que vou entregar

1. **Fix cirúrgico em `selectStageParticipant` call site de transição positiva**: remover o parâmetro `exclude: returnAssignee` da chamada de `selectStageParticipant` nas linhas 717-720 de `server/src/services/issue-execution-policy.ts`, dentro do branch de transição `approved`. A semântica correta: em transição positiva (`approved`) para um próximo stage, o `returnAssignee` é um participant legítimo; o `exclude` existe para evitar auto-aprovação, não para bloquear progressão normal do fluxo.

2. **Teste: cenário bloqueante** — stage `approval` aprovado por Verifier → próximo stage `review` cujo único participant é o `returnAssignee` (Builder) → transição avança com sucesso sem lançar 422.

3. **Teste: comportamento anti-auto-aprovação preservado** — mesmo agente não pode aprovar um stage e depois ser selecionado automaticamente para o próximo stage se configurado com `exclude` em outros contextos (i.e., nenhuma mudança nas chamadas de `selectStageParticipant` fora do path de transição `approved`).

### Como vou verificar

1. `cd /home/luis/projetos/paperclip/.claude/worktrees/harness-SIMAA-2206/server && pnpm vitest run src/__tests__/issue-execution-policy.test.ts` → todos os testes existentes passam + os dois novos testes passam.
2. `cd /home/luis/projetos/paperclip/.claude/worktrees/harness-SIMAA-2206/server && pnpm run typecheck` → sem erros de TypeScript.
3. Inspecionar visualmente o diff: a única mudança no arquivo `issue-execution-policy.ts` é a remoção do `exclude` na chamada de `selectStageParticipant` em linha ~719.

### Critérios de aceite

1. Sistema consegue transitar de stage approval (Verifier aprovado) para stage review (Builder único participant) sem erro 422 — **verificado pelo novo teste "cenário bloqueante" (check 1)**.
2. Comportamento anti-auto-aprovação preservado — **verificado pelo novo teste "anti-auto-aprovação" (check 1)**.
3. Testes automatizados existentes para os dois cenários passam — **verificado por check 1**.
4. `typecheck` passa — **verificado por check 2**.
5. PR aberto no Paperclip core com descrição linkando SIMAA-2206 e SIMAA-2205.

### Arquivos/módulos que pretendo tocar

- `server/src/services/issue-execution-policy.ts` — 1 linha removida (o `exclude: existingState?.returnAssignee ?? null` na chamada de `selectStageParticipant` dentro do branch `approved`, linha ~719).
- `server/src/__tests__/issue-execution-policy.test.ts` — adicionar 2 novos casos de teste.

### Decisão técnica adotada

**Opção 3 (recomendada pelo CTO)**: remover `exclude` apenas na chamada de `selectStageParticipant` dentro do branch `approved` (linha ~717-720). As outras chamadas a `selectStageParticipant` (linhas 656, 664, 816, 841) mantêm `exclude: returnAssignee` intacto, pois operam em contextos diferentes onde a semântica de exclusão é válida.

Justificativa técnica: o `exclude` no branch `approved` foi introduzido para prevenir que o `returnAssignee` fosse selecionado como próximo reviewer. No cenário SIMAA-2206, o `returnAssignee` (Builder) é o único participant configurado no Stage 1. Excluí-lo impossibilita qualquer transição. A garantia anti-auto-aprovação vem de `principalsEqual(currentParticipant, actor)` (linha 693) — apenas o currentParticipant pode avançar o stage — e não depende do `exclude` no path positivo.

### Fora do escopo deste contrato

- Refatorar `selectStageParticipant` ou qualquer outra função do subsistema.
- Alterar as outras 4 chamadas a `selectStageParticipant` (linhas 656, 664, 816, 841).
- Adicionar telemetria, métricas, logs novos.
- Mexer no simplafy-admin.
- Revogar o policy aplicado em SIMAA-2198.
- Criar contornos manuais issue-a-issue para a wave SIMAA-2180-2197.

---

## Verifier review (round 1)

### Aprovados

- **Decisão técnica (Opção 3)** — APROVADO. Justificativa sólida: anti-auto-aprovação vem de `principalsEqual(currentParticipant, actor)`, não do `exclude`. Confere com a recomendação do CTO em [SIMAA-2205](/SIMAA/issues/SIMAA-2205).
- **Fix cirúrgico de 1 linha** — APROVADO. Builder revisou os 5 call sites de `selectStageParticipant` (linhas 656, 664, 717-720, 816, 841) e isolou a mudança no path `approved`. Escopo mínimo.
- **Teste cenário bloqueante** — APROVADO. Traduz spec critério #1 em PASS/FAIL claro.
- **Teste anti-auto-aprovação preservado** — APROVADO. Cobre spec critério #2.
- **"Fora do escopo"** — APROVADO. Restrição explícita das outras 4 chamadas.

### Changes requested

1. **Spec critério #4 não está totalmente coberto.** Contract inclui apenas `pnpm vitest run` no arquivo isolado + `typecheck`. Faltam: (a) suite completa para garantir não-regressão; (b) build do server para pegar erros de bundle não cobertos por typecheck.

2. **Spec critério #6 ausente dos "Critérios de aceite".** O hand-off pós-merge (comment em [SIMAA-2205](/SIMAA/issues/SIMAA-2205) sinalizando que o motor foi corrigido e nomeando quem orquestra o redeploy) é critério do spec mas não aparece no contrato.

3. **Nit — identificação do runner.** Contract assume `pnpm vitest` mas o spec menciona "Builder consulta `server/package.json` para identificar runner". Confirmar runner real.

**Veredito: REJEITADO — round 1.** Builder revisa itens 1, 2 e 3 e reatribui ao Verifier com `[contract:revised]`.

---

## Builder revision 1

### (c) Runner confirmado — `server/package.json`

`server/package.json` **não tem script `test`**. O Paperclip core usa **Vitest** configurado na raiz via `vitest.config.ts` (projetos incluídos: `packages/shared`, `packages/db`, `packages/adapter-utils`, `server`, `ui`, `cli`, etc.). O runner para os testes do servidor é invocado **a partir do root da worktree**, não dentro de `server/`. Runner confirmado: **Vitest** (não bun:test).

### (a) "Como vou verificar" — versão revisada

Substituindo os checks 1 e 2 do round 1:

1. **Teste do arquivo modificado** (smoke rápido, a partir do root da worktree):
   `pnpm vitest run server/src/__tests__/issue-execution-policy.test.ts`
   → confirma que os 2 novos testes passam + nenhum teste existente no arquivo regrediu.

2. **Suite completa do server** (não-regressão, a partir do root da worktree):
   `pnpm vitest run --project server`
   → todos os testes do pacote `server` passam; garante que a remoção do `exclude` não quebrou nenhum outro teste que dependia do comportamento anterior.

3. **Build do server** (compilação, a partir do root da worktree):
   `pnpm --filter @paperclipai/server build`
   → `tsc && cp onboarding-assets` completa sem erro; captura erros de bundle/deps não detectados por `typecheck --noEmit`.

4. **Typecheck** (já estava no round 1, mantido):
   `pnpm --filter @paperclipai/server typecheck` → sem erros TypeScript.

5. Inspeção visual do diff: única mudança em `issue-execution-policy.ts` é a remoção do `exclude` na linha ~719.

### (b) Critérios de aceite — versão revisada (adicionando #6)

Critérios #1–#5 do round 1 permanecem inalterados. Adicionado:

6. **Hand-off pós-merge**: após o PR ser mergeado no Paperclip core, postar comment em [SIMAA-2205](/SIMAA/issues/SIMAA-2205) sinalizando:
   - PR merged (com link direto ao PR);
   - Motor corrigido; control plane precisa de redeploy para ativar o fix;
   - Board/CTO nomeado como responsável por orquestrar o redeploy da wave SIMAA-2180-2197.
   — **verificado pela existência do comment antes de marcar SIMAA-2206 como `done`**.

### Cobertura cruzada spec → contrato (revisada)

| Spec critério | Contract item | Status |
|---|---|---|
| #1 Transição approval→review sem 422 | Critério aceite #1 + teste cenário bloqueante | OK |
| #2 Anti-auto-aprovação preservado | Critério aceite #2 + teste anti-auto-aprovação | OK |
| #3 Testes automatizados existem | Critério aceite #3 | OK |
| #4 Build + suite completa passam | Checks 2+3 "Como vou verificar" (round 1 revisado) | **OK** |
| #5 PR aberto linkando 2206/2205 | Critério aceite #5 | OK |
| #6 Comment pós-merge em SIMAA-2205 | Critério aceite #6 (adicionado) | **OK** |

---

## Verifier review (round 2)

### Aprovados

- **(c) Runner confirmado** — APROVADO. Verificado: `server/package.json` realmente não tem script `test`; `vitest.config.ts` na raiz lista `server` em `test.projects`; `pnpm vitest run --project server` é invocação válida.
- **(a) "Como vou verificar" expandido** — APROVADO. Os 5 checks cobrem os planos esperados:
  - Check 1 (smoke do arquivo) — feedback rápido durante iteração.
  - Check 2 (suite completa do `server` project) — captura regressão lateral; fecha spec critério #4 (parte "testes").
  - Check 3 (`pnpm --filter @paperclipai/server build` = `tsc && cp onboarding-assets`) — fecha spec critério #4 (parte "build"), pega erros de bundling/cópia que `typecheck --noEmit` não detecta.
  - Check 4 (typecheck mantido) — defesa em profundidade para erros TS.
  - Check 5 (inspeção visual) — confirma escopo cirúrgico de 1 linha.
- **(b) Critério de aceite #6 adicionado** — APROVADO. Hand-off pós-merge fica explícito: link ao PR, sinalização "motor corrigido / control plane precisa redeploy", board/CTO nomeado como owner do redeploy. Verificável antes de marcar `done`.

### Cobertura cruzada (spec → contrato)

Todos os 6 critérios do spec da issue agora têm correspondência clara em "Critérios de aceite" + "Como vou verificar". Sem gap residual.

### Escopo

"Fora do escopo" mantém-se sólido (4 outras chamadas de `selectStageParticipant` não tocadas, sem refactor, sem telemetria, sem mexer em simplafy-admin, sem revogar SIMAA-2198, sem contornos issue-a-issue).

### Testabilidade

Cada check produz PASS/FAIL óbvio (exit code de vitest/tsc + diff inspecionável + presença de comment em SIMAA-2205).

### Veredito

**APROVADO — round 2.** Contrato pactuado. Builder pode prosseguir para implementação. Próximo gate: smoke pre-PR.
