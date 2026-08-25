---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1116.0"
    context7_id: "not fetched — see note below"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1116.0"
    context7_id: "not fetched — see note below"
  pg-boss:
    version: "^10.4.2"
    context7_id: "not fetched — see note below"
  fluent-ffmpeg:
    version: "^2.1.3"
    context7_id: "not fetched — see note below"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-22 12:44:03.661308359 -0300"
---

# phase-03-videos — Library References

**Note:** context7 was not reachable in the session that wrote this file. The APIs below are transcribed directly from the code actually shipped in this phase (`src/storage/storage.service.ts`, `src/queue/queue.service.ts`, `src/videos/video-processing.service.ts`), not cross-checked against upstream docs. Re-fetch via context7 and diff against this file the next time a phase touches these libraries.

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner (v3.1116.0)

Used by `StorageService` (`src/storage/storage.service.ts`) against MinIO (S3-compatible), configured via `storage.config.ts` (`endpoint`, `region`, `forcePathStyle: true`, static credentials).

### Multipart upload (draft → parts → complete)

```typescript
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const client = new S3Client({ endpoint, region, forcePathStyle, credentials });

// 1. Open the upload
const { UploadId } = await client.send(
  new CreateMultipartUploadCommand({ Bucket, Key, ...(contentType && { ContentType: contentType }) }),
);

// 2. Presign a PUT URL per part (client uploads the bytes directly to storage)
const url = await getSignedUrl(
  client,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: partNumber }),
  { expiresIn: 3600 },
);

// 3. Complete once every part has been PUT, using each part's returned ETag
await client.send(
  new CompleteMultipartUploadCommand({
    Bucket, Key, UploadId,
    MultipartUpload: { Parts: parts.map(p => ({ PartNumber: p.partNumber, ETag: p.etag })) },
  }),
);
```

Parts must be sorted ascending by `PartNumber` before `CompleteMultipartUploadCommand` — `StorageService.completeMultipartUpload` does `parts.sort((a, b) => a.partNumber - b.partNumber)` before mapping.

### Reads: streaming download + presigned GET

```typescript
// Server-side download (worker pulls the original file to a temp path before ffmpeg)
const { Body } = await client.send(new GetObjectCommand({ Bucket, Key }));
await pipeline(Body as Readable, createWriteStream(destinationPath)); // Node stream/promises

// Public presigned GET (streaming or download)
const url = await getSignedUrl(
  client,
  new GetObjectCommand({
    Bucket, Key,
    ...(attachment && { ResponseContentDisposition: 'attachment' }),
    ...(contentType && { ResponseContentType: contentType }),
  }),
  { expiresIn: 3600 },
);
```

`GetObjectCommand.Body` on `@aws-sdk/client-s3` v3 is a Node.js `Readable` (not a Web Stream) when running under Node — safe to pipe directly into `fs.createWriteStream`.

### Writes: thumbnail upload

```typescript
await client.send(new PutObjectCommand({ Bucket, Key, Body: buffer, ContentType: contentType }));
```

Used once, by `VideoProcessingService` to upload the ffmpeg-generated thumbnail (`image/jpeg`) after processing.

---

## pg-boss (v10.4.2)

Used by `QueueService` (`src/queue/queue.service.ts`), backed directly by the app's PostgreSQL database (`queue.config.ts` reuses the same `DB_HOST`/`DB_USERNAME`/etc. env vars) — no separate broker/container.

```typescript
import PgBoss from 'pg-boss';

const boss = new PgBoss(config); // { host, port, user, password, database }
await boss.start();  // OnModuleInit
await boss.stop();   // OnModuleDestroy

// Publish
await boss.createQueue(event); // idempotent — must exist before send/work in v10
const jobId = await boss.send(event, payload);

// Subscribe
await boss.createQueue(event);
await boss.work<ReqData>(event, async ([job]) => {
  await handler(job.data);
});
```

**v10 behavior confirmed empirically during this phase (`SI-03.2` progress note):** `createQueue` must be called explicitly before `send`/`work` — pg-boss no longer auto-creates the queue on first publish/subscribe like older versions did. `QueueService` calls it defensively (idempotent) on both `publish` and `subscribe`.

**Not yet used in the shipped code, relevant to D-10:** pg-boss supports per-job `retryLimit`/`retryBackoff` options on `send`/`work`, which is the mechanism the plan (`phase-03-videos.md` → Events/Messages) relies on to describe retry semantics. `QueueService.publish`/`subscribe` do not currently pass these options — see the plan's Events/Messages section and D-10 for the intended transient-vs-definitive-error split.

---

## fluent-ffmpeg (v2.1.3)

Used by `VideoProcessingService` (`src/videos/video-processing.service.ts`) to extract duration metadata and a thumbnail from the downloaded original file. Requires the `ffmpeg`/`ffprobe` binaries on `PATH` (installed in both `Dockerfile.dev` and `Dockerfile.worker` for this phase).

### Probing duration

```typescript
import ffmpeg from 'fluent-ffmpeg';

ffmpeg.ffprobe(inputPath, (err, metadata) => {
  if (err) { /* reject */ }
  const duration = metadata.format.duration; // seconds, number | undefined
});
```

`metadata.format.duration` can come back `undefined`/`null` for malformed input — `VideoProcessingService.probeDuration` treats that as an error rather than defaulting to `0`.

### Extracting a thumbnail

```typescript
ffmpeg(inputPath)
  .on('end', () => resolve())
  .on('error', (err: Error) => reject(err))
  .screenshots({
    timestamps: [timestampSeconds],
    filename: 'thumbnail.jpg',
    folder,
  });
```

`.screenshots()` is callback/event-based, not promise-based — wrapped in a `new Promise` in `extractThumbnail`. The timestamp is computed by the pure helper `calculateThumbnailTimestamp(durationSeconds)`: 10% of duration, or `0` for videos under 2 seconds (avoids seeking past a very short clip).
