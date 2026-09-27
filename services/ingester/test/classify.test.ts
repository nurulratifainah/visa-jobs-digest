import { describe, expect, it } from "vitest";
import { detectSeniority, detectVisaSupport, stripHtml } from "../src/classify.js";

describe("detectSeniority", () => {
  it.each([
    ["Werkstudent Software Engineering (m/w/d)", "intern"],
    ["Head of Data", "manager"],
    ["Engineering Manager, Platform", "manager"],
    ["Principal Backend Engineer", "principal"],
    ["Staff Engineer", "lead"],
    ["Senior Team Lead Backend", "lead"], // lead outranks senior
    ["Sr. Frontend Developer", "senior"],
    ["Lead Junior Developer", "lead"], // lead is checked before junior
    ["Junior Data Analyst", "junior"],
    ["Backend Engineer", "mid"],
  ])("%s → %s", (title, expected) => {
    expect(detectSeniority(title)).toBe(expected);
  });

  // Known bug: `\b` fails inside German compounds ("Softwareentwickler") and
  // before "(" in "(m/w/d)", so these titles get no seniority. Tracked as the
  // first issue for the @claude workflow — see docs/AI-WORKFLOW.md.
  it.fails("classifies German compound titles", () => {
    expect(detectSeniority("Softwareentwickler (m/w/d)")).toBe("mid");
  });

  it("returns null when the title carries no signal", () => {
    expect(detectSeniority("Customer Success")).toBeNull();
  });
});

describe("detectVisaSupport", () => {
  const job = { title: "Backend Engineer", tags: [] as string[] };

  it("matches explicit sponsorship language", () => {
    expect(detectVisaSupport(job, "We offer visa sponsorship for the right candidate.")).toBe(true);
    expect(detectVisaSupport(job, "We will sponsor your visa.")).toBe(true);
  });

  it("treats relocation support as visa-friendly", () => {
    expect(detectVisaSupport(job, "Generous relocation package.")).toBe(true);
  });

  it("looks at tags as well as the description", () => {
    expect(detectVisaSupport({ ...job, tags: ["Visa Sponsorship"] }, "")).toBe(true);
  });

  it("does not fire on unrelated mentions", () => {
    expect(detectVisaSupport(job, "Must already hold a valid work permit.")).toBe(false);
  });
});

describe("stripHtml", () => {
  it("strips tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>\n\n<ul><li>one</li></ul>")).toBe("Hello world one");
  });

  it("handles double-encoded markup", () => {
    expect(stripHtml("&lt;h2&gt;About us&lt;/h2&gt;&lt;p&gt;We build&lt;/p&gt;")).toBe("About us We build");
  });

  it("decodes numeric and named entities", () => {
    expect(stripHtml("Caf&#233; &amp; Bar &ndash; &euro;60k")).toBe("Café & Bar - EUR60k");
  });
});
