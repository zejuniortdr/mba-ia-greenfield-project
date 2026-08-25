---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-22
scope_description: "Upload e processamento de vídeos: storage de arquivos, fila de processamento em background, worker de ffmpeg, upload resiliente até 10GB, streaming e download."
---

# Technical Decisions — Upload e Processamento de Vídeos (Fase 03)

_Subprojects in scope:_

- `nestjs-project/` — dono de todas as decisões desta fase: storage, fila, worker, upload, extração de metadados/thumbnail, streaming/download.
- `next-frontend/` — nenhuma tela de upload/player é capability desta fase (ficam para Fase 04/05, que ainda não foram planejadas). Único acoplamento com o frontend é o **contrato de transporte** do upload (TD-05, `Scope: Cross-layer`), decidido agora porque define o desenho da API que a Fase 04/05 vão consumir depois.

---

## TD-01: Object Storage Backend & Client

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** README e diagrama de arquitetura já apontam MinIO (dev) / S3 (prod) como Object Storage. Falta decidir o client/SDK que o `nestjs-api` e o worker usam para falar com esse serviço, já que isso define a superfície de código reaproveitada entre upload, worker e streaming.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Client oficial da API S3, MinIO é S3-compatible e aceita apontar o `endpoint` para o container MinIO em dev.
- **Pros:** mesmo código funciona contra MinIO (dev) e AWS S3 real (prod) sem trocar client; suporta multipart upload e presigned URLs nativamente; maior ecossistema/documentação.
- **Cons:** SDK genérico, algumas operações administrativas específicas do MinIO (bucket policies não padrão) não são cobertas.

### Option B: MinIO JS SDK (`minio`)
- Client oficial do MinIO, também fala protocolo S3 mas com API própria.
- **Pros:** API mais simples para casos MinIO-only; suporte nativo a bucket notifications do MinIO.
- **Cons:** troca de provedor em prod (S3 real) exige revalidar compatibilidade; API diverge da AWS SDK, dificultando portar para S3 gerenciado depois.

### Option C: Sistema de arquivos local (volume Docker)
- Grava vídeos direto em um volume montado, sem serviço de storage dedicado.
- **Pros:** zero infraestrutura nova.
- **Cons:** contradiz a arquitetura já documentada (Object Storage é container planejado); não escala, não separa storage do host da API; descartada.

**Recommendation:** Option A (AWS SDK v3) — o projeto já documentou MinIO em dev e S3 em prod como o mesmo container lógico; usar o SDK da AWS contra o endpoint do MinIO evita reescrever a camada de storage quando migrar para S3 real, e cobre tanto multipart upload quanto presigned URLs necessários para TD-05.

**Decision:** A (AWS SDK v3)

---

## TD-02: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Define o broker que enfileira o job de processamento de vídeo criado após o upload. Stack atual não tem Redis nem RabbitMQ — só Postgres. README lista "Message Queue" como container ainda TBD.

**Options:**

### Option A: BullMQ (Redis)
- Fila madura sobre Redis, com retries, backoff, delayed jobs e dashboards prontos (Bull Board).
- **Pros:** feature-completo (retries com backoff exponencial, concorrência configurável, prioridade); ecossistema grande; fácil observar filas travadas.
- **Cons:** adiciona Redis como nova peça de infra (novo container, nova dependência operacional) só para esse propósito.

### Option B: pg-boss (PostgreSQL)
- Fila implementada em cima de tabelas Postgres com `SKIP LOCKED`, sem infra nova.
- **Pros:** reusa o Postgres já existente no compose; ACID nativo (job e efeitos no mesmo banco); menos um serviço pra subir/monitorar.
- **Cons:** menos recursos que BullMQ (sem flows/dependências entre jobs); throughput mais baixo, mas suficiente pro volume de upload de vídeo de um projeto didático.

### Option C: RabbitMQ (amqplib / `@nestjs/microservices`)
- Broker de mensageria dedicado, integração nativa via `@nestjs/microservices`.
- **Pros:** alinhado ao "Message Queue" citado no diagrama C4 como peça própria; bom para múltiplos consumers/exchanges no futuro.
- **Cons:** infraestrutura mais pesada que as outras duas opções pro escopo atual (só 1 tipo de job); maior complexidade operacional sem ganho concreto agora.

**Recommendation:** Option B (pg-boss) — o projeto não tem Redis nem RabbitMQ em nenhuma fase anterior, e o volume de jobs (1 processamento por vídeo enviado) não justifica novo serviço de infra; pg-boss aproveita o Postgres 17 já rodando e mantém o compose enxuto. Se o volume de jobs crescer, é uma decisão revisável (Supersede) nas fases seguintes.

**Decision:** B (pg-boss)

---

## TD-03: Video Processing Worker Deployment Topology

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas), Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** README e diagrama C4 já citam "Video Worker (FFmpeg)" como container próprio, separado da API. Falta decidir como esse worker é implementado e como consome a fila escolhida em TD-02.

**Options:**

### Option A: App NestJS standalone separada (novo container, mesmo monorepo `nestjs-project/`)
- Segunda entrypoint Nest (`NestFactory.createApplicationContext`) rodando só o módulo de processamento, container próprio no `compose.yaml`, consumindo a fila do TD-02.
- **Pros:** reusa entidades/config/DI já existentes no `nestjs-project`; isola falhas de processamento (crash do worker não derruba a API); casa com o diagrama C4 (Video Worker como container separado).
- **Cons:** duplica bootstrap de app (dois `main.ts`), precisa de Dockerfile/target de build próprio para o worker.

### Option B: Consumer no mesmo processo do `nestjs-api`
- O próprio `nestjs-api` registra o listener/worker da fila e processa vídeos in-process.
- **Pros:** zero infra nova, um único container.
- **Cons:** processamento de vídeo (ffmpeg) é CPU-bound e pesado — compete por recursos com requests HTTP no mesmo processo, contrariando o "não travar o sistema" citado nos Pontos de Atenção; não bate com o diagrama C4, que já modela Video Worker como container separado.

**Recommendation:** Option A — mantém a separação já documentada no diagrama de arquitetura e evita que o processamento pesado de ffmpeg compita por CPU/event loop com a API que serve requests HTTP.

**Decision:** A (App NestJS standalone separada)

---

## TD-04: Video Metadata & Thumbnail Extraction Tool

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados), Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Define a ferramenta usada pelo worker (TD-03) para extrair duração/metadados e gerar thumbnail a partir de um frame do vídeo.

**Options:**

### Option A: `fluent-ffmpeg` + binário `ffmpeg`/`ffprobe` no container do worker
- Wrapper Node para o CLI do ffmpeg; `ffprobe` extrai metadados/duração, `ffmpeg -ss` extrai um frame como thumbnail.
- **Pros:** API Node idiomática sobre o ffmpeg (já é o processador citado no README/diagrama); binário instalável via `apt` na imagem Docker do worker; controle total sobre timestamp do frame extraído.
- **Cons:** exige instalar o binário ffmpeg na imagem Docker do worker (não é só `npm install`).

### Option B: `child_process.spawn` direto no binário `ffmpeg`/`ffprobe`, sem wrapper
- Mesma dependência de binário, sem a camada de abstração do `fluent-ffmpeg`.
- **Pros:** uma dependência a menos no `package.json`.
- **Cons:** reimplementa parsing de args/stdout que o `fluent-ffmpeg` já resolve; mais código de baixo nível para manter.

### Option C: Serviço de transcodificação em nuvem (ex: AWS MediaConvert)
- Delega extração de metadados/thumbnail a um serviço externo.
- **Pros:** nenhuma infra de processamento local.
- **Cons:** introduz dependência de um provedor cloud pago fora do escopo do projeto (self-hosted com MinIO/Postgres/Mailpit); descartada.

**Recommendation:** Option A (`fluent-ffmpeg`) — o README já define FFmpeg como a ferramenta do Video Worker; o wrapper evita reimplementar parsing de comandos/saída do CLI que o `child_process` puro exigiria.

**Decision:** A (`fluent-ffmpeg`)

**Revisions:**
- 2026-08-22 — Frame do thumbnail extraído a 10% da duração do vídeo (`ffmpeg -ss {10%*duration}`), com fallback pro frame 0 quando o vídeo for curto demais (<2s) pro cálculo fazer sentido. Rationale: 10% da duração evita frame preto de abertura comum em vídeos, mais representativo que timestamp fixo.

---

## TD-05: Large Video Upload Transport Protocol

**Scope:** Cross-layer

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance, Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Arquivos de até 10GB não podem passar pelo `nestjs-api` como stream bufferizado sem risco de travar o processo (Pontos de Atenção: "upload... não pode travar o sistema" e "permitir retomar em caso de falha de conexão"). Isso decide o contrato entre quem inicia o upload (hoje: chamada direta à API/Swagger; futuramente a UI da Fase 04) e a API — por isso é Cross-layer mesmo sem tela definida ainda: a Fase 04 vai implementar a UI sobre o contrato decidido aqui.

**Options:**

### Option A: Multipart upload com presigned URLs por parte (browser/cliente fala direto com o storage)
- API cria o registro de vídeo em rascunho + inicia um `CreateMultipartUpload` no storage (TD-01) e devolve presigned URLs por parte; cliente sobe cada parte (5MB–5GB) direto pro MinIO/S3; API só recebe a chamada de `CompleteMultipartUpload`.
- **Pros:** bytes do vídeo nunca passam pelo `nestjs-api` — zero impacto de CPU/memória/rede na API durante o upload de 10GB; partes falhas podem ser re-enviadas individualmente (resumable); paraleliza partes.
- **Cons:** quebra o modelo BFF estrito do frontend (browser fala direto com o storage nessa etapa específica) — precisa ser documentado como exceção deliberada quando a Fase 04 desenhar a UI; mais chamadas de API (iniciar, por-parte, completar).

### Option B: Streaming pass-through pela API (`nestjs-api` repassa bytes pro storage sem bufferizar em memória/disco)
- Cliente faz upload multipart/form-data pro endpoint da API; a API usa stream (ex: `Upload` do AWS SDK v3, que já faz multipart internamente) repassando direto pro storage sem escrever em disco.
- **Pros:** mantém o modelo BFF/API como único ponto de entrada, sem expor o storage ao cliente.
- **Cons:** a API fica no caminho crítico do upload de 10GB — timeout de request HTTP longo, maior superfície de falha no processo da API, e retomada de upload após queda de conexão é bem mais difícil de implementar (não há partes independentes re-enviáveis).

### Option C: Protocolo tus (resumable upload) via `nestjs-tus` ou tusd
- Protocolo aberto de upload resumável (offset-based), com servidor tus dedicado.
- **Pros:** resumable por design, especificação madura, clientes prontos.
- **Cons:** introduz mais uma peça de infra (servidor tus) e um protocolo novo no projeto sem necessidade, quando o storage S3-compatible já escolhido (TD-01) resolve upload resumável nativamente via multipart.

**Recommendation:** Option A (multipart + presigned URLs) — é o único caminho que cumpre as duas restrições dos Pontos de Atenção simultaneamente (upload de 10GB sem travar o sistema E retomada por parte após falha), e reaproveita o multipart upload que o AWS SDK v3 (TD-01) já oferece sem infra adicional. A exceção ao modelo BFF é pontual (só o PUT dos bytes) — a Fase 04, ao desenhar a tela de upload, decide como orquestrar isso a partir de Route Handlers que só repassam as presigned URLs recebidas da API.

**Decision:** A (Multipart upload com presigned URLs por parte)

**Revisions:**
- 2026-08-22 — Upload acima de 10GB é rejeitado antes de iniciar: API valida o tamanho declarado no pré-cadastro do rascunho e retorna 413 antes de chamar `CreateMultipartUpload`. Rationale: evita reservar recursos de storage (bucket, multipart upload id) pra um upload que já se sabe que vai violar o limite do projeto.

---

## TD-06: Streaming & Download Delivery Mechanism

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo), Download do vídeo pelo usuário

**Context:** Define como o vídeo processado chega até o player/download do usuário: se o `nestjs-api` faz proxy dos bytes (com suporte a `Range` para seek do player) ou se apenas redireciona pro storage.

**Options:**

### Option A: Presigned GET URL (API redireciona/retorna URL temporária do storage)
- Endpoint de vídeo retorna uma presigned URL de leitura; o player/download consome direto do MinIO/S3, que já suporta `Range` requests nativamente.
- **Pros:** zero bytes de vídeo passam pela API — sem custo de CPU/banda no `nestjs-api` pra servir GBs de vídeo; storage S3-compatible já implementa `Range` corretamente.
- **Cons:** expõe a URL do storage (mesmo que temporária) diretamente ao cliente; requer expiração/renovação de URL coordenada com o tempo de visualização.

### Option B: Proxy de bytes pela API (`StreamableFile` do NestJS repassando o storage, com suporte a `Range`)
- API abre um stream de leitura do storage e repassa a resposta HTTP ao cliente, implementando `Accept-Ranges`/`Content-Range` manualmente.
- **Pros:** URL do storage nunca é exposta; API controla totalmente o acesso por request.
- **Cons:** todo GB de vídeo assistido/baixado passa pela API — contradiz a mesma preocupação de performance que motivou TD-05 (não travar o sistema), agora no caminho de leitura em vez de escrita.

**Recommendation:** Option A (presigned GET URL) — consistente com a decisão de TD-05 de manter bytes fora do caminho crítico da API; o storage S3-compatible já resolve `Range` requests corretamente, e presigned URLs com expiração curta mitigam a exposição direta.

**Decision:** A (Presigned GET URL)

**Revisions:**
- 2026-08-22 — Endpoints de streaming e download são públicos (`@Public()`, sem JWT). Rationale: consistente com o requisito "acesso anônimo" documentado na visão geral do projeto (`docs/project-plan.md` § 1 — "qualquer pessoa pode assistir vídeos sem cadastro"); a presigned URL já tem expiração curta como camada de proteção.

---

## TD-07: Video Entity Primary Key / URL Identifier Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Define o identificador que compõe a URL única do vídeo (ex: `/videos/:id`, e as chaves usadas nos objetos do storage em TD-01). `users`, `channels`, `refresh_token` e `verification_token` já usam `@PrimaryGeneratedColumn('uuid')` como convenção estabelecida (`.claude/skills/typeorm/rules/entity-primary-key-strategy.md` recomenda uuid justamente para "public-facing IDs, API resources" e desaconselha auto-increment nesse caso: "Exposing sequential IDs in a public API — security concern").

**Options:**

### Option A: UUID (`@PrimaryGeneratedColumn('uuid')`), mesmo padrão de `users`/`channels`
- PK do vídeo é um uuid v4 gerado pelo Postgres, usado como identificador na URL e nas chaves de objeto do storage.
- **Pros:** consistente com toda entidade já existente no projeto; não-enumerável (não vaza contagem de vídeos nem permite iterar URLs sequencialmente); zero decisão nova de infraestrutura.
- **Cons:** URL menos amigável/legível que um slug curto.

### Option B: Auto-increment integer
- PK numérica sequencial.
- **Pros:** URL mais curta, índice de PK menor.
- **Cons:** enumerável — expõe contagem total de vídeos e permite varrer `/videos/1`, `/videos/2`, ... para descobrir vídeos unlisted; a própria convenção interna do projeto (`entity-primary-key-strategy.md`) marca esse padrão como "Incorrect" para recursos públicos de API; quebraria a garantia de "vídeos unlisted acessíveis apenas via link direto" que a Fase 05 requer.

**Recommendation:** Option A (UUID) — é a única opção consistente com a convenção já estabelecida em todas as entidades do projeto e com o requisito (Fase 05) de vídeos unlisted não-descobríveis por enumeração; Option B é tecnicamente inadequada para este caso de uso, não uma alternativa real.

**Decision:** A (UUID)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object Storage Backend & Client | A (AWS SDK v3) | A (AWS SDK v3) |
| TD-02 | Backend | Background Job Queue Technology | B (pg-boss) | B (pg-boss) |
| TD-03 | Backend | Video Processing Worker Deployment Topology | A (App NestJS standalone separada) | A (App NestJS standalone separada) |
| TD-04 | Backend | Video Metadata & Thumbnail Extraction Tool | A (`fluent-ffmpeg`) | A (`fluent-ffmpeg`) |
| TD-05 | Cross-layer | Large Video Upload Transport Protocol | A (Multipart + presigned URLs) | A (Multipart + presigned URLs) |
| TD-06 | Backend | Streaming & Download Delivery Mechanism | A (Presigned GET URL) | A (Presigned GET URL) |
| TD-07 | Backend | Video Entity Primary Key / URL Identifier Strategy | A (UUID) | A (UUID) |

