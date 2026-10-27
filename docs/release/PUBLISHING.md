# 如何发布到你自己的 GitHub 仓库与 Release

> 本仓库**不会**自动推送到任何地方。以下步骤由你（仓库所有者）手动执行。示例仓库名 `h-D-ACE/dsh-qq`。

## 1. 发布前检查（在仓库根目录）

```powershell
npm ci
npm run test:audit                 # Windows 上应全部通过；macOS / Linux 上 test-console-encoding.mjs 是已知失败（只适用于 Windows），v1.1.1 为 69/70
npm run privacy-scan               # 上游的隐私扫描：不应出现真实 QQ 号、本机路径、令牌
git status --short                 # 确认没有 config.json / state/ / node_modules / audio/ 被跟踪
```

`privacy-scan` 支持本机专用规则文件 `scripts/privacy-rules.json`（不入库，参照 `scripts/privacy-rules.example.json`），
建议把你自己的 QQ 号、群号、用户名、盘符路径写进去再跑一次。

## 2. 推送源码

```powershell
git remote add origin https://github.com/h-D-ACE/dsh-qq.git   # 已经设置过 origin 就跳过这一行
git push -u origin main
git tag -a v1.1.1 -m "qq-bridge-enhanced v1.1.1"
git push origin v1.1.1
```

> 不要向上游 `Derpyu520/qq-bridge` 推送；如需回馈上游，请在你的仓库里另开分支，通过 Pull Request 提交。

## 3. 生成 Release ZIP

```powershell
npm run release:zip
```

产物在**仓库外、与仓库同级**的 `release/` 文件夹（`<仓库>/../release/`，没有会自动创建；历次版本的包都放在这里，不占仓库目录）：
`qq-bridge-enhanced-v<版本>.zip` 与 `qq-bridge-enhanced-v<版本>.zip.sha256`。要放到别处：`node scripts/build-release.mjs --out <目录>`。
还没 `git add` 的新文件也要打进去时加 `--include-untracked`。
脚本只打包 `git ls-files` 列出的已跟踪文件（因此天然排除 `.gitignore` 里的 `config.json`、`state/`、`node_modules/` 等），
并在打包前做一次敏感文件检查（发现 `config.json`、`state/`、`*.log`、TOTP 秘密等会直接失败）。
不在 git 仓库里运行时，脚本退回到内置的排除清单。

## 4. 创建 GitHub Release

网页：仓库 → Releases → Draft a new release → 选择标签 `v<版本>`（例如 `v1.0.0`）→ 标题 `qq-bridge-enhanced v<版本>` →
正文粘贴 `docs/release/RELEASE_NOTES_v<版本>.md` 的内容 → 上传 `../release/` 下这个版本的两个文件 → Publish。

或用 GitHub CLI：

```powershell
gh release create v1.1.1 ../release/qq-bridge-enhanced-v1.1.1.zip ../release/qq-bridge-enhanced-v1.1.1.zip.sha256 `
  --repo h-D-ACE/dsh-qq --title "qq-bridge-enhanced v1.1.1" --notes-file docs/release/RELEASE_NOTES_v1.1.1.md
```

**不要**把 SnowLuma 的安装包、`node_modules`、你的 `config.json` 或 `state/` 作为 Release 附件上传。

## 5. 发布后

部署时把仓库地址 https://github.com/h-D-ACE/dsh-qq 和 `docs/DSH_DEPLOYMENT.md` 交给 DSH agent 即可。
