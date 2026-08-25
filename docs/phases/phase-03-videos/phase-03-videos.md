---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-22 12:45:43.122930753 -0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-22 12:44:03.661308359 -0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-22 11:54:26.309722837 -0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload resiliente de vídeos até 10GB via multipart + presigned URLs, processamento em background (extração de metadados e thumbnail via ffmpeg), storage S3-compatible (MinIO/AWS SDK v3) e streaming/download público via presigned GET URLs.

---

## Step Implementations

### SI-03.1 — Infra: storage client (AWS SDK v3) + módulo

**Description:** Configurar client S3-compatible (AWS SDK v3) apontando pro MinIO em dev, expor `StorageService` com métodos de multipart upload e presigned URL.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` (per `phase-03-videos/TD-01`)
2. Criar `src/config/storage.config.ts` com `registerAs('storage', ...)` — endpoint, bucket, region, credenciais (segue convenção `registerAs` de `phase-01-configuracao-base/TD-01`/TD-03)
3. Adicionar validação Joi das novas env vars em `src/config/env.validation.ts` (segue `phase-01-configuracao-base/TD-02`)
4. Criar `StorageModule` + `StorageService` (`src/storage/`) encapsulando `S3Client`, com métodos `createMultipartUpload`, `getPresignedPartUrl`, `completeMultipartUpload`, `getPresignedGetUrl`
5. Adicionar serviço `minio` ao `compose.yaml` do `nestjs-project` (imagem `minio/minio`, bucket criado via entrypoint/healthcheck)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: real MinIO local (`testing-guide-nestjs-project` — "Service with side-effect dep (storage) → Integration: real capture service ou local adapter") | `storage.service.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `StorageService.createMultipartUpload` cria um multipart upload real no bucket local e retorna um `uploadId`
- `StorageService.getPresignedPartUrl` retorna uma URL PUT válida que aceita upload de bytes diretamente no MinIO
- `StorageService.getPresignedGetUrl` retorna uma URL GET válida que serve o objeto com suporte a `Range`

---

### SI-03.2 — Infra: fila pg-boss + módulo

**Description:** Configurar pg-boss sobre o Postgres existente, expor `QueueService` pra publicar/consumir jobs de processamento de vídeo.

**Technical actions:**

1. Instalar `pg-boss@^10.x` (per `phase-03-videos/TD-02`)
2. Criar `src/config/queue.config.ts` com `registerAs('queue', ...)` reaproveitando `databaseConfig` (mesma conexão Postgres, per `phase-01-configuracao-base/TD-03`)
3. Criar `QueueModule` + `QueueService` (`src/queue/`) encapsulando instância `PgBoss`, com métodos `publish(event, payload)` e `subscribe(event, handler)`
4. Registrar `QueueModule` como global no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueService` | Integration: real Postgres (pg-boss cria as próprias tabelas) | `queue.service.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `QueueService.publish('video.processing.requested', { videoId })` persiste o job nas tabelas do pg-boss
- Um handler registrado via `QueueService.subscribe` recebe o payload publicado

---

### SI-03.3 — Entity Video + migration

**Description:** Criar a entidade `Video` com os campos definidos no Data Model e sua migration.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos de `## Technical Specifications → Data Model → Video` (`id` uuid PK, `channel_id`, `status`, `storage_key`, `upload_id`, `original_filename`, `mime_type`, `size_bytes`, `duration_seconds`, `thumbnail_key`, timestamps)
2. Definir relação `Video` → `Channel` (many-to-one) reaproveitando a entidade `Channel` existente
3. Gerar migration via `npm run migration:generate` (per convenção `typeorm` do projeto)
4. Registrar `Video` em `TypeOrmModule.forFeature([Video])` no `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, FK pra `Channel` | `video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Migration roda sem erro e cria a tabela `videos` com todas as colunas do Data Model
- Inserir um `Video` sem `channel_id` viola constraint (not null)
- `status` tem default `draft` quando omitido na criação

---

### SI-03.4 — VideosService: iniciar upload (rascunho + multipart)

**Description:** Implementar a lógica de criação do rascunho de vídeo e início do multipart upload, incluindo a validação de tamanho máximo.

**Technical actions:**

1. Criar `CreateVideoDto` (`title`, `description?`, `sizeBytes`) com `class-validator` (per `phase-02-auth/TD-06`)
2. Criar exceção de domínio `VideoTooLargeException` (413) mapeada no exception filter existente (per `phase-02-auth/TD-07`)
3. Implementar `VideosService.initiateUpload(channelId, dto)`: valida `sizeBytes <= 10737418240` (senão lança `VideoTooLargeException`, per `phase-03-videos/TD-05` revision 2026-08-22), cria `Video` com `status: 'draft'`, chama `StorageService.createMultipartUpload` + `getPresignedPartUrl` por parte (per `phase-03-videos/TD-01`, `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: branch logic de validação de tamanho (mock repo + mock `StorageService`) | `videos.service.spec.ts` |
| `VideosService` | Integration: criação do rascunho no banco | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.3

**Acceptance criteria:**

- `initiateUpload` com `sizeBytes` acima de 10GB lança `VideoTooLargeException` sem criar registro no banco
- `initiateUpload` com `sizeBytes` válido cria um `Video` com `status: 'draft'` e retorna `uploadId` + lista de partes com URLs presigned

---

### SI-03.5 — VideosController: POST /videos, POST /videos/:id/complete

**Description:** Expor os endpoints HTTP de início e conclusão do upload.

**Technical actions:**

1. Criar `VideosController` com `POST /videos` (per `## Technical Specifications → API Contracts`), protegido pelo `JwtAuthGuard` global (autenticado, dono = canal do usuário)
2. Implementar `POST /videos/:id/complete`: busca `Video` por `id` + `channel_id` do usuário autenticado (404 `VIDEO_NOT_FOUND` se não achar ou não pertencer), valida que `status` ainda é `draft`/`uploading` (409 `VIDEO_UPLOAD_ALREADY_COMPLETED` se já processado), chama `StorageService.completeMultipartUpload`, atualiza `status: 'processing'`, publica `video.processing.requested` via `QueueService` (per `phase-03-videos/TD-02`)
3. Adicionar decorators `@ApiOperation`/`@ApiResponse` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosController` | E2E: 201 happy path, 413 tamanho excedido, 404 vídeo não encontrado, 409 upload já completado | `videos.e2e-spec.ts` |

**Dependencies:** SI-03.4, SI-03.2

**Acceptance criteria:**

- `POST /videos` com corpo válido retorna `201` com `{ id, uploadId, parts }`
- `POST /videos` com `sizeBytes` acima de 10GB retorna `413` com `VIDEO_TOO_LARGE`
- `POST /videos/:id/complete` com `id` inexistente retorna `404` com `VIDEO_NOT_FOUND`
- `POST /videos/:id/complete` bem-sucedido publica o evento `video.processing.requested` na fila e atualiza `status` para `processing`
- `POST /videos/:id/complete` chamado duas vezes no mesmo vídeo retorna `409` com `VIDEO_UPLOAD_ALREADY_COMPLETED` na segunda chamada

---

### SI-03.6 — Video Worker: app standalone + consumer da fila

**Description:** Criar a segunda entrypoint Nest do worker, container próprio, consumindo o evento de processamento.

**Technical actions:**

1. Criar `src/worker.main.ts` com `NestFactory.createApplicationContext(WorkerModule)` (per `phase-03-videos/TD-03`)
2. Criar `WorkerModule` importando `QueueModule`, `StorageModule`, `TypeOrmModule.forFeature([Video])`
3. Registrar consumer via `QueueService.subscribe('video.processing.requested', handler)` no bootstrap do worker
4. Adicionar `Dockerfile.worker` (ou target multi-stage) + serviço `video-worker` no `compose.yaml`, dependente de `db` e `minio`
5. Adicionar script `start:worker` no `package.json`

**Tests:** _(empty — Infra; comportamento do consumer testado em SI-03.7)_

**Dependencies:** SI-03.2, SI-03.1

**Acceptance criteria:**

- Container `video-worker` sobe e se conecta ao Postgres e ao MinIO
- Publicar um evento `video.processing.requested` na fila aciona o handler registrado no worker

---

### SI-03.7 — Worker: extração de metadados e thumbnail (fluent-ffmpeg)

**Description:** Implementar o handler que processa o vídeo — extrai duração/metadados e gera o thumbnail.

**Technical actions:**

1. Instalar `fluent-ffmpeg@^2.x` + binário `ffmpeg`/`ffprobe` na imagem Docker do worker (`Dockerfile.worker`, per `phase-03-videos/TD-04`)
2. Implementar `VideoProcessingService.process(videoId)`: baixa/lê o vídeo do storage, roda `ffprobe` pra extrair `duration_seconds`, roda `ffmpeg -ss {10% da duração}` pra extrair o frame de thumbnail com fallback pro frame 0 se o vídeo tiver menos de 2s (per `phase-03-videos/TD-04` revision 2026-08-22)
3. Fazer upload do thumbnail gerado pro storage via `StorageService` (per `phase-03-videos/TD-01`) e salvar `thumbnail_key`
4. Atualizar `Video.status` para `ready` ao final, ou `failed` em caso de erro no processamento

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: cálculo do timestamp de thumbnail (10% da duração, fallback <2s) | `video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration: processamento completo contra um vídeo de teste real (ffmpeg + MinIO local) | `video-processing.service.integration-spec.ts` |

**Dependencies:** SI-03.6, SI-03.1

**Acceptance criteria:**

- Processar um vídeo válido atualiza `duration_seconds`, `thumbnail_key` e `status: 'ready'`
- O timestamp do frame extraído é 10% da duração do vídeo
- Um vídeo com menos de 2 segundos usa o frame 0 como thumbnail
- Falha no processamento (ex: arquivo corrompido) marca `status: 'failed'` sem derrubar o worker

---

### SI-03.8 — VideosService + Controller: streaming e download público

**Description:** Expor os endpoints públicos de streaming e download via presigned GET URL.

**Technical actions:**

1. Implementar `VideosService.getStreamUrl(id)` / `getDownloadUrl(id)`: busca o `Video`, valida `status: 'ready'` (senão 409 `VIDEO_UPLOAD_NOT_COMPLETE`), gera presigned GET URL via `StorageService` (com `Content-Disposition: attachment` pro download)
2. Adicionar `GET /videos/:id/stream-url` e `GET /videos/:id/download-url` no `VideosController`, marcados `@Public()` (per `phase-03-videos/TD-06` revision 2026-08-22)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosController` | E2E: 200 com URL presigned, 404 vídeo inexistente, 409 vídeo ainda não pronto, acesso sem token (anônimo) retorna 200 | `videos-streaming.e2e-spec.ts` |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `GET /videos/:id/stream-url` sem token de autenticação retorna `200` com `{ url, expiresAt }`
- `GET /videos/:id/download-url` retorna uma URL com `Content-Disposition: attachment`
- Chamar qualquer um dos dois endpoints antes do vídeo atingir `status: 'ready'` retorna `409` com `VIDEO_UPLOAD_NOT_COMPLETE`
- `id` inexistente retorna `404` com `VIDEO_NOT_FOUND`

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated _(per phase-03-videos/TD-07)_ |
| channel_id | uuid | FK → Channel, not null |
| status | varchar | not null, default `draft` — one of `draft \| uploading \| processing \| ready \| failed` |
| storage_key | varchar | not null — object key of the final video file in the bucket _(per phase-03-videos/TD-01)_ |
| upload_id | varchar | nullable — S3 multipart upload id, cleared after `CompleteMultipartUpload` _(per phase-03-videos/TD-05)_ |
| original_filename | varchar | not null |
| mime_type | varchar | not null |
| size_bytes | bigint | not null — validated ≤ 10GB before upload starts _(per phase-03-videos/TD-05 revision 2026-08-22)_ |
| duration_seconds | integer | nullable — populated after processing _(per phase-03-videos/TD-04)_ |
| thumbnail_key | varchar | nullable — object key of the generated thumbnail, frame at 10% da duração _(per phase-03-videos/TD-04 revision 2026-08-22)_ |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), updated on change |

**Relations:** `Video` belongs to `Channel` (many-to-one)
**Indexes:** index on `channel_id` (listing videos by channel)

---

### API Contracts

#### POST /videos (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- title: string, required — max 100 chars
- description: string, optional
- sizeBytes: number, required — max 10737418240 (10GB)

**Response 201:**
- id: string (uuid)
- uploadId: string
- parts: array of { partNumber: number, url: string } — presigned PUT URLs, uma por parte do multipart upload

**Error responses:**
- 413 VIDEO_TOO_LARGE: quando `sizeBytes` excede 10GB
- 400 validation error: quando o corpo da requisição falha na validação de schema

---

#### POST /videos/:id/complete (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array of { partNumber: number, etag: string }, required

**Response 200:**
- id: string (uuid)
- status: string (`processing`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando `:id` não existe ou não pertence ao canal do usuário autenticado
- 409 VIDEO_UPLOAD_ALREADY_COMPLETED: quando o upload desse vídeo já foi completado antes
- 400 validation error: quando o corpo da requisição falha na validação de schema

---

#### GET /videos/:id/stream-url (SI-03.8)

**Response 200:**
- url: string — presigned GET URL do storage, com suporte a `Range` requests _(per phase-03-videos/TD-06)_
- expiresAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando `:id` não existe
- 409 VIDEO_UPLOAD_NOT_COMPLETE: quando o vídeo ainda não está com status `ready`

---

#### GET /videos/:id/download-url (SI-03.8)

**Response 200:**
- url: string — presigned GET URL do storage, com `Content-Disposition: attachment`
- expiresAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando `:id` não existe
- 409 VIDEO_UPLOAD_NOT_COMPLETE: quando o vídeo ainda não está com status `ready`

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | — _(vídeo criado no canal do usuário autenticado)_ |
| POST /videos/:id/complete | ✗ | ✓ | ✓ _(apenas o canal dono do vídeo)_ |
| GET /videos/:id/stream-url | ✓ | ✓ | — _(público — per phase-03-videos/TD-06 revision 2026-08-22, consistente com acesso anônimo do projeto)_ |
| GET /videos/:id/download-url | ✓ | ✓ | — _(público — per phase-03-videos/TD-06 revision 2026-08-22)_ |

_POST /videos e POST /videos/:id/complete exigem autenticação por necessidade estrutural — o rascunho do vídeo é criado no canal do usuário autenticado (nenhuma TD decidiu isso explicitamente; é consequência direta de um vídeo pertencer a um canal, que por sua vez pertence a um usuário)._

---

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_TOO_LARGE | 413 | POST /videos quando `sizeBytes` excede 10GB (per phase-03-videos/TD-05 revision 2026-08-22) |
| VIDEO_NOT_FOUND | 404 | Operação referenciando `:id` que não existe ou não pertence ao usuário autenticado |
| VIDEO_UPLOAD_ALREADY_COMPLETED | 409 | POST /videos/:id/complete chamado em vídeo cujo upload já foi completado |
| VIDEO_UPLOAD_NOT_COMPLETE | 409 | GET stream-url ou download-url chamado antes do vídeo atingir status `ready` |

_Formato de erro herdado de `phase-02-auth/TD-07` — `{ statusCode, error, message }`._

---

### Events/Messages

#### video.processing.requested

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per phase-03-videos/TD-05)
**Consumer:** `VideoProcessingWorker` (per phase-03-videos/TD-03)
**Trigger:** disparado quando `POST /videos/:id/complete` completa com sucesso o multipart upload no storage
**Delivery semantics:** o handler distingue erro transitório de erro definitivo (per phase-03-videos/TD-02): falha transitória (ex.: storage indisponível, timeout de rede) relança o erro, e o pg-boss reenfileira o job via `retryLimit`/`retryBackoff`; erro definitivo (ex.: arquivo corrompido, ffprobe sem duração) é capturado, marca o vídeo como `failed` e não é relançado — o job é dado como concluído, sem retry.

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root — storage client)
├── SI-03.4 — depends on SI-03.1 + SI-03.3
│   └── SI-03.5 — depends on SI-03.4 + SI-03.2
├── SI-03.6 — depends on SI-03.1 + SI-03.2
│   └── SI-03.7 — depends on SI-03.6 + SI-03.1
│       └── SI-03.8 — depends on SI-03.7
SI-03.2 (root — queue)
SI-03.3 (root — Video entity)
```

---

## Deliverables

- [x] SI-03.1 — Infra: storage client (AWS SDK v3) + módulo
- [x] SI-03.2 — Infra: fila pg-boss + módulo
- [x] SI-03.3 — Entity Video + migration
- [x] SI-03.4 — VideosService: iniciar upload (rascunho + multipart)
- [x] SI-03.5 — VideosController: POST /videos, POST /videos/:id/complete
- [x] SI-03.6 — Video Worker: app standalone + consumer da fila
- [x] SI-03.7 — Worker: extração de metadados e thumbnail (fluent-ffmpeg)
- [x] SI-03.8 — VideosService + Controller: streaming e download público

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
