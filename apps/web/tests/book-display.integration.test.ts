import { describe, expect, it } from "vitest";
import { projectBookDisplay } from "../lib/book-display";

describe("04C-4C3 Source/Work book display policy", () => {
  it("prefers bound authoritative Work title and preserves the original filename", () => {
    expect(projectBookDisplay({ fileName: "original.epub", workTitle: "真实书名", version: 2, isLatestVersion: true }))
      .toEqual({ title: "真实书名", titleOrigin: "WORK", fileName: "original.epub", version: 2, isLatestVersion: true });
  });

  it.each([undefined, null, "", "   "])("falls back for an unbound or blank Work title", (workTitle) => {
    expect(projectBookDisplay({ fileName: "raw.pdf", workTitle, version: 1, isLatestVersion: true }))
      .toEqual({ title: "raw.pdf", titleOrigin: "FILENAME", fileName: "raw.pdf", version: 1, isLatestVersion: true });
  });

  it("retains the historical version marker while using the Source's current authoritative title", () => {
    expect(projectBookDisplay({ fileName: "source.epub", workTitle: "当前正式书名", version: 1, isLatestVersion: false }))
      .toMatchObject({ title: "当前正式书名", fileName: "source.epub", version: 1, isLatestVersion: false });
  });
});
