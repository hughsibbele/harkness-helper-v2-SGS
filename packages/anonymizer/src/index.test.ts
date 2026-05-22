// Tests target the regressions surfaced by M6.22 audit-pii-scrub.md
// (Findings 1, 2, 3, 4, 5, 11, 13, 14). Run with `pnpm --filter
// @harkness-helper/anonymizer test`.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  anonToken,
  compileRoster,
  RosterMissingError,
  scrubFreeText,
  scrubText,
  type AnonymizableStudent,
} from "./index";

// Test salt — 32 random bytes, base64. Used by every test that exercises
// anonToken or downstream (compileRoster computes tokens).
const TEST_SALT = "dGVzdC1zYWx0LXRoYXQtaXMtMzItYnl0ZXMtbG9uZyEhISEhIQ==";

const SHORT_SALT = "c2hvcnQ="; // "short", 5 bytes after base64-decode.

const SAVED_SALT = process.env.SUPER_GRADER_SALT;

beforeAll(() => {
  process.env.SUPER_GRADER_SALT = TEST_SALT;
});

afterEach(() => {
  process.env.SUPER_GRADER_SALT = TEST_SALT;
});

describe("anonToken — salt safety checks", () => {
  it("throws when SUPER_GRADER_SALT is missing", () => {
    delete process.env.SUPER_GRADER_SALT;
    expect(() => anonToken("1", "a@b.test")).toThrow(/not set/);
  });

  it("throws when salt is shorter than 16 bytes after base64-decode", () => {
    process.env.SUPER_GRADER_SALT = SHORT_SALT;
    expect(() => anonToken("1", "a@b.test")).toThrow(/suspiciously short/);
  });

  it("produces a stable Student_xxxxxx token for the same input", () => {
    const a = anonToken("12345", "Sarah.Smith@episcopalhighschool.org");
    const b = anonToken("12345", "Sarah.Smith@episcopalhighschool.org");
    expect(a).toBe(b);
    expect(a).toMatch(/^Student_[0-9a-f]{6}$/);
  });

  it("lowercases email and trims before hashing (matches §2 spec)", () => {
    const a = anonToken("12345", "  SARAH.SMITH@EpiscopalHighSchool.org  ");
    const b = anonToken("12345", "sarah.smith@episcopalhighschool.org");
    expect(a).toBe(b);
  });

  it("treats canvas_user_id as string vs number identically", () => {
    expect(anonToken(12345, "x@y.test")).toBe(anonToken("12345", "x@y.test"));
  });
});

describe("compileRoster — fail-closed posture", () => {
  it("throws RosterMissingError on []", () => {
    expect(() => compileRoster([])).toThrow(RosterMissingError);
  });

  it("throws RosterMissingError when every entry lacks an email", () => {
    const roster = [
      { canvas_user_id: "1", name: "Sarah Smith", email: "" },
    ] as AnonymizableStudent[];
    expect(() => compileRoster(roster)).toThrow(RosterMissingError);
  });

  it("RosterMissingError carries the cause_code", () => {
    try {
      compileRoster([]);
    } catch (err) {
      expect(err).toBeInstanceOf(RosterMissingError);
      expect((err as RosterMissingError).cause_code).toBe("passed_empty");
    }
  });
});

describe("scrubFreeText — name-variant matching", () => {
  const roster: AnonymizableStudent[] = [
    { canvas_user_id: "1", name: "Sarah Smith", email: "sarah@example.test" },
    { canvas_user_id: "2", name: "Robert Smith-Jones", email: "rob@example.test" },
    { canvas_user_id: "3", name: "Mary Jane Smith", email: "mj@example.test" },
  ];

  let saraToken: string;
  let robToken: string;
  let mjToken: string;
  let compiled: ReturnType<typeof compileRoster>;

  beforeEach(() => {
    saraToken = anonToken("1", "sarah@example.test");
    robToken = anonToken("2", "rob@example.test");
    mjToken = anonToken("3", "mj@example.test");
    compiled = compileRoster(roster);
  });

  it("matches first-name-only utterances (the dominant Harkness form)", () => {
    const out = scrubFreeText("Sarah said that", compiled);
    expect(out).toBe(`${saraToken} said that`);
  });

  it("matches possessive forms with straight apostrophe", () => {
    const out = scrubFreeText("Sarah's point was sharp", compiled);
    expect(out).toBe(`${saraToken} point was sharp`);
  });

  it("matches possessive forms with curly apostrophe", () => {
    const out = scrubFreeText("Sarah’s point was sharp", compiled);
    expect(out).toBe(`${saraToken} point was sharp`);
  });

  it("matches last-name-only utterances", () => {
    const out = scrubFreeText("Mr. Smith made the case", compiled);
    // 'Smith' is the last name on multiple roster entries, but the test only
    // cares that no real name survives.
    expect(out).not.toMatch(/Smith/);
    expect(out).toMatch(/^Mr\. Student_/);
  });

  it("matches hyphen-pieces from a hyphenated last name", () => {
    const out = scrubFreeText("I agree with Jones", compiled);
    expect(out).toBe(`I agree with ${robToken}`);
  });

  it("longest-first wins so multi-word names beat single-word matches", () => {
    const out = scrubFreeText("Mary Jane Smith and Mary alone", compiled);
    expect(out).toContain(mjToken);
    expect(out).not.toContain("Mary Jane");
  });

  it("is case-insensitive", () => {
    const out = scrubFreeText("SARAH said something", compiled);
    expect(out).toBe(`${saraToken} said something`);
  });

  it("preserves word-boundaries via Unicode-aware lookahead", () => {
    // "Sarahville" should NOT match — Sarah is part of a longer word.
    const out = scrubFreeText("We went to Sarahville", compiled);
    expect(out).toBe("We went to Sarahville");
  });

  it("does not match across punctuation in a way that produces \\b\\b noise", () => {
    // Empty-display-name entries are silently filtered by compileRoster
    // (no usable variants ≥2 chars). Guard against a regression that would
    // re-introduce a `\b\b` empty-string match.
    const rosterWithEmpty: AnonymizableStudent[] = [
      ...roster,
      { canvas_user_id: "9", name: "", email: "blank@example.test" },
      { canvas_user_id: "10", name: "A", email: "single@example.test" },
    ];
    const c = compileRoster(rosterWithEmpty);
    const out = scrubFreeText("nothing to see here", c);
    expect(out).toBe("nothing to see here");
  });
});

describe("scrubText — convenience wrapper", () => {
  it("scrubs first-name utterances end-to-end", () => {
    const roster: AnonymizableStudent[] = [
      { canvas_user_id: "1", name: "Sarah Smith", email: "sarah@example.test" },
    ];
    const token = anonToken("1", "sarah@example.test");
    expect(scrubText("Sarah and Sarah's friend", roster)).toBe(
      `${token} and ${token} friend`,
    );
  });

  it("throws on empty roster (fail-closed, mirrors compileRoster)", () => {
    expect(() => scrubText("any text", [])).toThrow(RosterMissingError);
  });

  it("throws when every roster entry has no email", () => {
    const roster: AnonymizableStudent[] = [
      { canvas_user_id: "1", name: "Sarah Smith", email: "" },
    ];
    expect(() => scrubText("any text", roster)).toThrow(RosterMissingError);
  });
});

// Restore original env at module teardown so other test files (if any) see
// what they expect.
afterEach(() => {
  if (SAVED_SALT === undefined) delete process.env.SUPER_GRADER_SALT;
  else process.env.SUPER_GRADER_SALT = SAVED_SALT;
});
