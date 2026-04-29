import { describe, it, expect } from "vitest";
import { formatMarker, parseMarker, hasMarker } from "./marker.js";

describe("formatMarker", () => {
  it("formats owner/repo#N", () => {
    expect(formatMarker({ owner: "simplafy", repo: "hub", number: 42 }))
      .toBe("<!-- gh-ref: simplafy/hub#42 -->");
  });
});

describe("parseMarker", () => {
  it("parses a description that starts with the marker", () => {
    const desc = "<!-- gh-ref: simplafy/hub#42 -->\n\n## Análise\n...";
    expect(parseMarker(desc)).toEqual({ owner: "simplafy", repo: "hub", number: 42 });
  });

  it("ignores leading blank lines", () => {
    const desc = "\n\n<!-- gh-ref: a/b#1 -->\nbody";
    expect(parseMarker(desc)).toEqual({ owner: "a", repo: "b", number: 1 });
  });

  it("returns null when no marker present", () => {
    expect(parseMarker("plain body")).toBeNull();
  });

  it("returns null when marker is not on the first non-empty line", () => {
    const desc = "## Title\n<!-- gh-ref: a/b#1 -->";
    expect(parseMarker(desc)).toBeNull();
  });

  it("returns null when ref shape is invalid", () => {
    expect(parseMarker("<!-- gh-ref: bad -->")).toBeNull();
  });
});

describe("hasMarker", () => {
  it("matches by full marker substring (for list-and-filter dedup)", () => {
    const target = "<!-- gh-ref: simplafy/hub#42 -->";
    expect(hasMarker("anything\n" + target + "\nmore", target)).toBe(true);
    expect(hasMarker("nope", target)).toBe(false);
  });
});
