# RASTRO

Plataforma de due diligence ambiental verificável para exportadores EUDR — construída com Chainlink CRE, smart contracts e dados oficiais brasileiros.

---

## O que é

O RASTRO permite que qualquer pessoa no mundo verifique o status de compliance EUDR de uma propriedade rural brasileira sem login, sem wallet, sem gas. O status é calculado onchain com regra fixa baseada em dados oficiais — sem IA na decisão regulatória.

Desenvolvido por **Izabela Fernandes + Armando Freire** para o HackaNation 2026.

---

## O problema que resolve

Exportadores europeus precisam provar que os produtos que importam não vêm de áreas desmatadas após 31/12/2020 (EUDR Art. 3). Hoje isso é feito manualmente, com laudos em PDF e planilhas. O RASTRO automatiza a verificação com dados de satélite (MapBiomas) e registros oficiais (IBAMA), registra tudo onchain e gera um laudo auditável por qualquer regulador.

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Smart contract | Solidity 0.8.20 — Ethereum Sepolia |
| Oráculos | Chainlink CRE (dois workflows TypeScript) |
| Dados ambientais | MapBiomas Alerta GraphQL |
| Dados de embargo | IBAMA PAMGIA ArcGIS REST |
| Armazenamento de laudos | IPFS via Pinata |
| Narrativa do laudo | Gemini 2.0 Flash (leitor, não juiz) |

---

## Arquitetura

O sistema é composto por um smart contract e dois workflows CRE independentes.

### Smart Contract — Rastro.sol

Gerencia o ciclo de vida das fazendas: cadastro, validação, verificação ambiental e cadeia de custódia. O status EUDR é calculado internamente com regra fixa — nenhuma IA participa da decisão.

**Status possíveis:**

| Status | Significado |
|--------|-------------|
| `PENDING` | Cadastrada, aguardando validação |
| `LOW_RISK` | Todas as verificações EUDR passaram |
| `INCOMPLETE` | Ambiental ok, falta cadeia de custódia |
| `FLAGGED` | Desmatamento detectado ou embargo ativo |

**Regra fixa no contrato:**

```
desmatamento OU embargo ativo → FLAGGED
ambiental ok + sem cadeia de custódia → INCOMPLETE
tudo ok → LOW_RISK
```

**Três CIDs IPFS por fazenda:**

| CID | Gerado por | Mutabilidade | Conteúdo |
|-----|-----------|-------------|----------|
| `cidTerritorial` | Workflow Registro | Imutável | boundingBox, área, estado |
| `cidAnalise` | Workflow Análise | Atualiza toda semana | alertas, embargos, timestamp |
| `cidGemini` | Workflow Análise | Atualiza quando muda | narrativa textual do laudo |

---

## Diagrama do Sistema
<img width="1062" height="951" alt="image" src="https://github.com/user-attachments/assets/687da22c-130b-4825-93a2-0d91b0124fab" />



### Workflow 1 — Registro (`patrol-registro`)

**Trigger:** Cron horário (`0 * * * *`)  
**Responsabilidade:** Validar existência do CAR e registrar dados territoriais imutáveis  
**Filtro:** Processa apenas fazendas com `cidTerritorial` vazio — cada CAR é processado uma única vez

**Fluxo:**
```
1. Lê cidTerritorial onchain (só RPC)
   → preenchido → pula
   → vazio → processa

2. Consulta MapBiomas Alerta (ruralProperty)
   → null → invalidarCAR() → burn NFT
   → existe → coleta boundingBox, área, estado

3. Pina laudo territorial no IPFS

4. Chama registrarTerritorial(car, cid) onchain
```

---

### Workflow 2 — Análise (`patrol-analise`)

**Trigger:** Cron semanal toda segunda-feira (`0 0 * * 1`)  
**Responsabilidade:** Verificação EUDR completa — alertas, embargos, narrativa Gemini  
**Filtro:** Processa apenas fazendas com `cidTerritorial` preenchido

O ciclo semanal serve a dois propósitos: pegar novos CARs registrados durante a semana e reanalisar fazendas já analisadas, capturando mudanças de alerta ou embargo desde a última verificação.

**Por que reanalisar semanalmente?**

O MapBiomas Alerta publica novos alertas com atualização semanal — o RASTRO está sincronizado com isso. O IBAMA é independente e burocrático: um embargo pode ser emitido semanas após o alerta, e pode continuar ativo mesmo depois que o alerta foi cancelado no MapBiomas. Verificar semanalmente garante que ambas as fontes sejam checadas regularmente.

**Otimização de calls:**

```
Fase 1 — só RPC:
  filtra CARs com cidTerritorial
  nenhum tem → encerra (zero calls de API)

Fase 2 — login MapBiomas UMA VEZ:
  token reutilizado em todos os CARs do loop

Fase 3 — por CAR:
  sem mudança + menos de 7 dias → pula (2 calls: login + MapBiomas)
  mudou ou passou 7 dias → análise completa (6 calls)
```

**Calls por situação:**

| Situação | RPC | MapBiomas | IBAMA | Pinata | Gemini |
|----------|-----|-----------|-------|--------|--------|
| Sem territorial | 2 | 0 | 0 | 0 | 0 |
| Com territorial, sem mudança | 3–4 | 1 | 0 | 0 | 0 |
| CAR novo ou mudou ou 7 dias | 3–4 | 1 | 1 | 2 | 1 |

---

## Três tipos de dado

| Tipo | Origem | Exemplo |
|------|--------|---------|
| **Oficial** | MapBiomas, IBAMA, SICAR | alertas, embargos, localização |
| **Declarado** | Exportador via frontend | cadeia de custódia, hash NF-e |
| **Calculado** | Smart contract (regra fixa) | LOW_RISK / INCOMPLETE / FLAGGED |

---

## O papel do Gemini

O Gemini gera exclusivamente narrativa textual para o `cidGemini`:

- `justificativa` — resumo executivo
- `compliance` — análise EUDR Art. 3 e Art. 10
- `interpretacao` — interpretação dos dados ambientais
- `resumo` — linguagem clara para o importador europeu

O Gemini não decide status, não calcula risco, não emite score. A decisão regulatória é do contrato.

---

## Funções públicas do contrato

Todas são `view` — sem gas, sem login, sem wallet.

| Função | Retorna |
|--------|---------|
| `verify(car)` | `VerifyResult` struct completo |
| `verifyEnvironmental(car)` | status + dados ambientais |
| `verifyDocuments(car)` | 3 CIDs IPFS |
| `getStatus(car)` | status + reason (leve, para listagens) |
| `getVerificationHistory(car)` | histórico auditável de verificações |
| `getSupplyChain(car)` | cadeia de custódia declarada |

---

## Cobertura EUDR

| Verificação | Fonte | Artigo EUDR |
|-------------|-------|-------------|
| Desmatamento pós-2020 | MapBiomas Alerta | Art. 3(a) |
| Embargos ambientais | IBAMA PAMGIA | Art. 3(b) |
| Geolocalização da propriedade | MapBiomas (boundingBox) | Art. 9 |
| Cadeia de custódia | Declaratória pelo exportador | Art. 9/10 |

---

## Auditoria de segurança

O contrato foi auditado com três ferramentas antes do deploy:

| Ferramenta | Resultado |
|-----------|-----------|
| Foundry (`forge build`) | Compilação sem erros |
| Slither | 0 vulnerabilidades reais |
| Mythril | No issues were detected |

---

*RASTRO © 2026 · Izabela Fernandes + Armando Freire · HackaNation 2026*

