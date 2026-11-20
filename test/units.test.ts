import { describe, expect, it } from "vitest";
import { offsetFormatter } from "../src/activity";
import { firstLine, redact } from "../src/redact";
import { canonicalURL, displayName, identityKey, repoSlug } from "../src/repo";
import { ftsQuery } from "../src/search";

describe("repo identity", () => {
  it("folds every spelling of a remote into one canonical URL", () => {
    for (const raw of [
      "https://github.com/bengottlieb/DevCenter",
      "https://github.com/bengottlieb/DevCenter.git",
      "git@github.com:bengottlieb/DevCenter.git",
      "ssh://git@github.com/bengottlieb/DevCenter/",
      "https://user:secret@github.com/bengottlieb/DevCenter",
      "  github.com/bengottlieb/DevCenter  ",
    ]) {
      expect(canonicalURL(raw), raw).toBe("https://github.com/bengottlieb/DevCenter");
    }
  });

  it("ignores case when grouping but keeps it for display", () => {
    expect(identityKey("https://github.com/BenGottlieb/devcenter")).toBe("bengottlieb_devcenter");
    expect(identityKey("git@github.com:bengottlieb/DevCenter.git")).toBe("bengottlieb_devcenter");
    expect(displayName("git@github.com:bengottlieb/DevCenter.git")).toBe("DevCenter");
  });

  it("identifies a checkout with no remote by folder name, never by path", () => {
    expect(canonicalURL("/Users/ben/Documents/TokenUsage")).toBe("local:TokenUsage");
    expect(canonicalURL("file:///home/user/TokenUsage/")).toBe("local:TokenUsage");
    expect(canonicalURL("local:TokenUsage")).toBe("local:TokenUsage");
    expect(identityKey("/Users/ben/Documents/TokenUsage")).toBe("local_tokenusage");
    expect(repoSlug("/Users/ben/Documents/TokenUsage")).toBeNull();
  });

  it("keeps the host for repos outside GitHub and derives owner/name slugs", () => {
    expect(identityKey("https://gitlab.com/group/project")).toBe("gitlab.com_group_project");
    expect(repoSlug("git@github.com:ios-tooling/totalrecall.git")).toBe("ios-tooling/totalrecall");
    expect(repoSlug("https://gitlab.com/a/b/c")).toBeNull();
  });
});

describe("redaction", () => {
  it("masks tokens, bearer values and opaque blobs", () => {
    expect(redact("push with ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("push with [redacted]");
    expect(redact("key sk-proj_abcdefghij0123456789")).toBe("key [redacted]");
    expect(redact("Authorization: bearer abc.def-123")).toBe("Authorization: Bearer [redacted]");
    expect(redact("sha 0123456789abcdef0123456789abcdef01234567 done")).toBe("sha [redacted] done");
    expect(redact("blob QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890abcdefXYZ+/= end")).toBe("blob [redacted] end");
  });

  it("leaves ordinary prose, short hashes, long numbers and paths alone", () => {
    const plain = "Fixed the parser in commit 3f2a9c1; see /Users/ben/Documents/DevCenter/AIHistoryKit/Sources/file2.swift (12345678901234567890123456789012345)";
    expect(redact(plain)).toBe(plain);
  });

  it("summarises a prompt by its first non-empty line", () => {
    expect(firstLine("\n\n  fix the build  \nmore")).toBe("fix the build");
    expect(firstLine("x".repeat(300)).length).toBe(200);
  });
});

describe("helpers", () => {
  it("quotes every search word so punctuation cannot break FTS syntax", () => {
    expect(ftsQuery('cloud-kit "sync" AND (broken', "AND")).toBe('"cloud" AND "kit" AND "sync" AND "AND" AND "broken"');
    expect(ftsQuery("***", "AND")).toBeNull();
  });

  it("renders times in the caller's offset", () => {
    expect(offsetFormatter("2026-11-06T09:00:00-06:00")("2026-11-06T18:30:00.000Z")).toBe("2026-11-06T12:30:00-06:00");
    expect(offsetFormatter("2026-11-06T09:00:00Z")("2026-11-06T18:30:00.000Z")).toBe("2026-11-06T18:30:00Z");
  });
});
