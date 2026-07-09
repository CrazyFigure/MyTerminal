import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录是脚本定位输出文件的唯一基准，保证本地和 GitHub Actions 路径一致。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// README 直接引用仓库内静态 SVG，避免依赖第三方实时图片代理。
const outputPath = join(repoRoot, 'assets', 'star-history.svg');
// 本地执行时使用默认仓库，GitHub Actions 中优先使用当前仓库环境变量。
const repository = process.env.GITHUB_REPOSITORY || 'CrazyFigure/MyTerminal';
// GitHub stargazers 接口现在要求鉴权；Actions 中注入 GITHUB_TOKEN，本地可用 GH_TOKEN 调试。
const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
// GitHub REST API 统一入口，方便后续切换企业版或代理时只改一处。
const githubApiBaseUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
// CI 中禁止用线性兜底图覆盖真实走势图，避免自动提交不准确资产。
const allowFallback = process.env.GITHUB_ACTIONS !== 'true' || process.env.STAR_HISTORY_ALLOW_FALLBACK === '1';
// 图表尺寸固定，README 中渲染时不会因为内容变化产生布局跳动。
const chartWidth = 860;
const chartHeight = 440;
// 内边距为坐标轴和标题预留空间，避免标签贴边或遮挡折线。
const chartMargin = {
  top: 74,
  right: 48,
  bottom: 72,
  left: 68,
};
// 每页 100 条是 GitHub REST API 支持的最大分页大小，减少远程调用次数。
const stargazersPageSize = 100;
// 100 页最多覆盖 10000 个 star，防止接口异常时陷入无限分页。
const maxStargazerPages = 100;

// GitHub API 异常需要携带状态码和响应正文，方便 Actions 日志直接定位鉴权或限流原因。
class GithubApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GithubApiError';
    this.status = status;
    this.body = body;
  }
}

// SVG 文本节点和属性值统一做 XML 转义，避免仓库名等外部数据破坏 SVG 结构。
function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// 数字展示使用英文千分位，和 GitHub star/badge 的常见展示格式保持一致。
function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

// 坐标轴日期固定为 UTC 年月日，避免 Actions 运行地区不同导致输出不稳定。
function formatDateLabel(value) {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

// SVG 坐标保留两位小数，减少文件噪音，同时避免路径精度不足造成抖动。
function formatCoord(value) {
  return Number(value.toFixed(2));
}

// GitHub 请求头集中生成，stargazers 接口需要特殊 Accept 才会返回 starred_at。
function buildGithubHeaders(accept) {
  const headers = {
    Accept: accept,
    'User-Agent': 'CrazyFigure-MyTerminal-Star-History',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // GitHub Actions 的仓库 token 用于读取 stargazers 时间戳；本地没有 token 时只允许生成兜底图。
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  return headers;
}

// 远程 JSON 读取统一校验 HTTP 状态；失败时保留原始正文给上层错误处理。
async function fetchJson(url, headers) {
  // 所有 GitHub 远程调用集中在这里处理，便于统一输出状态码和错误正文。
  const response = await fetch(url, { headers });
  const body = await response.text();

  if (!response.ok) {
    throw new GithubApiError(`GitHub API request failed with ${response.status}: ${url}`, response.status, body);
  }

  return JSON.parse(body);
}

// 仓库元数据用于获取创建时间和当前 star 数，是精确和兜底图都需要的基础信息。
async function fetchRepositoryMetadata() {
  const metadataUrl = `${githubApiBaseUrl}/repos/${repository}`;
  return fetchJson(metadataUrl, buildGithubHeaders('application/vnd.github+json'));
}

// 分页读取完整 stargazer 时间线；任一页缺少 starred_at 都视为不可生成精确走势图。
async function fetchStargazers() {
  const stars = [];

  for (let page = 1; page <= maxStargazerPages; page += 1) {
    const stargazersUrl = `${githubApiBaseUrl}/repos/${repository}/stargazers?per_page=${stargazersPageSize}&page=${page}`;
    const pageItems = await fetchJson(stargazersUrl, buildGithubHeaders('application/vnd.github.star+json'));

    // GitHub 返回结构变化时立即失败，避免生成没有时间戳的错误走势图。
    if (!Array.isArray(pageItems)) {
      throw new Error('Unexpected stargazers response: expected an array.');
    }

    for (const item of pageItems) {
      // starred_at 是走势图的核心数据；缺失通常说明 Accept 头或鉴权失效。
      if (!item?.starred_at) {
        throw new Error('GitHub stargazers response did not include starred_at.');
      }

      stars.push({
        starredAt: item.starred_at,
      });
    }

    // 最后一页条数不足时停止分页，避免额外请求空页。
    if (pageItems.length < stargazersPageSize) {
      break;
    }
  }

  return stars.sort((left, right) => Date.parse(left.starredAt) - Date.parse(right.starredAt));
}

// 精确序列从仓库创建时间的 0 star 开始，每个 starred_at 将累计数量加一。
function buildExactSeries(stargazers, repositoryMetadata) {
  const repoCreatedAt = repositoryMetadata.created_at || stargazers[0]?.starredAt || new Date().toISOString();
  const points = [
    {
      date: repoCreatedAt,
      count: 0,
    },
  ];

  for (const [index, star] of stargazers.entries()) {
    points.push({
      date: star.starredAt,
      count: index + 1,
    });
  }

  return {
    points,
    totalStars: stargazers.length,
    exact: true,
    note: 'Generated from GitHub stargazer timestamps',
  };
}

// 本地无 token 时用当前 star 数生成预览图；CI 默认禁用该分支，避免自动提交近似数据。
function buildFallbackSeries(repositoryMetadata) {
  const repoCreatedAt = repositoryMetadata.created_at || new Date().toISOString();
  const latestKnownAt = repositoryMetadata.updated_at || repositoryMetadata.pushed_at || new Date().toISOString();
  const currentStars = Number(repositoryMetadata.stargazers_count || 0);

  return {
    points: [
      {
        date: repoCreatedAt,
        count: 0,
      },
      {
        date: latestKnownAt,
        count: currentStars,
      },
    ],
    totalStars: currentStars,
    exact: false,
    note: 'Fallback preview from current GitHub star count',
  };
}

// Y 轴最大值向上取整到易读刻度，避免最高点贴近顶部边界。
function niceCeil(value) {
  if (value <= 1) {
    return 1;
  }

  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const niceFraction = [1, 2, 3, 5, 10].find((candidate) => fraction <= candidate) || 10;

  return niceFraction * base;
}

// Y 轴刻度按 4 段左右生成，并确保最后一个刻度覆盖最高 star 数。
function buildYTicks(maxCount) {
  const yMax = niceCeil(Math.max(1, maxCount));
  const step = niceCeil(yMax / 4);
  const ticks = [];

  for (let value = 0; value <= yMax; value += step) {
    ticks.push(value);
  }

  // 最大刻度必须覆盖最高 star 数，避免折线顶到图表边界。
  if (ticks.at(-1) < yMax) {
    ticks.push(yMax);
  }

  return {
    yMax,
    ticks,
  };
}

// X 轴按时间范围均分，单点数据只返回一个刻度，避免除零。
function buildXTicks(minTime, maxTime, tickCount) {
  if (minTime === maxTime) {
    return [minTime];
  }

  return Array.from({ length: tickCount }, (_, index) => {
    const ratio = index / (tickCount - 1);
    return minTime + (maxTime - minTime) * ratio;
  });
}

// 精确数据绘制阶梯线，兜底预览绘制普通折线，避免把近似数据伪装成真实增长节点。
function buildPath(points, xScale, yScale, exact) {
  if (points.length === 0) {
    return '';
  }

  const [firstPoint, ...restPoints] = points;
  let path = `M ${formatCoord(xScale(firstPoint.time))} ${formatCoord(yScale(firstPoint.count))}`;

  for (const point of restPoints) {
    const x = formatCoord(xScale(point.time));
    const y = formatCoord(yScale(point.count));

    // 真实 stargazer 时间序列使用阶梯线，表达 star 数只在具体时间点增加。
    if (exact) {
      path += ` H ${x} V ${y}`;
    } else {
      path += ` L ${x} ${y}`;
    }
  }

  return path;
}

// SVG 渲染流程负责归一化日期、构造坐标轴、折线路径和深浅色自适应样式。
function renderSvg(series) {
  const plotWidth = chartWidth - chartMargin.left - chartMargin.right;
  const plotHeight = chartHeight - chartMargin.top - chartMargin.bottom;
  const normalizedPoints = series.points
    .map((point) => ({
      ...point,
      time: Date.parse(point.date),
    }))
    .filter((point) => Number.isFinite(point.time));

  // 没有有效日期时无法构造坐标轴，必须失败以免生成空白图片。
  if (normalizedPoints.length === 0) {
    throw new Error('No valid star history points to render.');
  }

  const minTime = Math.min(...normalizedPoints.map((point) => point.time));
  const maxTime = Math.max(...normalizedPoints.map((point) => point.time));
  const timeSpan = Math.max(1, maxTime - minTime);
  const { yMax, ticks: yTicks } = buildYTicks(series.totalStars);
  const xTicks = buildXTicks(minTime, maxTime, 5);
  const xScale = (time) => chartMargin.left + ((time - minTime) / timeSpan) * plotWidth;
  const yScale = (count) => chartMargin.top + plotHeight - (count / yMax) * plotHeight;
  const linePath = buildPath(normalizedPoints, xScale, yScale, series.exact);
  const firstPoint = normalizedPoints[0];
  const lastPoint = normalizedPoints.at(-1);
  const baselineY = yScale(0);
  const areaPath = `${linePath} L ${formatCoord(xScale(lastPoint.time))} ${formatCoord(baselineY)} L ${formatCoord(xScale(firstPoint.time))} ${formatCoord(baselineY)} Z`;
  const latestLabel = `${formatNumber(series.totalStars)} stars`;
  const statusLabel = series.exact ? 'Exact stargazer timeline' : 'Preview until GitHub Actions refreshes exact data';
  const yGrid = yTicks
    .map((tick) => {
      const y = formatCoord(yScale(tick));
      return `<line class="grid" x1="${chartMargin.left}" y1="${y}" x2="${chartWidth - chartMargin.right}" y2="${y}" />`;
    })
    .join('\n    ');
  const yLabels = yTicks
    .map((tick) => {
      const y = formatCoord(yScale(tick) + 4);
      return `<text class="axis-label" x="${chartMargin.left - 14}" y="${y}" text-anchor="end">${formatNumber(tick)}</text>`;
    })
    .join('\n    ');
  const xLabels = xTicks
    .map((tick) => {
      const x = formatCoord(xScale(tick));
      return `<text class="axis-label" x="${x}" y="${chartHeight - 30}" text-anchor="middle">${formatDateLabel(tick)}</text>`;
    })
    .join('\n    ');
  const latestX = formatCoord(xScale(lastPoint.time));
  const latestY = formatCoord(yScale(lastPoint.count));
  const repositoryLabel = escapeXml(repository);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-labelledby="title desc">
  <title id="title">Star History for ${repositoryLabel}</title>
  <desc id="desc">${escapeXml(series.note)}.</desc>
  <style>
    .chart-bg { fill: #ffffff; }
    .title { fill: #111827; font: 700 26px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .subtitle { fill: #4b5563; font: 500 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .axis-label { fill: #64748b; font: 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .grid { stroke: #e5e7eb; stroke-width: 1; }
    .axis { stroke: #94a3b8; stroke-width: 1.2; }
    .area { fill: url(#starGradient); opacity: 0.28; }
    .line { fill: none; stroke: #2563eb; stroke-width: 3.2; stroke-linecap: round; stroke-linejoin: round; }
    .dot { fill: #2563eb; stroke: #ffffff; stroke-width: 3; }
    .badge { fill: #eff6ff; stroke: #bfdbfe; }
    .badge-text { fill: #1d4ed8; font: 700 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .status { fill: #6b7280; font: 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    @media (prefers-color-scheme: dark) {
      .chart-bg { fill: #0d1117; }
      .title { fill: #f8fafc; }
      .subtitle { fill: #cbd5e1; }
      .axis-label { fill: #94a3b8; }
      .grid { stroke: #1f2937; }
      .axis { stroke: #475569; }
      .dot { stroke: #0d1117; }
      .badge { fill: #172554; stroke: #1d4ed8; }
      .badge-text { fill: #bfdbfe; }
      .status { fill: #94a3b8; }
    }
  </style>
  <defs>
    <linearGradient id="starGradient" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#2563eb" stop-opacity="0.72" />
      <stop offset="100%" stop-color="#2563eb" stop-opacity="0" />
    </linearGradient>
  </defs>
  <rect class="chart-bg" width="${chartWidth}" height="${chartHeight}" rx="18" />
  <text class="title" x="${chartMargin.left}" y="42">Star History</text>
  <text class="subtitle" x="${chartMargin.left}" y="64">${repositoryLabel}</text>
  <g>
    ${yGrid}
    <line class="axis" x1="${chartMargin.left}" y1="${chartMargin.top}" x2="${chartMargin.left}" y2="${baselineY}" />
    <line class="axis" x1="${chartMargin.left}" y1="${baselineY}" x2="${chartWidth - chartMargin.right}" y2="${baselineY}" />
    ${yLabels}
    ${xLabels}
  </g>
  <path class="area" d="${areaPath}" />
  <path class="line" d="${linePath}" />
  <circle class="dot" cx="${latestX}" cy="${latestY}" r="6" />
  <rect class="badge" x="${chartWidth - 178}" y="28" width="130" height="34" rx="17" />
  <text class="badge-text" x="${chartWidth - 113}" y="50" text-anchor="middle">${escapeXml(latestLabel)}</text>
  <text class="status" x="${chartWidth - chartMargin.right}" y="${chartHeight - 12}" text-anchor="end">${escapeXml(statusLabel)}</text>
</svg>
`;
}

// 主流程先取仓库元数据，再优先生成精确走势图；本地无 token 时才降级为可显示预览图。
async function main() {
  const repositoryMetadata = await fetchRepositoryMetadata();
  let series;

  try {
    const stargazers = await fetchStargazers();
    series = buildExactSeries(stargazers, repositoryMetadata);
  } catch (error) {
    // 本地无 token 时允许生成可显示的预览图；CI 中失败可避免自动提交错误趋势。
    if (!allowFallback) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Unable to fetch exact stargazer history, using fallback preview: ${reason}`);
    series = buildFallbackSeries(repositoryMetadata);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, renderSvg(series), 'utf8');
  console.log(`Generated ${outputPath}`);
}

main().catch((error) => {
  // 顶层异常输出保留状态码和正文，方便在 Actions 日志中定位 GitHub 鉴权或限流问题。
  console.error(error);
  if (error instanceof GithubApiError && error.body) {
    console.error(error.body);
  }
  process.exitCode = 1;
});
