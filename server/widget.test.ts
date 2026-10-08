import { describe, expect, test } from "bun:test";
import type { BookMeta, Progress } from "./types.js";
import { buildWidget, cleanTitle, type WidgetRow } from "./widget.js";

const meta = (id: string, title: string, author = ""): BookMeta => ({
  id,
  title,
  author,
  fileName: `${title}.epub`,
  fileSize: 1,
  hasCover: false,
  coverType: "",
  addedAt: "2026-08-01T00:00:00.000Z",
  format: "epub",
});
const prog = (percentage: number, updatedAt: string, cfi = percentage > 0 ? "epubcfi(/6/2)" : ""): Progress => ({
  cfi,
  page: 0,
  percentage,
  updatedAt,
});
const row = (m: BookMeta, p: Progress): WidgetRow => ({ m, p });
const now = new Date("2026-10-08T01:00:00.000Z");

describe("cleanTitle", () => {
  test("strips the z-lib marker and the author slot before it", () => {
    expect(cleanTitle("Trading Price Action Trends (Al Brooks) (z-library.sk, 1lib.sk, z-lib.sk)")).toEqual({
      title: "Trading Price Action Trends",
      author: "Al Brooks",
    });
    expect(cleanTitle("Trading Price Action - Reversals (Al Brooks) (z-library.sk, 1lib.sk, z-lib.sk)", "Al Brooks").title).toBe(
      "Trading Price Action - Reversals"
    );
  });

  test("strips a publisher series but keeps an edition note", () => {
    expect(cleanTitle("日本蜡烛图技术新解（典藏版） (华章经典·金融投资)").title).toBe("日本蜡烛图技术新解（典藏版）");
    expect(cleanTitle("金钱游戏（划时代增订版）").title).toBe("金钱游戏（划时代增订版）");
  });

  test("strips a long full-width blurb", () => {
    expect(
      cleanTitle("炒股的智慧：在华尔街炒股为生的体验（华尔街炒股25年经验总结，畅销15年最经典的炒股理论！）").title
    ).toBe("炒股的智慧：在华尔街炒股为生的体验");
  });

  test("leaves ordinary titles and parentheticals alone, never empties a title", () => {
    expect(cleanTitle("技术革命与金融资本").title).toBe("技术革命与金融资本");
    expect(cleanTitle("Thinking (Fast and Slow)").title).toBe("Thinking (Fast and Slow)");
    expect(cleanTitle("（华尔街炒股25年经验总结，畅销15年最经典的炒股理论！）").title).toBe(
      "（华尔街炒股25年经验总结，畅销15年最经典的炒股理论！）"
    );
  });
});

describe("buildWidget", () => {
  const rows: WidgetRow[] = [
    row(meta("old", "技术革命与金融资本", "卡洛塔·佩雷斯"), prog(0.82, "2026-09-04T13:10:58.816Z")),
    row(meta("done", "金钱游戏（划时代增订版）", "亚当·史密斯"), prog(1, "2026-10-06T00:00:00.000Z")),
    row(meta("new", "日本蜡烛图技术新解（典藏版） (华章经典·金融投资)", "史蒂夫·尼森"), prog(0.5, "2026-10-05T03:40:23.603Z")),
    row(meta("zlib", "Trading Price Action Trends (Al Brooks) (z-library.sk, 1lib.sk, z-lib.sk)"), prog(0.05, "2026-09-27T08:36:33.945Z")),
    row(meta("unread", "纳瓦尔宝典"), prog(0, "2026-10-07T00:00:00.000Z")),
  ];

  test("keeps items as before: 3 most recent, raw titles", () => {
    const w = buildWidget(rows, { base: "https://books.example", now });
    expect(w.ok).toBe(true);
    expect(w.items).toEqual([
      { text: "《纳瓦尔宝典》未读", url: "https://books.example/#/read/unread", time: "2026-10-07T00:00:00.000Z" },
      { text: "《金钱游戏（划时代增订版）》读完", url: "https://books.example/#/read/done", time: "2026-10-06T00:00:00.000Z" },
      {
        text: "《日本蜡烛图技术新解（典藏版） (华章经典·金融投资)》读至 50%",
        url: "https://books.example/#/read/new",
        time: "2026-10-05T03:40:23.603Z",
      },
    ]);
  });

  test("adds asOf, staleAfter and in-progress books as progress blocks, most recent first", () => {
    const w = buildWidget(rows, { base: "", now });
    expect(w.asOf).toBe("2026-10-08T01:00:00.000Z");
    expect(w.staleAfter).toBeGreaterThan(60);
    expect(w.blocks).toEqual([
      { type: "progress", label: "日本蜡烛图技术新解（典藏版）", value: 50, max: 100, format: "percent", caption: "史蒂夫·尼森", url: "/#/read/new", tone: "neutral" },
      { type: "progress", label: "Trading Price Action Trends", value: 5, max: 100, format: "percent", caption: "Al Brooks", url: "/#/read/zlib", tone: "neutral" },
      { type: "progress", label: "技术革命与金融资本", value: 82, max: 100, format: "percent", caption: "卡洛塔·佩雷斯", url: "/#/read/old", tone: "neutral" },
    ]);
  });

  test("omits the caption when no author is known", () => {
    const w = buildWidget([row(meta("a", "Some Book"), prog(0.3, "2026-10-01T00:00:00.000Z"))], { base: "", now });
    expect(w.blocks[0]).not.toHaveProperty("caption");
  });

  test("a missing percentage is null, not 0", () => {
    const p = { cfi: "epubcfi(/6/4)", page: 0, updatedAt: "2026-10-01T00:00:00.000Z" } as unknown as Progress;
    const w = buildWidget([row(meta("a", "Some Book"), p)], { base: "", now });
    expect(w.blocks[0].value).toBeNull();
  });

  test("caps blocks at 6", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      row(meta(`b${i}`, `Book ${i}`), prog(0.1 + i / 100, `2026-10-0${i + 1}T00:00:00.000Z`))
    );
    const w = buildWidget(many, { base: "", now });
    expect(w.blocks).toHaveLength(6);
    expect(w.blocks[0].label).toBe("Book 8");
  });

  test("empty state: nothing in progress → blocks []", () => {
    const w = buildWidget(
      [row(meta("done", "Done"), prog(1, "2026-10-01T00:00:00.000Z")), row(meta("u", "Unread"), prog(0, "2026-10-02T00:00:00.000Z"))],
      { base: "", now }
    );
    expect(w.blocks).toEqual([]);
    expect(w.items).toHaveLength(2);
    expect(buildWidget([], { base: "", now })).toMatchObject({ ok: true, items: [], blocks: [] });
  });
});
