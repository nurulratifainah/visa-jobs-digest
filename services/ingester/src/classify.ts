/**
 * Pure classification helpers for ingested ads. Kept free of I/O (no pool, no
 * SQS, no top-level side effects) so they can be unit-tested and reused by
 * backfills without booting the service.
 */

export interface ArbeitnowJob {
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

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&(m|n)dash;/g, "-")
    .replace(/&hellip;/g, "...")
    .replace(/&(l|r)squo;/g, "'")
    .replace(/&(l|r)dquo;/g, '"')
    .replace(/&bull;/g, "-")
    .replace(/&euro;/g, "EUR")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Some ads arrive double-encoded (`&lt;h2&gt;` instead of `<h2>`), so tags only
 * become visible after entity decoding. Decode → strip → decode handles both
 * the honest and the double-encoded case.
 */
export function stripHtml(html: string): string {
  return decodeEntities(decodeEntities(html).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function detectVisaSupport(job: Pick<ArbeitnowJob, "title" | "tags">, plainDescription: string): boolean {
  const haystack = `${job.title} ${job.tags.join(" ")} ${plainDescription}`.toLowerCase();
  return /visa sponsorship|visa support|sponsor(s|ing)? (a |your )?visa|relocation (assistance|package|support|bonus)/.test(
    haystack,
  );
}

/**
 * Seniority is a filter users reach for constantly and job boards rarely
 * expose. The title is the only reliable signal, so classify it at write time
 * (cheap, indexable) rather than at query time. Order matters: "Senior Team
 * Lead" is a lead, "Lead Junior Developer" is not junior — check from the top.
 */
export type Seniority = "intern" | "junior" | "mid" | "senior" | "lead" | "principal" | "manager";

export function detectSeniority(title: string): Seniority | null {
  const t = title.toLowerCase();
  if (/\b(intern|internship|praktikum|praktikant|werkstudent|working student|trainee|apprentice)\b/.test(t)) return "intern";
  if (/\b(head of|director|vp|vice president|cto|chief|manager|engineering lead)\b/.test(t)) return "manager";
  if (/\b(principal|distinguished|fellow|architect)\b/.test(t)) return "principal";
  if (/\b(staff|lead|tech lead|team lead|teamleiter)\b/.test(t)) return "lead";
  if (/\b(senior|sr\.?|expert)\b/.test(t)) return "senior";
  if (/\b(junior|jr\.?|entry.level|graduate|associate|berufseinsteiger)\b/.test(t)) return "junior";
  if (/\b(mid.level|intermediate|professional|\(m\/w\/d\)|engineer|developer|entwickler)\b/.test(t)) return "mid";
  return null;
}
