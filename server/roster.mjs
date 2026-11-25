// 成员表：群里有哪些 AI 成员。每位成员一行，界面、派活、点名、图标、颜色、密钥隔离都从这里读。
// 群主在设置里可以启用、停用每一位，也可以改它的分工（存在 data/settings.json 的 members 里，见 members.mjs）。
//
// 加一位新成员：
//   · 它的命令行支持 ACP（Agent Client Protocol：Kimi Code、Qwen Code、Gemini CLI、OpenCode、Copilot CLI 等都支持）：
//     在下面加一行，adapter: 'acp'，acp: { command, args } 写清怎么以 ACP 方式启动它，就够了（见 Kimi 那行）。
//     模型、推理强度用它自己的默认；想指定，在设置里“自己加的模型”加上它认的模型名。
//   · 不支持 ACP 的：在 server/agents/ 里写一个专用接入文件（照 claude.mjs、codex.mjs、deepseek.mjs 的样子：detect / start，
//     能插话就加 inject），再在 main.mjs 的 ADAPTER_MODULES 里登记。
//   · 都可以选做：在 models.mjs 的 BUILTIN 里列出它的模型、members.mjs 的 DEFAULT_TIERS 写三档默认；quota.mjs 里加读额度的办法。
// title、role 不写就是“通用干活”，群主之后可以在设置里改。
// 这里的字段都是“出厂值”，代码里别处不要再写死成员名字。

// 新成员没写分工时用这两句
export const GENERIC_TITLE = '通用干活';
export const GENERIC_ROLE = '你是通用成员：群主或协调员派什么活你就做什么，按任务卡写的交付物和验收条件交付。拿不准该不该做的，在回复里 @群主 问。';

const ROWS = [
  {
    name: 'Claude',
    adapter: 'claude',                         // server/agents/ 里的哪个接入文件（main.mjs 的 ADAPTER_MODULES）
    accountLabel: 'Claude 订阅',
    coordinator: true,                         // 没人被点名的需求由它接。它停用时，由表里第一位启用的成员接
    title: '协调员 · 干活主力：方案、界面、文档、实现和审查',
    role:
      '你是默认协调员、需求和审查负责人，也是干活的主力：方案、界面、文档和一般的代码实现默认由你承担，不只做拆单和审查。' +
      '没人被点名的需求由你接：把它拆成任务卡，写清负责人、交付物和验收条件。派活时看各成员是否已连接、额度还剩多少，谁的额度多就多偏向谁。' +
      '你自己写的东西必须交给另一位成员审，不能自己审自己。',
    aliases: ['claude', '克劳德'],             // 群里 @ 这些写法都算点它（不分大小写）
    color: { light: '#d4633a', dark: '#ff8a5c' },   // 取自它自己的图标
    icon: [{ app: 'Claude.app' }],             // 头像从这台电脑上装好的哪个应用里取（只写 app 就用应用自己的图标）
    parallel: 3,                               // 一个项目里默认最多同时开几个会话（群主可在项目设置里改）
    secrets: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],   // 只给它自己，别的成员的进程里会去掉
  },
  {
    name: 'Codex',
    adapter: 'codex',
    accountLabel: 'ChatGPT 订阅（Codex）',
    title: '工程负责人：自动化脚本、转换程序、接入和测试',
    role:
      '你是工程负责人：做自动化脚本、接入、集成和测试。遇到看不懂的文件格式，可以 @ 分工里管格式分析的成员。' +
      '完成后提交实际文件、运行方法和测试结果，交给另一位成员审查。工程量大或你的额度紧张时，协调员会分担实现，你改做审查。',
    aliases: ['codex', 'gpt'],
    color: { light: '#5560e8', dark: '#8f98ff' },
    icon: [{ app: 'ChatGPT.app', file: 'Contents/Resources/icon-codex-light.png' }, { app: 'Codex.app' }],
    iconDark: [{ app: 'ChatGPT.app', file: 'Contents/Resources/icon-codex-dark-color.png' }, { app: 'Codex.app' }],
    parallel: 2,
    secrets: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  },
  {
    name: 'DeepSeek',
    adapter: 'deepseek',
    accountLabel: 'DeepSeek API（按量付费）',
    payPerUse: true,                           // 按量付费：不自动升档、默认不并行、提示词里提醒它省着用
    title: '逆向与兼容性分析：文件格式和版本差异',
    role:
      '你负责对群主自有或获授权的软件、文件格式和版本差异做分析：对照样例找出字段变化，提交样例、证据、结论和未知项，再交给负责实现的成员。' +
      '只分析项目里提供的材料。',
    aliases: ['deepseek', 'ds'],
    color: { light: '#1f7fd1', dark: '#45c8f0' },
    icon: [{ app: 'DeepSeek Harness.app' }],
    parallel: 1,
    secrets: ['DEEPSEEK_API_KEY'],
  },
  {
    // 走通用 ACP 接入。出厂停用：要用的人先装好 Kimi Code 命令行并登录，再到设置里打开
    name: 'Kimi',
    adapter: 'acp',
    acp: {
      command: 'kimi', args: ['acp'],
      installFix: '安装 Kimi Code 命令行：npm i -g @moonshot-ai/kimi-code（或 curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash），装好后重启工作台',
      // 登录过的标志：设备码登录存的凭据，或者在配置里填了开放平台的 API key
      auth: { files: ['~/.kimi-code/credentials'], configHas: [['~/.kimi-code/config.toml', 'api_key']] },
      loginFix: '在终端运行：kimi login --region mainland-cn（用 Kimi 会员登录）；或者运行 kimi，用 /login 填 Kimi 开放平台的 API key',
    },
    enabled: false,
    accountLabel: 'Kimi 会员或开放平台 API',
    aliases: ['kimi', '月之暗面'],
    color: { light: '#7c3aed', dark: '#b794ff' },
    icon: [{ app: 'Kimi.app' }, { app: 'Kimi Code.app' }],
    parallel: 1,
    secrets: ['KIMI_MODEL_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  },
];

const NAME_RE = /^[A-Za-z][A-Za-z0-9]{1,19}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
function check(rows) {
  const seen = new Set();
  for (const r of rows) {
    if (!NAME_RE.test(r.name)) throw new Error(`成员表：名字「${r.name}」只能是字母开头的字母和数字`);
    if (seen.has(r.name.toLowerCase())) throw new Error(`成员表：「${r.name}」重复了`);
    seen.add(r.name.toLowerCase());
    if (!r.adapter) throw new Error(`成员表：「${r.name}」没写 adapter`);
    if (r.adapter === 'acp' && !r.acp?.command) throw new Error(`成员表：「${r.name}」走 ACP，要写 acp.command`);
    for (const c of [r.color?.light, r.color?.dark]) if (c && !COLOR_RE.test(c)) throw new Error(`成员表：「${r.name}」的颜色要写成 #rrggbb`);
  }
  if (rows.filter((r) => r.coordinator).length > 1) throw new Error('成员表：只能有一位默认协调员');
  return rows;
}

// 补上没写的字段，冻结起来：别处只读不改
export function buildRoster(rows) {
  return Object.freeze(check(rows).map((r) => Object.freeze({
    payPerUse: false, coordinator: false, enabled: true, parallel: 1, secrets: [], aliases: [],
    color: { light: '#6b7280', dark: '#a3a3a3' }, icon: [],
    ...r,
    title: r.title || GENERIC_TITLE,
    role: r.role || GENERIC_ROLE,
    aliases: [...new Set([r.name.toLowerCase(), ...(r.aliases ?? []).map((x) => String(x).toLowerCase())])],
    id: r.name.toLowerCase(),                  // 图标文件名等地方用的小写名字
  })));
}
export const ROSTER = buildRoster(ROWS);
export const ALL_AGENTS = Object.freeze(ROSTER.map((r) => r.name));
export const rowOf = (name) => ROSTER.find((r) => r.name === name) ?? null;
