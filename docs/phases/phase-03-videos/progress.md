# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

### SI-03.1 — Infra: storage client (AWS SDK v3) + módulo
- **Status:** completed
- **Tests:** 3 passing
- **Observations:**
  - `.env` não existia no repo (apenas `.env.example`); criei `nestjs-project/.env` (gitignored) copiando o example, necessário pra rodar qualquer coisa localmente.
  - `.env`/`.env.example`: `MAIL_FROM` tinha bug de quoting (`"StreamTube" <...>` quebra o parser de shell/dotenv, já documentado em `nestjs-project/CLAUDE.md`) — corrigido pra `"StreamTube <...>"` nos dois arquivos.
  - Adicionei serviços `minio` + `minio-init` (cria o bucket `streamtube-videos`) ao `compose.yaml`, fora do escopo literal da SI mas necessário pra ela funcionar (TD-01 já previa MinIO como container planejado).

### SI-03.2 — Infra: fila pg-boss + módulo
- **Status:** completed
- **Tests:** 1 passing
- **Observations:**
  - `QueueService.publish`/`subscribe` chamam `boss.createQueue(name)` (idempotente) antes de `send`/`work` — pg-boss v10 exige a fila criada explicitamente antes de publicar/consumir, diferente de versões anteriores da lib.
  - Achado (fora de escopo, não corrigido): `src/database/migrations.integration-spec.ts` tem bug pré-existente — seu `beforeAll` dropa as tabelas via `CASCADE` mas nunca dropa o enum `verification_tokens_type_enum`; contra um banco já migrado (estado normal de dev/CI após `migration:run`), a re-execução da migration `CreateAuthTokens` falha com `type "verification_tokens_type_enum" already exists`. Reproduzido em um schema limpo remigrado do zero, não é causado por esta SI. Corrigi o efeito colateral no banco local (tabelas ficavam órfãs após a falha) restaurando via `migration:run`, mas não alterei o arquivo de teste — sugiro task separada pra corrigir o `beforeAll`/`afterAll` desse spec.

### SI-03.3 — Entity Video + migration
- **Status:** completed
- **Tests:** 6 passing
- **Observations:**
  - Schema: `id`(uuid), `channel_id`(uuid, FK -> channels), `title`(varchar 100), `description`(text, null), `status`(enum draft/processing/ready/failed, default draft — TD-05 rascunho), `size_bytes`(bigint, declarado no pré-cadastro), `storage_key`/`thumbnail_key`/`upload_id`(varchar, null — preenchidos pelo fluxo de upload/worker), `duration_seconds`(int, null — preenchido pelo worker, TD-04), `created_at`/`updated_at`.
  - PK mantida como UUID random (TD-07); ULID considerado e descartado — sequencial demais, conflita com requisito de não-enumerabilidade de vídeos unlisted.
  - `VideosModule` criado minimal (só `TypeOrmModule.forFeature([Video])`, sem service/controller ainda — entram na SI-03.4/03.5).
  - `cleanAllTables` (test helper compartilhado) atualizado pra limpar `videos` também.
  - Bug pré-existente do `migrations.integration-spec.ts` (enum órfão não limpo no `beforeAll`) se manifestou de novo durante a rodada da suíte completa; banco dev ficou inconsistente (tabelas órfãs + `migrations` truncada). Corrigido via reset completo de schema + `migration:run` do zero (mesma rotina da SI-03.2), autorizado pelo usuário. Segue sem fix no arquivo de teste — mesma recomendação de task separada já registrada na SI-03.2.

### SI-03.4 — VideosService: iniciar upload (rascunho + multipart)
- **Status:** completed
- **Tests:** 5 passing (3 unit + 2 integration)
- **Observations:**
  - `CreateVideoDto` usa `title`/`description`/`sizeBytes` (não `originalFilename`/`mimeType` como o spec original previa) — a entidade `Video` (SI-03.3) já foi commitada com `title`/`description`, sem colunas pra nome de arquivo original ou mime type. Adaptado ao schema real.
  - `storage_key` gerado como `videos/{id}/original` (sem extensão, já que `mimeType` não é persistido).
  - Tamanho de parte do multipart fixado em 100MB (`UPLOAD_PART_SIZE_BYTES`) — não havia decisão prévia sobre isso nas TDs; valor conservador dentro dos limites do S3 (mín. 5MB, máx. 10000 partes).
  - `VideoTooLargeException` adicionada ao arquivo compartilhado `common/exceptions/domain.exception.ts`, seguindo o padrão existente (auth) em vez de criar arquivo de exceção por módulo.

### SI-03.5 — VideosController: POST /videos, POST /videos/:id/complete
- **Status:** completed
- **Tests:** 5 passing (e2e)
- **Observations:**
  - Adicionado `ChannelsService.findByUserId(userId)` — não existia método pra resolver o canal do usuário autenticado, necessário pra "dono = canal do usuário" (owner resolution) nos dois endpoints.
  - Spec previa status `draft/uploading` para permitir completar o upload, mas o enum `VideoStatus` real (SI-03.3) só tem `draft/processing/ready/failed` — condição adaptada pra checar apenas `status === DRAFT`.
  - `POST /videos/:id/complete` precisou de `@HttpCode(200)` explícito — default do Nest pra `@Post` é 201, mas o spec define 200 pra esse endpoint.
  - `upload_id` zerado (`null`) ao completar, conforme TD-05 ("cleared after CompleteMultipartUpload").
  - Se `findByUserId` retornar `null` (não deveria acontecer — todo usuário ganha canal automaticamente no registro), lança `Error` genérico (500) em vez de exceção de domínio — não é um caso previsto no Error Catalog da spec, é invariante do sistema.
  - **Regressão encontrada e corrigida durante SI-03.7** (full suite): esta SI adicionou `QueueService` ao construtor de `VideosService` mas não atualizou `videos.service.spec.ts`/`videos.service.integration-spec.ts` com o provider correspondente — 5 testes quebrados por erro de DI (`Nest can't resolve dependencies... QueueService`). Corrigido adicionando mock (`unit`) e `QueueModule` real (`integration`) nesses dois arquivos. Suíte completa voltou a 164/164.

### SI-03.6 — Video Worker: app standalone + consumer da fila
- **Status:** completed
- **Tests:** no tests (SI de infra — comportamento do consumer testado em SI-03.7)
- **Observations:**
  - `WorkerModule` precisou importar `UsersModule` (não só `TypeOrmModule.forFeature([Video])`) — `Video` tem relação com `Channel`, que por sua vez tem relação com `User`; sem o módulo dono de cada entidade relacionada registrado, TypeORM falha em runtime com `Entity metadata for X was not found` (regra de `.claude/rules/nestjs-modules.md`: toda entidade precisa estar registrada via `forFeature` do seu módulo dono). `UsersModule` já importa `ChannelsModule`, então uma única importação resolveu a cadeia toda.
  - Movida a constante `VIDEO_PROCESSING_REQUESTED_EVENT` (antes local em `videos.service.ts`) para `videos.constants.ts`, compartilhada entre produtor (`VideosService`) e consumidor (`worker.main.ts`) — evita duplicar o literal do nome do evento.
  - `start:worker` usa `nest start --watch --entryFile worker.main` (flag `--entryFile` do Nest CLI), espelhando o padrão de `start:dev`.
  - `Dockerfile.worker` roda o processo diretamente (`CMD npm run start:worker`), diferente do `Dockerfile.dev` da API que fica ocioso (`tail -f /dev/null`) — decisão necessária pro worker ser um processo sempre ativo, não uma sessão de dev manual.
  - Verificado empiricamente: subindo o container, o worker consumiu e logou 4 jobs `video.processing.requested` que já estavam na fila desde execuções anteriores dos testes e2e da SI-03.5 — confirma que o consumer registrado via `QueueService.subscribe` funciona de ponta a ponta.
  - Binário `ffmpeg`/`ffprobe` na imagem do worker fica pra SI-03.7 (escopo explícito dessa SI, não desta).

### SI-03.7 — Worker: extração de metadados e thumbnail (fluent-ffmpeg)
- **Status:** completed
- **Tests:** 5 passing (2 unit + 3 integration)
- **Observations:**
  - Binário `ffmpeg` precisou ser instalado também no `Dockerfile.dev` (não só no `Dockerfile.worker`) — a suíte de testes roda dentro do container `nestjs-api` por convenção do projeto (`docker compose exec nestjs-api npm test`), e o teste de integração desta SI chama `ffmpeg`/`ffprobe` de verdade.
  - Adicionado `StorageService.getObject(key)` (download) — não existia método de leitura, só upload/presign; necessário pro `VideoProcessingService` baixar o vídeo original antes de processar.
  - Extraído `calculateThumbnailTimestamp(durationSeconds)` como função pura exportada (10% da duração, fallback 0 pra vídeos <2s) — permite testar a regra de negócio no unit test sem precisar de ffmpeg real ou mocks pesados.
  - Teste de integração gera vídeos sintéticos on-the-fly via `ffmpeg -f lavfi testsrc=...` (sem fixture binário versionado no repo) — evita commitar arquivo de vídeo de teste.
  - `VideoProcessingService.process` segue a regra de "background task" de `.claude/rules/nestjs-services.md`: captura erro, marca `status: failed`, loga e NÃO relança — condizente com o worker não poder cair por causa de um vídeo corrompido (AC explícita da SI).
  - `worker.main.ts` (SI-03.6) atualizado: handler do consumer agora chama `VideoProcessingService.process(videoId)` de verdade, em vez do placeholder de log.

### SI-03.8 — VideosService + Controller: streaming e download público
- **Status:** completed
- **Tests:** 6 passing (e2e — `test/videos-streaming.e2e-spec.ts`)
- **Observations:**
  - Commits: `9d0d724` (`VideosService.getStreamUrl`/`getDownloadUrl`, parte 1), `3152b7f` (`GET /videos/:id/stream-url` e `/download-url` públicos no controller), `0d0ed26` (fix de robustez em `videos.service.ts`).
