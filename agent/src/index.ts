import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Profile {
  label: string;
  keywords: string[];
  note: string;
}

interface DigestConfig {
  profiles: Profile[];
  destinations: string[];
  sources: string[];
  maxJobs: number;
  freshnessDays: number;
}

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config: DigestConfig = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "jobs.config.json"), "utf8"),
);

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-4-8";

function buildPrompt(cfg: DigestConfig): string {
  const profiles = cfg.profiles
    .map((p, i) => `${i + 1}. ${p.label} — keywords: ${p.keywords.join(", ")}. ${p.note}`)
    .join("\n");

  return `You are a job-market research agent producing a hand-curated digest of tech jobs offering VISA SPONSORSHIP or RELOCATION ASSISTANCE.

TARGET PROFILES:
${profiles}

TARGET DESTINATIONS:
${cfg.destinations.map((d) => `- ${d}`).join("\n")}

SOURCES TO SCAN (use WebSearch and WebFetch):
${cfg.sources.map((s) => `- ${s}`).join("\n")}
Also include any other reputable visa-sponsorship job boards you discover.

RULES:
- Each job must EXPLICITLY offer visa sponsorship and/or relocation assistance — verify by opening the actual posting with WebFetch; never trust a search snippet alone.
- Prefer postings from the last ${cfg.freshnessDays} days; skip anything clearly stale or closed.
- Aim for up to ${cfg.maxJobs} quality jobs. Quality over quantity.

OUTPUT — respond with ONLY the finished markdown digest (no preamble, no meta-commentary), structured as:
- A title line: "# Visa-Sponsored Tech Jobs Digest"
- A 2-3 sentence summary of this scan (how many roles found, which markets were hot).
- One "## <Category>" section per target profile, plus "## Other Notable" if relevant.
- Under each section, one bullet per job: **Role** — Company — Location — \`Remote\` or \`Relocation\` — what the posting actually says about visa/relocation — [link](url).
- A final "## Sources" note listing any source that could not be reached.`;
}

function extractText(message: unknown): string {
  const m = message as {
    text?: string;
    message?: { content?: Array<{ type: string; text?: string }> };
  };
  if (typeof m.text === "string") return m.text;
  if (Array.isArray(m.message?.content)) {
    return m.message.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

async function main(): Promise<void> {
  console.error(`Running visa-jobs-digest agent (model: ${MODEL})...`);
  const started = Date.now();

  const assistantChunks: string[] = [];
  let finalResult = "";

  for await (const message of query({
    prompt: buildPrompt(config),
    options: {
      model: MODEL,
      allowedTools: ["WebSearch", "WebFetch"],
      permissionMode: "bypassPermissions",
      maxTurns: 80,
      systemPrompt:
        "You are a meticulous job-market researcher. You verify every claim by reading the primary source before including it.",
    },
  })) {
    if (message.type === "assistant") {
      const text = extractText(message);
      if (text.trim()) {
        assistantChunks.push(text);
        console.error(`[agent] ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);
      }
    } else if (message.type === "result") {
      const r = message as { result?: string; subtype?: string };
      if (typeof r.result === "string") finalResult = r.result;
      console.error(`[done] subtype=${r.subtype ?? "unknown"}`);
    }
  }

  const digest = (finalResult || assistantChunks.at(-1) || "").trim();
  if (!digest) {
    throw new Error("Agent produced no digest output.");
  }

  const dateStamp = new Date().toISOString().slice(0, 10);
  const outDir = path.join(projectRoot, "digests");
  fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, `${dateStamp}.md`);
  fs.writeFileSync(outFile, digest + "\n");
  fs.writeFileSync(path.join(outDir, "LATEST.md"), digest + "\n");

  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  console.error(`Digest written to ${outFile} (${minutes} min).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
