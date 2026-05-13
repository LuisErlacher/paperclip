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

## Verifier review (Verifier preenche)

(seção vazia até Verifier responder)
