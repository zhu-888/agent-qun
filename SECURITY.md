# 安全问题怎么报告

发现安全问题（比如别的网页能操作本机的工作台、成员能逃出写入边界、手机配对能被绕过），请不要开公开 issue。

请在仓库页面点 **Security → Report a vulnerability**，用 GitHub 的私下报告提交。写清楚：怎么复现、影响是什么、用的 macOS 和 Node.js 版本。

README 里“安全：防手滑，不防恶意”一节列出的几条（成员能读你的文件、能联网、Claude 和 DeepSeek 能写项目以外的位置、Codex 能连本机端口、不能推送只防误推）是已知的设计边界，不算漏洞；能绕过那一节说“能防”的东西，才是要报告的问题。

这是个人项目，有空才看，不保证回复时间。

---

Please do not open public issues for security problems. Use GitHub's private vulnerability reporting (Security → Report a vulnerability) instead.
