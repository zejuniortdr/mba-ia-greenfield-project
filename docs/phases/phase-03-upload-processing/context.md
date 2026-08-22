---
kind: phase
name: phase-03-upload-processing
sources_mtime:
  docs/project-plan.md: "2026-08-22 11:54:26.314722868 -0300"
  docs/decisions/technical-decisions-upload-processing.md: "2026-08-22 12:44:03.661308359 -0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-22 11:54:26.309722837 -0300"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-22 11:54:26.312811778 -0300"
  docs/phases/phase-02-auth/context.md: "2026-08-22 11:54:26.313722861 -0300"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-22 11:54:26.312972498 -0300"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-22 11:54:26.200722161 -0300"
---

# phase-03-upload-processing — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None explicitly mentioned._

**Deferred subprojects:** _None._

**Sequencing notes:** Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — Depende de: Fase 01
- **Phase 04:** Gerenciamento de Vídeos e Canal — Depende de: Fase 02, Fase 03

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| upload-processing/TD-01 | phase | Backend | Object Storage Backend & Client | decided | A (AWS SDK v3) | — |
| upload-processing/TD-02 | phase | Backend | Background Job Queue Technology | decided | B (pg-boss) | — |
| upload-processing/TD-03 | phase | Backend | Video Processing Worker Deployment Topology | decided | A (App NestJS standalone separada) | — |
| upload-processing/TD-04 | phase | Backend | Video Metadata & Thumbnail Extraction Tool | decided | A (fluent-ffmpeg) | — |
|     └─ Last revision: 2026-08-22 — Frame do thumbnail extraído a 10% da duração do vídeo (`ffmpeg -ss {10%*duration… | | | | | | |
| upload-processing/TD-05 | phase | Cross-layer | Large Video Upload Transport Protocol | decided | A (Multipart upload com presigned URLs por parte) | — |
|     └─ Last revision: 2026-08-22 — Upload acima de 10GB é rejeitado antes de iniciar: API valida o tamanho declarad… | | | | | | |
| upload-processing/TD-06 | phase | Backend | Streaming & Download Delivery Mechanism | decided | A (Presigned GET URL) | — |
|     └─ Last revision: 2026-08-22 — Endpoints de streaming e download são públicos (`@Public()`, sem JWT). | | | | | | |
| upload-processing/TD-07 | phase | Backend | Video Entity Primary Key / URL Identifier Strategy | decided | A (UUID) | — |

_Source files:_

- upload-processing — `docs/decisions/technical-decisions-upload-processing.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | upload-processing/TD-01 |
| Serviço de processamento em segundo plano (filas) | upload-processing/TD-02, upload-processing/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | upload-processing/TD-05 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | upload-processing/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | upload-processing/TD-03, upload-processing/TD-04 |
| Geração automática de thumbnail a partir de um frame do vídeo | upload-processing/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | upload-processing/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | upload-processing/TD-06 |
| Download do vídeo pelo usuário | upload-processing/TD-06 |

## Decisions Detail

### upload-processing/TD-01

**Recommendation:** o projeto já documentou MinIO em dev e S3 em prod como o mesmo container lógico; usar o SDK da AWS contra o endpoint do MinIO evita reescrever a camada de storage quando migrar para S3 real, e cobre tanto multipart upload quanto presigned URLs necessários para TD-05.
**Libraries:** —

### upload-processing/TD-02

**Recommendation:** o projeto não tem Redis nem RabbitMQ em nenhuma fase anterior, e o volume de jobs (1 processamento por vídeo enviado) não justifica novo serviço de infra; pg-boss aproveita o Postgres 17 já rodando e mantém o compose enxuto. Se o volume de jobs crescer, é uma decisão revisável (Supersede) nas fases seguintes.
**Libraries:** —

### upload-processing/TD-03

**Recommendation:** mantém a separação já documentada no diagrama de arquitetura e evita que o processamento pesado de ffmpeg compita por CPU/event loop com a API que serve requests HTTP.
**Libraries:** —

### upload-processing/TD-04

**Recommendation:** o README já define FFmpeg como a ferramenta do Video Worker; o wrapper evita reimplementar parsing de comandos/saída do CLI que o `child_process` puro exigiria.
**Libraries:** —

**Revisions:**
- 2026-08-22 — Frame do thumbnail extraído a 10% da duração do vídeo (`ffmpeg -ss {10%*duration}`), com fallback pro frame 0 quando o vídeo for curto demais (<2s) pro cálculo fazer sentido. Rationale: 10% da duração evita frame preto de abertura comum em vídeos, mais representativo que timestamp fixo.

### upload-processing/TD-05

**Recommendation:** é o único caminho que cumpre as duas restrições dos Pontos de Atenção simultaneamente (upload de 10GB sem travar o sistema E retomada por parte após falha), e reaproveita o multipart upload que o AWS SDK v3 (TD-01) já oferece sem infra adicional. A exceção ao modelo BFF é pontual (só o PUT dos bytes) — a Fase 04, ao desenhar a tela de upload, decide como orquestrar isso a partir de Route Handlers que só repassam as presigned URLs recebidas da API.
**Libraries:** —

**Revisions:**
- 2026-08-22 — Upload acima de 10GB é rejeitado antes de iniciar: API valida o tamanho declarado no pré-cadastro do rascunho e retorna 413 antes de chamar `CreateMultipartUpload`. Rationale: evita reservar recursos de storage (bucket, multipart upload id) pra um upload que já se sabe que vai violar o limite do projeto.

### upload-processing/TD-06

**Recommendation:** consistente com a decisão de TD-05 de manter bytes fora do caminho crítico da API; o storage S3-compatible já resolve `Range` requests corretamente, e presigned URLs com expiração curta mitigam a exposição direta.
**Libraries:** —

**Revisions:**
- 2026-08-22 — Endpoints de streaming e download são públicos (`@Public()`, sem JWT). Rationale: consistente com o requisito "acesso anônimo" documentado na visão geral do projeto (`docs/project-plan.md` § 1 — "qualquer pessoa pode assistir vídeos sem cadastro"); a presigned URL já tem expiração curta como camada de proteção.

### upload-processing/TD-07

**Recommendation:** é a única opção consistente com a convenção já estabelecida em todas as entidades do projeto e com o requisito (Fase 05) de vídeos unlisted não-descobríveis por enumeração; Option B é tecnicamente inadequada para este caso de uso, não uma alternativa real.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Namespaced/grouped with registerAs — the project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Shared registerAs factory — natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per rows above. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact created | Required tests |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
