# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 1/8 completed

### SI-03.1 — Infra: storage client (AWS SDK v3) + módulo
- **Status:** completed
- **Tests:** 3 passing
- **Observations:**
  - `.env` não existia no repo (apenas `.env.example`); criei `nestjs-project/.env` (gitignored) copiando o example, necessário pra rodar qualquer coisa localmente.
  - `.env`/`.env.example`: `MAIL_FROM` tinha bug de quoting (`"StreamTube" <...>` quebra o parser de shell/dotenv, já documentado em `nestjs-project/CLAUDE.md`) — corrigido pra `"StreamTube <...>"` nos dois arquivos.
  - Adicionei serviços `minio` + `minio-init` (cria o bucket `streamtube-videos`) ao `compose.yaml`, fora do escopo literal da SI mas necessário pra ela funcionar (TD-01 já previa MinIO como container planejado).

### SI-03.2 — Infra: fila pg-boss + módulo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Entity Video + migration
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — VideosService: iniciar upload (rascunho + multipart)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — VideosController: POST /videos, POST /videos/:id/complete
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Video Worker: app standalone + consumer da fila
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Worker: extração de metadados e thumbnail (fluent-ffmpeg)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — VideosService + Controller: streaming e download público
- **Status:** pending
- **Tests:** —
- **Observations:** none
