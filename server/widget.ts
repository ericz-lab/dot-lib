// ai-space 面板小组件 (契约见 ai-space docs/app-spec.md, widgets / items / blocks)。
//
// items: 最近有阅读动静的 3 本 (读完 / 读至 N% / 未读), 给不认识 blocks 的老面板。
// blocks: 状态卡。在读的书 (已开始、未读完) 按最近阅读排序, 每本一个 progress 块;
//   第一本是 hero。没有在读的书 → blocks: []。
// 本 app 只存每本书最后一次进度 (progress.json 的 updatedAt), 没有读完时间、没有逐日记录,
// 所以不出 "本月读完几本" / "本周阅读天数" 这类 metric, 免得编数字。

import type { BookMeta, Progress } from "./types.js";

export interface WidgetRow {
  p: Progress;
  m: BookMeta;
}

export interface WidgetItem {
  text: string;
  url: string;
  time: string;
}

export interface ProgressBlock {
  type: "progress";
  label: string;
  value: number | null;
  max: number;
  format: "percent";
  caption?: string;
  url: string;
  tone: "neutral";
}

export interface WidgetResponse {
  ok: true;
  items: WidgetItem[];
  asOf: string;
  staleAfter: number;
  blocks: ProgressBlock[];
}

const MAX_ITEMS = 3;
const MAX_BLOCKS = 6;
/** 每次请求现算; 面板 60s 刷新, 15 分钟没拿到新数据就该标为过期。 */
const STALE_AFTER_S = 15 * 60;

/** 进度百分比 (0–100 整数), 口径与书架一致。 */
const percentOf = (p: Progress) => Math.round((p.percentage || 0) * 100);
const isStarted = (p: Progress) => percentOf(p) > 0 || !!p.cfi || p.page > 0;
const isFinished = (p: Progress) => percentOf(p) >= 99;

// "(z-library.sk, 1lib.sk, z-lib.sk)" 这类下载站标记: 括号里全是域名。
const DOMAIN_GROUP = /\s*[(\[]\s*[\w-]+(?:\.[\w-]+)+(?:\s*,\s*[\w-]+(?:\.[\w-]+)+)*\s*[)\]]\s*$/;
// 末尾的半角括号段 " (…)" (前面有空格)。
const TRAILING_PAREN = /\s+\(([^()]+)\)\s*$/;
// 出版社丛书名: "(华章经典·金融投资)"。
const SERIES_WORDS = /系列|丛书|文库|经典|书系|译丛|Series/i;
// 末尾的全角括号段 "（…）"。
const TRAILING_FW_PAREN = /（([^（）]+)）\s*$/;
/** 全角括号里这么长的, 是营销语而不是 "（典藏版）" 这种版本说明。 */
const BLURB_MIN_LEN = 12;

/**
 * 只为显示清理书名, 不改存储。去掉: 下载站域名标记、z-lib 命名里紧跟其前的 "(作者)"、
 * 与作者同名的末尾括号、丛书名括号、过长的全角营销括号。清理后为空就退回原书名。
 * 返回清理后的书名, 以及 z-lib 命名里带出来的作者 (元数据没作者时用)。
 */
export function cleanTitle(raw: string, author = ""): { title: string; author: string } {
  let t = raw.trim();
  let derivedAuthor = "";
  const sameAsAuthor = (s: string) => !!author.trim() && s.trim().toLowerCase() === author.trim().toLowerCase();

  if (DOMAIN_GROUP.test(t)) {
    t = t.replace(DOMAIN_GROUP, "");
    // z-lib 文件名的格式是 "书名 (作者) (域名…)", 域名前那段括号就是作者。
    const m = t.match(TRAILING_PAREN);
    if (m) {
      derivedAuthor = m[1].trim();
      t = t.replace(TRAILING_PAREN, "");
    }
  }
  for (;;) {
    const m = t.match(TRAILING_PAREN);
    if (!m || !(sameAsAuthor(m[1]) || SERIES_WORDS.test(m[1]))) break;
    t = t.replace(TRAILING_PAREN, "");
  }
  const fw = t.match(TRAILING_FW_PAREN);
  if (fw && fw[1].length >= BLURB_MIN_LEN && fw.index! > 0) t = t.slice(0, fw.index).trimEnd();

  t = t.trim();
  return { title: t || raw.trim(), author: derivedAuthor };
}

export function buildWidget(rows: WidgetRow[], opts: { base: string; now?: Date }): WidgetResponse {
  const sorted = [...rows].sort((a, b) => (b.p.updatedAt || "").localeCompare(a.p.updatedAt || ""));
  const readerUrl = (m: BookMeta) => `${opts.base}/#/read/${m.id}`;

  const items = sorted.slice(0, MAX_ITEMS).map(({ p, m }) => {
    const pct = percentOf(p);
    const state = isFinished(p) ? "读完" : isStarted(p) ? `读至 ${pct}%` : "未读";
    return { text: `《${m.title}》${state}`, url: readerUrl(m), time: p.updatedAt || "" };
  });

  const blocks = sorted
    .filter(({ p }) => isStarted(p) && !isFinished(p))
    .slice(0, MAX_BLOCKS)
    .map(({ p, m }): ProgressBlock => {
      const { title, author: derived } = cleanTitle(m.title, m.author);
      const author = (m.author || "").trim() || derived;
      const value = typeof p.percentage === "number" && Number.isFinite(p.percentage) ? percentOf(p) : null;
      return {
        type: "progress",
        label: title,
        value,
        max: 100,
        format: "percent",
        ...(author ? { caption: author } : {}),
        url: readerUrl(m),
        tone: "neutral",
      };
    });

  return {
    ok: true,
    items,
    asOf: (opts.now ?? new Date()).toISOString(),
    staleAfter: STALE_AFTER_S,
    blocks,
  };
}
