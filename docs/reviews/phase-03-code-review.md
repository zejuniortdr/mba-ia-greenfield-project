# Code Review — branch `feature/phase-03-upload-processing` (/code-review high)

Escopo: diff commitado até SI-03.7 + fix da regressão de DI da SI-03.5 (commits `f97896d`..`16ca157`).

**Status:** itens 1, 2, 4, 5, 6, 7 corrigidos. Item 3 (dependência `fluent-ffmpeg`) deixado como está — decisão já coberta por TD-04, fora do escopo de um fix isolado de review. `make test` (164/164) e `npx tsc --noEmit` passando após as correções.

## 1. `getObject` carrega o arquivo inteiro em memória

**Arquivo:** `nestjs-project/src/storage/storage.service.ts:93-101`

```typescript
async getObject(key: string): Promise<Buffer> {
  const response = await this.client.send(
    new GetObjectCommand({ Bucket: this.bucket, Key: key }),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
```

**Problema:** `MAX_VIDEO_SIZE_BYTES` (10GB, `videos.constants.ts`) é tamanho de upload suportado, mas o limite de `Buffer` do Node (~4GB em builds 64-bit) fica abaixo disso — processar um vídeo acima de ~4GB estoura `RangeError` na hora. Mesmo abaixo desse teto, o worker container corre risco de OOM segurando ~2x o tamanho do arquivo em RAM (array de chunks + buffer concatenado).

**Sugestão:** usar stream direto pro disco (`stream/promises.pipeline(response.Body, fs.createWriteStream(...))`) em vez de bufferizar tudo antes de escrever.

---

## 2. `catch` de `process()` pode rejeitar mesmo sendo background task

**Arquivo:** `nestjs-project/src/videos/video-processing.service.ts:67-73`

```typescript
} catch (error) {
  this.logger.error(
    `Failed to process video ${videoId}`,
    error instanceof Error ? error.stack : String(error),
  );
  video.status = VideoStatus.FAILED;
  await this.videoRepository.save(video);
} finally {
```

**Problema:** `.claude/rules/nestjs-services.md` permite catch-and-log sem relançar só em background tasks/event handlers, exatamente o caso documentado no `progress.md` pra este serviço. Mas o `save` de status `failed` dentro do catch não tem proteção própria — se ele falhar (erro transitório de DB, conexão caiu, violação de constraint), a exceção escapa de `process()`, que `worker.main.ts` aguarda direto dentro do handler do pg-boss, quebrando o contrato de "nunca rejeitar".

**Sugestão:** envolver o `save` de fallback em try/catch próprio, logando se também falhar, sem deixar propagar.

---

## 3. `fluent-ffmpeg` é dependência deprecated, evitável

**Arquivo:** `nestjs-project/package.json:46` (e `package-lock.json:5183`)

```json
"fluent-ffmpeg": "^2.1.3",
```

**Problema:** `package-lock.json` marca `fluent-ffmpeg` como `deprecated: Package no longer supported` e traz `async@0.2.10` (release de ~2013) como dependência transitiva obrigatória. O próprio `video-processing.service.integration-spec.ts` (helper `generateTestVideo`) já chama `ffmpeg` direto via `execFileAsync` (`promisify(execFile)`), sem dependência nova, provando que o caminho stdlib já funciona neste mesmo diff. Contraria a preferência global de "stdlib antes de nova dependência" (ponytail).

**Sugestão:** avaliar substituir `fluent-ffmpeg` por `child_process.execFile` direto pro `ffprobe`/`ffmpeg -ss`, removendo a dependência deprecated.

> Nota: essa decisão seguiu TD-04 (Option A, `fluent-ffmpeg`), que já pesou esse trade-off explicitamente. Reabrir requer nova revisão da TD, não é fix isolado.

---

## 4. Fallback de `duration` para `0` mascara dado ausente

**Arquivo:** `nestjs-project/src/videos/video-processing.service.ts:88`

```typescript
resolve(metadata.format.duration ?? 0);
```

**Problema:** `?? 0` só cobre `null`/`undefined`; um vídeo cujo container não carrega duração nos metadados (mp4 fragmentado, gravação ao vivo, encode fora do padrão) faz `ffprobe` retornar sem o campo `duration`, sem erro algum. O serviço cai no ramo de vídeo curto, extrai thumbnail do frame 0 e salva `status: ready` com `duration_seconds: 0` — dado errado persistido silenciosamente. Não há teste cobrindo esse caso (só "vídeo curto de verdade" e "ffprobe lança erro").

**Sugestão:** tratar `duration` ausente como falha explícita (cai no `catch`, marca `failed`) em vez de fallback silencioso pra `0`.

---

## 5. `getObject` reimplementa helper que o SDK já expõe

**Arquivo:** `nestjs-project/src/storage/storage.service.ts:98`

```typescript
for await (const chunk of response.Body as AsyncIterable<Buffer>) {
```

**Problema:** `@aws-sdk/client-s3` (`^3.1116.0`, já instalado) expõe `response.Body.transformToByteArray()` há anos, feito exatamente pra substituir esse padrão for-await/`Buffer.concat`. Usar o helper também remove o cast `as AsyncIterable<Buffer>` sem checagem nesta mesma linha. Não resolve sozinho o problema de memória do item 1, mas é código duplicado que a dependência já instalada resolve.

**Sugestão:** trocar pelo helper nativo do SDK (ainda sujeito à resolução de streaming do item 1 pra arquivos grandes).

---

## 6. `response.Body` sem guarda pra body ausente/vazio

**Arquivo:** `nestjs-project/src/storage/storage.service.ts:98`

```typescript
for await (const chunk of response.Body as AsyncIterable<Buffer>) {
```

**Problema:** se o backend S3-compatible retornar `Body` undefined/vazio (objeto de 0 bytes, stream já consumida, particularidade do backend), `for await` de `undefined` estoura `TypeError: undefined is not async iterable` — genérico. `video-processing.service.ts` ainda marca `failed` no catch externo, mas o stack logado é um erro de iteração de stream confuso em vez de "objeto ausente no storage", dificultando diagnóstico nos logs do worker.

**Sugestão:** checar `response.Body` antes do loop e lançar erro de domínio claro (`Object not found` / `Empty object body`) se ausente.

---

## 7. Cast de `storage_key` esconde o caso nulo

**Arquivo:** `nestjs-project/src/videos/video-processing.service.ts:47`

```typescript
const originalBuffer = await this.storageService.getObject(
  video.storage_key as string,
);
```

**Problema:** `Video.storage_key` é `string | null` (`video.entity.ts`). Se `process()` rodar pra um vídeo que chegou no estado de processamento sem upload completo (enqueue incorreto, job reprocessado, race com `initiateUpload`), `getObject` recebe `Key: null` e falha com erro de validação do SDK opaco em vez de uma falha de domínio clara ("vídeo sem storage_key"). Resultado final é o mesmo (`failed`), mas a causa raiz fica escondida atrás de um erro de SDK sem relação aparente nos logs.

**Sugestão:** checar `video.storage_key` antes de chamar `getObject` e logar/falhar com mensagem explícita se nulo, em vez de cast silencioso.

---

## Resumo

| # | Severidade | Arquivo:linha | Resumo |
|---|---|---|---|
| 1 | Alta | storage.service.ts:93 | Buffer inteiro em memória — quebra em vídeos grandes / risco de OOM |
| 2 | Média | video-processing.service.ts:72 | `save` de fallback no catch pode rejeitar e quebrar contrato "nunca crasha" |
| 3 | Baixa | package.json:46 | Dependência deprecated evitável (decisão já coberta por TD-04) |
| 4 | Média | video-processing.service.ts:88 | Fallback `duration ?? 0` mascara metadado ausente |
| 5 | Baixa | storage.service.ts:98 | Reimplementa helper nativo do SDK (`transformToByteArray`) |
| 6 | Baixa | storage.service.ts:98 | Sem guarda pra `Body` ausente/vazio |
| 7 | Baixa | video-processing.service.ts:47 | Cast de `storage_key` esconde caso nulo |

Nenhum item bloqueou o `make test` (164/164 passando) nem o typecheck antes do fix — eram melhorias de robustez, não regressões funcionais.

## Fixes aplicados

- **Item 1** — novo `StorageService.downloadToFile(key, destinationPath)` (stream direto pro disco via `pipeline`), usado em `VideoProcessingService.process` no lugar de `getObject` + `writeFile`. Vídeo original não passa mais inteiro por memória.
- **Item 2** — `save` de fallback no `catch` de `process()` agora tem try/catch próprio, logando e não relançando se também falhar.
- **Item 4** — `probeDuration` rejeita explicitamente quando `ffprobe` não retorna `duration` (antes: fallback silencioso pra `0`).
- **Item 5** — `getObject` agora usa `response.Body.transformToByteArray()` (helper nativo do SDK) em vez de `for await`/`Buffer.concat` manual.
- **Item 6** — `getObject` e `downloadToFile` lançam erro explícito se `response.Body` vier ausente.
- **Item 7** — `VideoProcessingService.process` valida `video.storage_key` antes de baixar (lança erro de domínio claro em vez de cast `as string`).
- **Item 3** — não alterado (fora de escopo, ver nota acima).
