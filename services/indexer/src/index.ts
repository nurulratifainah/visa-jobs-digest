import pg from "pg";
import {
  SQSClient,
  CreateQueueCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { pipeline, env as hfEnv } from "@xenova/transformers";

// Model files are cached in a shared Docker volume so api/indexer download once.
if (process.env.MODEL_CACHE_DIR || process.env.NODE_ENV === "production") {
  hfEnv.cacheDir = process.env.MODEL_CACHE_DIR ?? "/models";
}

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2"; // 384-dim, runs locally on CPU

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });

type Embedder = (text: string, opts: object) => Promise<{ data: Float32Array }>;

async function ensureQueue(): Promise<string> {
  const res = await sqs.send(
    new CreateQueueCommand({ QueueName: process.env.SQS_QUEUE_NAME ?? "job-indexing" }),
  );
  if (!res.QueueUrl) throw new Error("Could not create/resolve SQS queue");
  return res.QueueUrl;
}

function embeddingInput(job: {
  title: string;
  company: string | null;
  location: string | null;
  tags: string[];
  description: string | null;
}): string {
  return [
    job.title,
    job.company ?? "",
    job.location ?? "",
    job.tags.join(", "),
    (job.description ?? "").slice(0, 1500),
  ]
    .filter(Boolean)
    .join(". ");
}

async function indexJob(embed: Embedder, jobId: number): Promise<void> {
  const { rows } = await pool.query(
    "SELECT id, title, company, location, tags, description FROM jobs WHERE id = $1",
    [jobId],
  );
  if (!rows[0]) {
    console.warn(`[indexer] job ${jobId} not found, skipping`);
    return;
  }

  const output = await embed(embeddingInput(rows[0]), { pooling: "mean", normalize: true });
  const vector = JSON.stringify(Array.from(output.data));

  await pool.query(
    "UPDATE jobs SET embedding = $1::vector, indexed_at = now() WHERE id = $2",
    [vector, jobId],
  );
  console.log(`[indexer] indexed job ${jobId} (${rows[0].title})`);
}

async function main(): Promise<void> {
  console.log(`[indexer] loading embedding model ${EMBEDDING_MODEL}...`);
  const embed = (await pipeline("feature-extraction", EMBEDDING_MODEL)) as unknown as Embedder;
  const queueUrl = await ensureQueue();
  console.log("[indexer] ready, long-polling queue");

  for (;;) {
    try {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
        }),
      );

      for (const message of Messages ?? []) {
        const event = JSON.parse(message.Body ?? "{}") as { type?: string; jobId?: number | string };
        const jobId = Number(event.jobId);
        if (event.type === "job.created" && Number.isInteger(jobId)) {
          await indexJob(embed, jobId);
        } else {
          console.warn(`[indexer] skipping unrecognized message: ${message.Body?.slice(0, 200)}`);
        }
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    } catch (err) {
      console.error("[indexer] error:", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
