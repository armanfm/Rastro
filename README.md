# RASTRO

**Verifiable environmental due diligence for global commodity supply chains.**

> HackaNation 2026 · Sustainability & SDGs Track · Chainlink CRE Track

🌐 [English](#english) · [Português](#português)

---

## English

### What is Rastro

€70 billion in commodities imported annually by the EU require environmental due diligence. RASTRO automates this with official Brazilian data and verifiable on-chain proof.

The platform aggregates official Brazilian environmental data (MapBiomas, IBAMA, CAR/SICAR), registers results on-chain via decentralized oracle (Chainlink CRE) with immutable timestamps, and makes them publicly verifiable by anyone in the world — no login, no wallet, no gas.

The EUDR status is calculated by the smart contract with fixed rules. No AI participates in the regulatory decision.

Built by Izabela Fernandes + Armando Freire for HackaNation 2026.

### The problem

The EUDR (EU Regulation 2023/1115) takes effect December 2026. Operators placing commodities (soy, coffee, beef, cocoa, timber, rubber) on the EU market must prove that products are deforestation-free after 31/12/2020, produced in compliance with local laws, and covered by a due diligence statement with geolocation and risk assessment (Art. 3, 9, 10).

The EU-Mercosur agreement (January 2026) increases trade volume but maintains EUDR requirements. More trade with more compliance.

In practice, Brazilian exporters and international traders buying from Brazil need to provide verifiable evidence to their European buyers. The data exists — MapBiomas monitors deforestation by satellite, IBAMA registers embargoes, CAR/SICAR has property geolocation — but it's fragmented across different systems, in Portuguese, with no standardization.

Enterprise solutions exist (Agrotools, EY, SAP) but cost hundreds of thousands per year. Mid-market exporters have no accessible tool. And no solution offers proof that the European importer can independently verify without depending on anyone.

### Who it's for

**Pays (exporter/trader):** Commodity exporters and traders operating in the Brazil-EU corridor — Brazilian and international (Swiss, Dutch, American trading companies buying in Brazil). Cooperatives, meatpackers, mid-size traders. Monthly subscription in BRL (Pix, card, invoice). Blockchain is invisible to the end user.

**Verifies for free (importer/auditor):** European importers, auditors, regulators, ESG investors. Anyone types a CAR code and sees the full environmental status. No login, no account, no wallet. Free verification is the engine that feeds the network.

**Consumes via API (production):** Rural credit fintechs, agricultural insurers, certifiers, trade consultancies. Pay per query volume.

**Flywheel:** Importer verifies for free → prefers verifiable supplier → pressures exporter to join → exporter subscribes → more data on-chain → more importers verify. Self-sustaining network effect.

### How it works

1. **Register suppliers** — enter the CAR code. The platform validates format and existence, pulls property data automatically.
2. **Automatic verification** — Chainlink CRE crosses MapBiomas (deforestation) + IBAMA (embargoes) and registers on-chain with immutable timestamp.
3. **Register supply chain** — exporter records purchases with document hash. Commercial data stays private — only the hash goes on-chain.
4. **Prove** — share a verification link or export a due diligence package with on-chain hashes. Ready for the European importer.

### Three data layers

| Type | Source | Example | Guarantee |
|------|--------|---------|-----------|
| **Official** | MapBiomas, IBAMA, SICAR | Deforestation, embargoes, geolocation | Automated from public sources |
| **Declared** | Exporter via platform | Supply chain, document hash | Platform registers, does not guarantee veracity |
| **Calculated** | Smart contract (fixed rules) | LOW_RISK / INCOMPLETE / FLAGGED | Deterministic, auditable, no AI |

The importer sees exactly what is officially verified and what is declared by the company. No mixing. No ambiguity.

### Supply chain — privacy by design

The supply chain connects the verified property to the exporter's commercial operation. The EUDR (Art. 9) requires traceability from the commodity to the plot of land.

Commercial data (who sold to whom, quantities, prices, invoice numbers) **never goes on-chain**. Only the document hash (bytes32). The exporter shares details privately with authorized parties. The importer receives the data, generates the hash, compares with on-chain, and confirms authenticity.

**Registration:**
```
registrarCadeia(codigoCAR, documentHash)
```
Validates CAR exists → records hash + timestamp on-chain → updates supplyChainRegistered → recalculates status → emits event.

**Invalidation:**
```
invalidarCadeia(codigoCAR, stepId, motivo)
```
Marks record as invalidated with mandatory reason. Does not delete — transparency over concealment. Original record stays on-chain permanently. If no valid step remains, status reverts to INCOMPLETE.

### Why on-chain

The proof is not locked in our system. Each verification has an immutable timestamp on the blockchain. The data cannot be altered by anyone — not by the platform, not by the exporter, not by any government.

An importer in Rotterdam verifies the data of a farm in Mato Grosso directly, without depending on anyone. If the platform shuts down tomorrow, records remain publicly accessible.

This is not possible with databases, PDFs, or spreadsheets — any of those can be altered after the fact without leaving a trace.

### Architecture

The system consists of one smart contract and two independent CRE workflows with distinct responsibilities.

#### Smart Contract — Rastro.sol

ERC-721 on Ethereum Sepolia. Each property is an NFT with environmental status.

| Status | Meaning |
|--------|---------|
| PENDING | Registered, awaiting validation |
| LOW_RISK | All EUDR checks passed |
| INCOMPLETE | Environmental ok, missing supply chain |
| FLAGGED | Deforestation detected or active embargo |

Fixed rule — zero ambiguity:
```
deforestation OR active embargo → FLAGGED
environmental ok + no supply chain registered → INCOMPLETE
environmental ok + supply chain registered → LOW_RISK
supply chain invalidated + no replacement → reverts to INCOMPLETE
```

#### Three IPFS CIDs per property

| CID | Generated by | Mutability | Content |
|-----|-------------|------------|---------|
| cidTerritorial | Workflow 1 | Immutable — registered once | boundingBox, area, state |
| cidAnalise | Workflow 2 | Updates weekly if changed | alerts, embargoes, binary data, sourceHash |
| cidGemini | Workflow 2 | Updates when analysis changes | textual narrative for human readability |

#### Workflow 1 — Registration (patrol-registro)

**Trigger:** Hourly cron  
**Responsibility:** Validate CAR existence and register immutable territorial data  
**Filter:** Only processes properties with empty cidTerritorial — each CAR processed once

```
1. Read cidTerritorial on-chain → filled → skip
2. Query MapBiomas ruralProperty → null → invalidarCAR() burn NFT
3. Exists → collect boundingBox, area, state
4. Pin territorial report to IPFS → cidTerritorial
5. Call registrarTerritorial(car, cid) on-chain
```

#### Workflow 2 — Analysis (patrol-analise)

**Trigger:** Weekly cron (Mondays)  
**Responsibility:** Full EUDR verification — alerts, embargoes, Gemini narrative  
**Filter:** Only processes properties with cidTerritorial filled

```
1. Read cidTerritorial → empty → skip (awaits registration)
2. Read previous cidAnalise → high-water mark comparison
3. No change + less than 7 days → skip
4. Query MapBiomas alerts
5. Query IBAMA via boundingBox from territorial CID
6. Calculate binary data (workflow, not AI):
   deforestationStatus = alerts > 0 ? 1 : 0
   embargoStatus = activeEmbargo > 0 ? 1 : 0
7. Pin cidAnalise to IPFS
8. Gemini generates narrative → pin cidGemini to IPFS
9. Call registrarVerificacao() → contract calculates status
```

### Gemini's role

The AI is the reader, not the judge.

Gemini generates exclusively textual narrative for the cidGemini: executive summary, EUDR Art. 3/10 compliance analysis, data interpretation, and clear summary for the European importer.

**Gemini does not decide status, does not calculate risk, does not emit scores.** The regulatory decision belongs to the smart contract with fixed rules, auditable by any regulator.

### Public functions

All `view` — no gas, no login, no wallet.

| Function | Returns |
|----------|---------|
| `verify(car)` | Complete VerifyResult struct |
| `verifyEnvironmental(car)` | Status + environmental data |
| `verifyDocuments(car)` | 3 IPFS CIDs |
| `getStatus(car)` | Status + reason (lightweight) |
| `getVerificationHistory(car)` | Auditable verification history |
| `getSupplyChain(car)` | All supply chain steps (valid + invalidated) |

Write functions (require gas):

| Function | Action |
|----------|--------|
| `registrarCadeia(car, hash)` | Register supply chain step (hash-only) |
| `invalidarCadeia(car, id, reason)` | Invalidate step with mandatory reason |

### EUDR coverage

| Verification | Source | EUDR Article | Impact on status |
|-------------|--------|-------------|-----------------|
| Post-2020 deforestation | MapBiomas Alerta | Art. 3(a) | FLAGGED |
| Environmental embargoes | IBAMA PAMGIA ArcGIS REST | Art. 3(b) | FLAGGED |
| Property geolocation | MapBiomas (boundingBox) | Art. 9 | Burn NFT if invalid |
| Supply chain (hash-only) | Declared by exporter | Art. 9/10 | INCOMPLETE if missing |

### Stack

| Component | Technology |
|-----------|-----------|
| Smart contract | Solidity 0.8.20, ERC-721, Ethereum Sepolia |
| Oracle | Chainlink CRE (2 TypeScript workflows) |
| Environmental data | MapBiomas Alerta GraphQL + IBAMA ArcGIS REST |
| Report storage | IPFS via Pinata (3 separate CIDs) |
| Narrative | Gemini 2.0 Flash (reader, not judge) |
| Frontend | React + ethers.js (no backend in MVP) |
| Languages | English (default) + Portuguese |

### Security audit

| Tool | Result |
|------|--------|
| Foundry (forge build) | Compilation without errors |
| Slither | 0 real vulnerabilities |
| Mythril | No issues detected |

### Sustainable Development Goals

- **SDG 12** — Responsible consumption and production
- **SDG 13** — Climate action (deforestation combat, carbon credits extension)
- **SDG 15** — Life on land (forest and biome protection)
- **SDG 16** — Peace, justice and strong institutions (transparency, anti-fraud)
- **SDG 17** — Partnerships for the goals (bridge between Brazilian data and European regulation)

### Competitive moats

1. **Data network effect** — each supply chain record on-chain creates data that doesn't exist anywhere else. Track record accumulates, switching costs grow with time.
2. **Regulatory intelligence** — co-founded by an international and tax lawyer (OAB/MG, ITS Rio). The product is born from regulation, not retrofitted to it.
3. **Native Brazilian data** — MapBiomas (superior to Hansen Global Forest Change for Brazil), IBAMA, CAR/SICAR. Global competitors use generic satellite data.
4. **Public on-chain infrastructure** — records survive the platform. If Rastro shuts down, verifications remain accessible.
5. **Supply chain as unique asset** — verifiable custody chain serves beyond EUDR: rural credit, agricultural insurance, trade finance, certifications, anti-fraud, CSRD/SFDR European reporting.

### Beyond EUDR — where the infrastructure can go

**Carbon credits** — same data proves forest preservation over time. On-chain permanence proof, native anti-double counting. USD 10-40B market by 2030.

**CSRD / SFDR** — European companies must report sustainable supply chains. Exporters with verifiable data on Rastro simplify the importer's own compliance.

**CBAM** — EU carbon border adjustment mechanism. Product-level environmental footprint traceability.

**Critical minerals (CRMA)** — the EU requires supply chain due diligence for strategic minerals (lithium, cobalt, niobium, rare earths). Brazil is a major producer. Same architecture: mineral property registered, official verification (ANM, IBAMA), supply chain with hash, on-chain proof. Different data source, same infrastructure.

**Rural credit and agricultural insurance** — fintechs and insurers verify environmental risk before lending or issuing policies. Paid API.

**Certifications** — Rainforest Alliance, FSC, Fair Trade verify certified product flow. On-chain custody chain as evidence base.

**Commercial anti-fraud** — prevents selling the same lot twice to two different importers.

### Roadmap

**MVP (Hackathon):** Smart contract ERC-721 + 2 CRE workflows + 3 IPFS CIDs + supply chain registration (hash-only) + frontend (5 screens, bilingual) + demo with 5 real properties.

**Phase 1 (1-6 months):** Real API integrations, automated weekly monitoring, embedded wallet login (no MetaMask), BRL payments, PDF due diligence generation, additional layers (FUNAI, ICMBio, MTE), NF-e validation, pilot with 5-10 real exporters.

**Phase 2 (6-12 months):** Third-party API, carbon credits, importer dashboard, encrypted IPFS with automatic hash verification, discrete blockchain (hashed CAR identifiers), automatic DDS generation for EU TRACES, AI document parsing, batch upload via CSV/ERP integration.

**Phase 3 (12-24 months):** Geographic expansion (Colombia, Indonesia, Ivory Coast), zkProofs for verifiable computation, open governance, automatic NF-e integration via digital certificate, CSRD/CBAM compliance layers, critical minerals (CRMA), volume verification and anti-fraud.

### Team

**Izabela Fernandes** — Legal, strategy, EUDR/CSRD/CBAM, regulatory intelligence, pitch. International and tax lawyer (OAB/MG). Researcher at ITS Rio. Founder of IusChain.

**Armando Freire** — Smart contract, Chainlink CRE, deploy, technical architecture. Blockchain developer Solidity/TypeScript.

---

## Português

### O que é o Rastro

€70 bilhões em commodities importadas anualmente pela UE precisam de due diligence ambiental. O RASTRO automatiza isso com dados oficiais brasileiros e prova on-chain verificável.

A plataforma agrega dados oficiais brasileiros (MapBiomas, IBAMA, CAR/SICAR), registra on-chain via oráculo descentralizado (Chainlink CRE) com timestamp imutável, e disponibiliza para verificação pública por qualquer pessoa no mundo — sem login, sem wallet, sem gas.

O status EUDR é calculado pelo smart contract com regra fixa. Nenhuma IA participa da decisão regulatória.

Desenvolvido por Izabela Fernandes + Armando Freire para o HackaNation 2026.

### O problema que resolve

A EUDR (Regulamento UE 2023/1115) entra em vigor em dezembro de 2026. Operadores que colocam commodities (soja, café, carne, cacau, madeira, borracha) no mercado da UE precisam provar que os produtos são livres de desmatamento após 31/12/2020, produzidos em conformidade com as leis locais, e cobertos por due diligence statement com geolocalização e avaliação de risco (Art. 3, 9, 10).

O acordo Mercosul-UE (janeiro de 2026) aumenta o fluxo de commodities mas mantém a EUDR em vigor. Mais comércio com mais compliance.

Na prática, exportadores brasileiros e traders internacionais que compram no Brasil precisam fornecer evidência verificável para seus compradores europeus. Os dados existem — MapBiomas monitora desmatamento por satélite, IBAMA registra embargos, CAR/SICAR tem a geolocalização — mas estão fragmentados em sistemas diferentes, em português, sem padronização.

Soluções enterprise existem (Agrotools, EY, SAP) mas custam centenas de milhares por ano. O exportador médio não tem ferramenta acessível. E nenhuma solução oferece prova que o importador europeu pode verificar independentemente sem depender de ninguém.

### Para quem

**Paga (exportador/trader):** Exportadores e traders de commodities no corredor Brasil-UE — brasileiros e internacionais (tradings suíças, holandesas, americanas que compram no Brasil). Cooperativas, frigoríficos, tradings médias. Assinatura mensal em reais (Pix, cartão, boleto). A blockchain é invisível para o usuário final.

**Verifica de graça (importador/auditor):** Importadores europeus, auditores, reguladores, investidores ESG. Qualquer pessoa digita o código CAR e vê o status ambiental completo. Sem login, sem conta, sem wallet. A verificação gratuita é o motor que alimenta a rede.

**Consome via API (produção):** Fintechs de crédito rural, seguradoras agrícolas, certificadoras, consultorias de comex. Pagam por volume de consultas.

**Flywheel:** Importador verifica de graça → prefere fornecedor verificável → pressiona exportador a aderir → exportador assina → mais dados on-chain → mais importadores verificam. Efeito de rede autossustentável.

### Como funciona

1. **Cadastre fornecedores** — informe o código CAR. A plataforma valida formato e existência, puxa dados da propriedade automaticamente.
2. **Verificação automática** — Chainlink CRE cruza MapBiomas (desmatamento) + IBAMA (embargos) e registra on-chain com timestamp imutável.
3. **Registre cadeia de custódia** — exportador registra compras com hash do documento. Dados comerciais ficam privados — apenas o hash vai on-chain.
4. **Comprove** — compartilhe um link de verificação ou exporte pacote de due diligence com hashes on-chain. Pronto para o importador europeu.

### Três camadas de dados

| Tipo | Origem | Exemplo | Garantia |
|------|--------|---------|----------|
| **Oficial** | MapBiomas, IBAMA, SICAR | Desmatamento, embargos, localização | Fonte pública automática |
| **Declarado** | Exportador via plataforma | Cadeia de custódia, hash NF-e | Plataforma registra, não garante veracidade |
| **Calculado** | Smart contract (regra fixa) | LOW_RISK / INCOMPLETE / FLAGGED | Determinístico, auditável, sem IA |

O importador vê exatamente o que é dado oficial verificável e o que é declaração da empresa. Sem misturar. Sem ambiguidade.

### Cadeia de custódia — privacidade por design

A cadeia de custódia conecta a propriedade verificada à operação comercial do exportador. A EUDR (Art. 9) exige rastreabilidade da commodity até a parcela de terra.

Dados comerciais (quem vendeu, quantidade, preço, número da nota fiscal) **nunca ficam on-chain**. Apenas o hash do documento (bytes32). O exportador compartilha detalhes privativamente com quem ele autorizar. O importador recebe os dados, gera o hash, compara com o on-chain, e confirma autenticidade.

**Registro:**
```
registrarCadeia(codigoCAR, documentHash)
```
Valida existência do CAR → grava hash + timestamp on-chain → atualiza supplyChainRegistered → recalcula status → emite evento.

**Invalidação:**
```
invalidarCadeia(codigoCAR, stepId, motivo)
```
Marca registro como invalidado com motivo obrigatório. Não apaga — transparência acima de ocultamento. Registro original permanece on-chain. Se não há step válido restante, status volta para INCOMPLETE.

### Por que on-chain

A prova não fica presa ao nosso sistema. Cada verificação tem timestamp imutável na blockchain. O dado não pode ser alterado por ninguém — nem pela plataforma, nem pelo exportador, nem por nenhum governo.

Um importador em Rotterdam verifica o dado de uma fazenda em Mato Grosso direto, sem depender de ninguém. Se a plataforma fechar amanhã, os registros continuam acessíveis publicamente.

Isso não é possível com banco de dados, PDF ou planilha — qualquer um desses pode ser alterado depois sem deixar rastro.

### Arquitetura

O sistema é composto por um smart contract e dois workflows CRE independentes com responsabilidades distintas.

#### Smart Contract — Rastro.sol

ERC-721 na Ethereum Sepolia. Cada propriedade é um NFT com status ambiental.

| Status | Significado |
|--------|-------------|
| PENDING | Cadastrada, aguardando validação |
| LOW_RISK | Todas as verificações EUDR passaram |
| INCOMPLETE | Ambiental ok, falta cadeia de custódia |
| FLAGGED | Desmatamento detectado ou embargo ativo |

Regra fixa — zero ambiguidade:
```
desmatamento OU embargo ativo → FLAGGED
ambiental ok + sem cadeia de custódia → INCOMPLETE
ambiental ok + cadeia registrada → LOW_RISK
cadeia invalidada + sem substituta → volta para INCOMPLETE
```

#### Três CIDs IPFS por fazenda

| CID | Gerado por | Mutabilidade | Conteúdo |
|-----|-----------|-------------|----------|
| cidTerritorial | Workflow 1 | Imutável — registrado uma vez | boundingBox, área, estado |
| cidAnalise | Workflow 2 | Atualiza semanalmente se mudou | alertas, embargos, dados binários, sourceHash |
| cidGemini | Workflow 2 | Atualiza quando análise muda | narrativa textual para leitura humana |

#### Workflow 1 — Registro (patrol-registro)

**Trigger:** Cron horário  
**Responsabilidade:** Validar existência do CAR e registrar dados territoriais imutáveis  
**Filtro:** Só processa propriedades com cidTerritorial vazio — cada CAR processado uma única vez

```
1. Lê cidTerritorial on-chain → preenchido → pula
2. Consulta MapBiomas ruralProperty → null → invalidarCAR() burn NFT
3. Existe → coleta boundingBox, área, estado
4. Pina laudo territorial no IPFS → cidTerritorial
5. Chama registrarTerritorial(car, cid) on-chain
```

#### Workflow 2 — Análise (patrol-analise)

**Trigger:** Cron semanal (segundas-feiras)  
**Responsabilidade:** Verificação EUDR completa — alertas, embargos, narrativa Gemini  
**Filtro:** Só processa propriedades com cidTerritorial preenchido

```
1. Lê cidTerritorial → vazio → pula (aguarda registro)
2. Lê cidAnalise anterior → comparação high-water mark
3. Sem mudança + menos de 7 dias → pula
4. Consulta MapBiomas alertas
5. Consulta IBAMA via boundingBox do laudo territorial
6. Calcula dados binários (workflow, não IA):
   deforestationStatus = alertas > 0 ? 1 : 0
   embargoStatus = embargoAtivo > 0 ? 1 : 0
7. Pina cidAnalise no IPFS
8. Gemini gera narrativa → pina cidGemini no IPFS
9. Chama registrarVerificacao() → contrato calcula status
```

### Papel do Gemini

A IA é o leitor, não o juiz.

O Gemini gera exclusivamente narrativa textual para o cidGemini: resumo executivo, análise de compliance EUDR Art. 3/10, interpretação dos dados ambientais, e resumo em linguagem clara para o importador europeu.

**O Gemini não decide status, não calcula risco, não emite score.** A decisão regulatória é do smart contract com regra fixa, auditável por qualquer regulador.

### Funções públicas do contrato

Todas `view` — sem gas, sem login, sem wallet.

| Função | Retorna |
|--------|---------|
| `verify(car)` | VerifyResult struct completo |
| `verifyEnvironmental(car)` | Status + dados ambientais |
| `verifyDocuments(car)` | 3 CIDs IPFS |
| `getStatus(car)` | Status + reason (leve) |
| `getVerificationHistory(car)` | Histórico auditável |
| `getSupplyChain(car)` | Todos os steps (válidos + invalidados) |

Funções de escrita (requerem gas):

| Função | Ação |
|--------|------|
| `registrarCadeia(car, hash)` | Registra step da cadeia (hash-only) |
| `invalidarCadeia(car, id, motivo)` | Invalida step com motivo obrigatório |

### Cobertura EUDR

| Verificação | Fonte | Artigo EUDR | Impacto no status |
|------------|-------|-------------|------------------|
| Desmatamento pós-2020 | MapBiomas Alerta | Art. 3(a) | FLAGGED |
| Embargos ambientais | IBAMA PAMGIA ArcGIS REST | Art. 3(b) | FLAGGED |
| Geolocalização | MapBiomas (boundingBox) | Art. 9 | Burn NFT se inválido |
| Cadeia de custódia (hash-only) | Declaratória pelo exportador | Art. 9/10 | INCOMPLETE se ausente |

### Stack

| Componente | Tecnologia |
|-----------|-----------|
| Smart contract | Solidity 0.8.20, ERC-721, Ethereum Sepolia |
| Oráculo | Chainlink CRE (2 workflows TypeScript) |
| Dados ambientais | MapBiomas Alerta GraphQL + IBAMA ArcGIS REST |
| Armazenamento | IPFS via Pinata (3 CIDs separados) |
| Narrativa | Gemini 2.0 Flash (leitor, não juiz) |
| Frontend | React + ethers.js (sem backend no MVP) |
| Idiomas | Inglês (padrão) + Português |

### Auditoria de segurança

| Ferramenta | Resultado |
|-----------|-----------|
| Foundry (forge build) | Compilação sem erros |
| Slither | 0 vulnerabilidades reais |
| Mythril | No issues detected |

### Objetivos de Desenvolvimento Sustentável

- **ODS 12** — Consumo e produção responsáveis
- **ODS 13** — Ação contra a mudança global do clima (combate ao desmatamento, extensão para créditos de carbono)
- **ODS 15** — Vida terrestre (proteção de florestas e biomas)
- **ODS 16** — Paz, justiça e instituições eficazes (transparência, anti-fraude)
- **ODS 17** — Parcerias e meios de implementação (ponte entre dados brasileiros e regulação europeia)

### Moats — vantagens competitivas sustentáveis

1. **Data network effect** — cada registro de cadeia de custódia on-chain cria dado que não existe em nenhum outro lugar. Track record acumula, switching costs crescem com o tempo.
2. **Inteligência regulatória** — cofundada por advogada de direito internacional e tributário (OAB/MG, ITS Rio). O produto nasce da regulação, não é adaptado depois.
3. **Dados brasileiros nativos** — MapBiomas (superior ao Hansen Global Forest Change para o Brasil), IBAMA, CAR/SICAR. Concorrentes globais usam dados genéricos de satélite.
4. **Infraestrutura on-chain pública** — registros sobrevivem à plataforma. Se o Rastro fechar, verificações continuam acessíveis.
5. **Cadeia de custódia como ativo único** — serve além da EUDR: crédito rural, seguro agrícola, trade finance, certificações, anti-fraude, reporte CSRD/SFDR europeu.

### Além da EUDR — para onde a infraestrutura pode ir

**Créditos de carbono** — mesma base prova preservação florestal ao longo do tempo. Prova de permanência on-chain, anti-double counting nativo. Mercado de USD 10-40B até 2030.

**CSRD / SFDR** — empresas europeias precisam reportar cadeia de suprimentos sustentável. Exportador com dados verificáveis no Rastro facilita o compliance do importador.

**CBAM** — mecanismo de ajuste de carbono na fronteira da UE. Rastreabilidade da pegada ambiental do produto.

**Minerais críticos (CRMA)** — a UE exige due diligence na cadeia de minerais estratégicos (lítio, cobalto, nióbio, terras raras). O Brasil é produtor relevante. Mesma arquitetura: propriedade mineral registrada, verificação com dados oficiais (ANM, IBAMA), cadeia de custódia com hash, prova on-chain. Muda a fonte de dados, não a infraestrutura.

**Crédito rural e seguro agrícola** — fintechs e seguradoras verificam risco ambiental antes de emprestar ou emitir apólice. API paga.

**Certificações** — Rainforest Alliance, FSC, Fair Trade verificam fluxo de produto certificado.

**Anti-fraude comercial** — impede venda do mesmo lote para dois importadores diferentes.

### Roadmap

**MVP (Hackathon):** Smart contract ERC-721 + 2 workflows CRE + 3 CIDs IPFS + cadeia de custódia (hash-only) + frontend (5 telas, bilíngue) + demo com 5 propriedades reais.

**Fase 1 (1-6 meses):** Integrações reais com APIs, monitoramento semanal automatizado, login com email/senha (embedded wallet), pagamento em reais, geração de PDF de due diligence, camadas adicionais (FUNAI, ICMBio, MTE), validação NF-e, piloto com 5-10 exportadores reais.

**Fase 2 (6-12 meses):** API para terceiros, créditos de carbono, dashboard do importador, IPFS criptografado com verificação automática de hash, blockchain discreta (hash do CAR em vez de texto), geração automática de DDS para EU TRACES, IA para parsear documentos, upload em lote CSV/integração ERP.

**Fase 3 (12-24 meses):** Expansão geográfica (Colômbia, Indonésia, Costa do Marfim), zkProofs para computação verificável, governança aberta, integração automática NF-e via certificado digital, CSRD/CBAM como camadas regulatórias, minerais críticos (CRMA), verificação de volume e anti-fraude.

### Time

**Izabela Fernandes** — Legal, estratégia, EUDR/CSRD/CBAM, inteligência regulatória, pitch. Advogada de direito internacional e tributário (OAB/MG). Pesquisadora no ITS Rio. Fundadora da IusChain.

**Armando Freire** — Smart contract, Chainlink CRE, deploy, arquitetura técnica. Desenvolvedor blockchain Solidity/TypeScript.

---

RASTRO © 2026 · Izabela Fernandes + Armando Freire · HackaNation 2026 · All rights reserved
