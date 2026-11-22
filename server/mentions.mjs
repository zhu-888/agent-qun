// @ 解析。只有成员“自己说的话”里的 @ 才算点名：
// 引用行（> 开头）、代码块、行内代码、日志里的 @ 一律不触发派单。

export const OWNER = '群主';

const ALIASES = {
  claude: 'Claude', 克劳德: 'Claude',
  codex: 'Codex', gpt: 'Codex',
  deepseek: 'DeepSeek', ds: 'DeepSeek',
  群主: OWNER, 我: OWNER, owner: OWNER,
};

// 去掉不该触发 @ 的部分，返回“成员自己说的话”
export function spokenText(text) {
  let t = String(text ?? '');
  t = t.replace(/```[\s\S]*?```/g, ' ');     // 围栏代码块
  t = t.replace(/`[^`\n]*`/g, ' ');          // 行内代码
  t = t
    .split('\n')
    .filter((l) => !/^\s*[>＞]/.test(l))     // 引用行
    .join('\n');
  return t;
}

// 返回被点名的成员名（去重，保持出现顺序）
export function parseMentions(text, { exclude } = {}) {
  const t = spokenText(text);
  const out = [];
  const re = /[@＠]([A-Za-z一-龥][A-Za-z0-9一-龥_-]*)/g;
  let m;
  while ((m = re.exec(t))) {
    // 邮箱里的 @ 不算：@ 前面紧挨着字母数字
    const before = m.index > 0 ? t[m.index - 1] : '';
    if (/[A-Za-z0-9._-]/.test(before)) continue;
    const raw = m[1];
    // 中文名后面常直接跟正文（“@群主请验收”），所以按别名的前缀匹配
    const key = Object.keys(ALIASES)
      .sort((a, b) => b.length - a.length)
      .find((k) => raw.toLowerCase().startsWith(k) &&
        // 英文别名后面不能再跟字母（@Codexer 不是 @Codex）
        !(/[a-z]/i.test(k.at(-1)) && /[A-Za-z0-9_]/.test(raw[k.length] ?? '')));
    if (!key) continue;
    const name = ALIASES[key];
    if (name === exclude) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
