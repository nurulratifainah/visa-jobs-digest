import pg from "pg";
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";

const ARBEITNOW_API = "https://www.arbeitnow.com/api/job-board-api";
const PAGES = Number(process.env.INGEST_PAGES ?? 4);
const INTERVAL_MS = Number(process.env.INGEST_INTERVAL_MS ?? 15 * 60 * 1000);

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number; // unix seconds
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });

async function ensureQueue(): Promise<string> {
  const res = await sqs.send(
    new CreateQueueCommand({ QueueName: process.env.SQS_QUEUE_NAME ?? "job-indexing" }),
  );
  if (!res.QueueUrl) throw new Error("Could not create/resolve SQS queue");
  return res.QueueUrl;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function detectVisaSupport(job: ArbeitnowJob, plainDescription: string): boolean {
  const haystack = `${job.title} ${job.tags.join(" ")} ${plainDescription}`.toLowerCase();
  return /visa sponsorship|visa support|sponsor(s|ing)? (a |your )?visa|relocation (assistance|package|support|bonus)/.test(
    haystack,
  );
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
        `INSERT INTO jobs (external_id, title, company, location, remote, visa_sponsorship, tags, url, description, posted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10))
         ON CONFLICT (external_id) DO NOTHING
         RETURNING id`,
        [
          job.slug,
          job.title,
          job.company_name,
          job.location,
          job.remote,
          detectVisaSupport(job, description),
          job.tags,
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

async function main(): Promise<void> {
  const queueUrl = await ensureQueue();
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
