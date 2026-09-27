import pg from "pg";
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { detectSeniority, detectVisaSupport, stripHtml, type ArbeitnowJob } from "./classify.js";

const ARBEITNOW_API = "https://www.arbeitnow.com/api/job-board-api";
const PAGES = Number(process.env.INGEST_PAGES ?? 4);
const INTERVAL_MS = Number(process.env.INGEST_INTERVAL_MS ?? 15 * 60 * 1000);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });

async function ensureQueue(): Promise<string> {
  const res = await sqs.send(
    new CreateQueueCommand({ QueueName: process.env.SQS_QUEUE_NAME ?? "job-indexing" }),
  );
  if (!res.QueueUrl) throw new Error("Could not create/resolve SQS queue");
  return res.QueueUrl;
}

async function fetchPage(page: number): Promise<ArbeitnowJob[]> {
  const res = await fetch(`${ARBEITNOW_API}?page=${page}`);
  if (!res.ok) throw new Error(`arbeitnow page ${page}: HTTP ${res.status}`);
  const body = (await res.json()) as { data: ArbeitnowJob[] };
  return body.data ?? [];
}

async function ingestOnce(queueUrl: string): Promise<void> {
  let inserted = 0;
  let seen = 0;

  for (let page = 1; page <= PAGES; page++) {
    const jobs = await fetchPage(page);
    seen += jobs.length;

    for (const job of jobs) {
      const description = stripHtml(job.description).slice(0, 8000);
      const result = await pool.query<{ id: number }>(
        `INSERT INTO jobs (external_id, title, company, location, remote, visa_sponsorship, seniority, tags, url, description, posted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11))
         ON CONFLICT (external_id) DO NOTHING
         RETURNING id`,
        [
          job.slug,
          job.title,
          job.company_name,
          job.location,
          job.remote,
          detectVisaSupport(job, description),
          detectSeniority(job.title),
          // Lower-cased so the skills filter can use indexed array containment (tags @> ARRAY['python']).
          Array.from(new Set(job.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))),
          job.url,
          description,
          job.created_at,
        ],
      );

      // Event-driven handoff: only NEW jobs trigger an indexing message.
      // Note: node-postgres returns BIGSERIAL as a string — coerce to number.
      if (result.rows[0]) {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify({ type: "job.created", jobId: Number(result.rows[0].id) }),
          }),
        );
        inserted++;
      }
    }
  }

  console.log(`[ingester] scanned ${seen} jobs, ${inserted} new → queued for indexing`);
}

/**
 * Reconciler: SQS delivery is at-least-once, but messages can still be lost to
 * consumer crashes or queue restarts (ElasticMQ is in-memory). Any job still
 * unindexed after a grace period gets re-queued. Indexing is idempotent, so
 * occasional duplicate messages are harmless.
 */
async function requeueUnindexed(queueUrl: string): Promise<void> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM jobs
     WHERE embedding IS NULL AND created_at < now() - interval '5 minutes'`,
  );
  for (const row of rows) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ type: "job.created", jobId: Number(row.id) }),
      }),
    );
  }
  if (rows.length > 0) {
    console.log(`[ingester] reconciler: re-queued ${rows.length} unindexed jobs`);
  }
}

/**
 * Derived fields get backfilled at startup so a schema change never requires
 * re-ingesting. Rows the classifier can't place stay NULL and are re-checked
 * next boot — cheap, and it means a better regex tomorrow applies to old rows.
 */
async function backfillSeniority(): Promise<void> {
  const { rows } = await pool.query<{ id: string; title: string }>(
    "SELECT id, title FROM jobs WHERE seniority IS NULL",
  );
  let updated = 0;
  for (const row of rows) {
    const level = detectSeniority(row.title);
    if (!level) continue;
    await pool.query("UPDATE jobs SET seniority = $1 WHERE id = $2", [level, Number(row.id)]);
    updated++;
  }
  if (rows.length > 0) {
    console.log(`[ingester] backfill: classified seniority for ${updated}/${rows.length} unlabelled jobs`);
  }
}

/**
 * Re-clean descriptions that still contain markup or entities (ingested before
 * the double-encoding fix). Clearing the embedding hands the row back to the
 * reconciler, which re-queues it for indexing — no special re-embed path needed.
 */
async function backfillDescriptions(): Promise<void> {
  const { rows } = await pool.query<{ id: string; description: string }>(
    String.raw`SELECT id, description FROM jobs
               WHERE description ~ '<[a-zA-Z][^>]*>|&#?[a-zA-Z0-9]+;'`,
  );
  for (const row of rows) {
    await pool.query(
      "UPDATE jobs SET description = $1, embedding = NULL, indexed_at = NULL WHERE id = $2",
      [stripHtml(row.description).slice(0, 8000), Number(row.id)],
    );
  }
  if (rows.length > 0) {
    console.log(`[ingester] backfill: re-cleaned ${rows.length} descriptions, queued for re-embedding`);
  }
}

async function main(): Promise<void> {
  const queueUrl = await ensureQueue();
  await backfillSeniority();
  await backfillDescriptions();
  console.log(`[ingester] queue ready: ${queueUrl}, polling arbeitnow every ${INTERVAL_MS / 60000} min`);

  for (;;) {
    try {
      await ingestOnce(queueUrl);
      await requeueUnindexed(queueUrl);
    } catch (err) {
      console.error("[ingester] ingest failed:", err);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
