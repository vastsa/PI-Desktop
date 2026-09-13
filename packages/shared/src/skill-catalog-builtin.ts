/**
 * The skill catalog that ships inside the app.
 *
 * Deliberately a small floor, not the shelf: a handful of high-signal,
 * zero-setup skills so the market is useful offline. The main volume comes
 * from configured sources (e.g. GitHub repos auto-scanned for SKILL.md).
 * Documents are served via jsDelivr — raw.githubusercontent.com is
 * TLS-flaky from some networks while the CDN edge reaches them reliably.
 */
import type { SkillCatalogFile } from "./skill-catalog.js";

const ANTHROPIC = "https://cdn.jsdelivr.net/gh/anthropics/skills@main/skills";
const homepageFor = (slug: string) => `https://github.com/anthropics/skills/tree/main/skills/${slug}`;

export const BUILTIN_SKILL_CATALOG: SkillCatalogFile = {
  schemaVersion: 1,
  updatedAt: "2026-09-12",
  source: "builtin",
  skills: [
    {
      id: "docx",
      name: "Word 文档",
      description: "创建、读取、编辑 Word (.docx) 文档,支持修订与批注",
      author: "anthropic",
      homepage: homepageFor("docx"),
      url: `${ANTHROPIC}/docx/SKILL.md`,
      categories: ["docs"],
      verified: true,
    },
    {
      id: "pdf",
      name: "PDF 处理",
      description: "读取、提取、合并、拆分与生成 PDF 文件",
      author: "anthropic",
      homepage: homepageFor("pdf"),
      categories: ["docs"],
      verified: true,
      url: `${ANTHROPIC}/pdf/SKILL.md`,
    },
    {
      id: "pptx",
      name: "PPT 演示文稿",
      description: "创建、编辑与分析 PowerPoint (.pptx) 演示文稿",
      author: "anthropic",
      homepage: homepageFor("pptx"),
      categories: ["docs"],
      verified: true,
      url: `${ANTHROPIC}/pptx/SKILL.md`,
    },
    {
      id: "xlsx",
      name: "Excel 表格",
      description: "处理电子表格:公式、图表、数据透视与多工作表",
      author: "anthropic",
      homepage: homepageFor("xlsx"),
      categories: ["docs", "data"],
      verified: true,
      url: `${ANTHROPIC}/xlsx/SKILL.md`,
    },
    {
      id: "frontend-design",
      name: "Frontend Design",
      description: "构建或重塑 UI 时做出有辨识度、有意图的视觉设计",
      author: "anthropic",
      homepage: homepageFor("frontend-design"),
      categories: ["coding"],
      verified: true,
      url: `${ANTHROPIC}/frontend-design/SKILL.md`,
    },
    {
      id: "webapp-testing",
      name: "Webapp Testing",
      description: "用 Playwright 与本地 Web 应用交互并验证前端行为",
      author: "anthropic",
      homepage: homepageFor("webapp-testing"),
      categories: ["coding"],
      verified: true,
      url: `${ANTHROPIC}/webapp-testing/SKILL.md`,
    },
    {
      id: "mcp-builder",
      name: "MCP Builder",
      description: "创建高质量的 MCP 服务器,让 LLM 对接外部工具与数据",
      author: "anthropic",
      homepage: homepageFor("mcp-builder"),
      categories: ["coding"],
      verified: true,
      url: `${ANTHROPIC}/mcp-builder/SKILL.md`,
    },
    {
      id: "skill-creator",
      name: "Skill Creator",
      description: "创建新技能、改进现有技能并度量技能效果",
      author: "anthropic",
      homepage: homepageFor("skill-creator"),
      categories: ["coding", "workflow"],
      verified: true,
      url: `${ANTHROPIC}/skill-creator/SKILL.md`,
    },
  ],
};
