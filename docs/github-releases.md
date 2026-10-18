# GitHub 版本管理与发布

GitHub 用于保存 Recall 源码和发布 Windows 软件包。办公室任务、备注、实际进展、附件、草稿、业务备份及 OpenCode 认证继续保存在各自电脑，不通过 GitHub 同步。

已确认使用公开仓库 [Hin1120X/ReCall](https://github.com/Hin1120X/ReCall)，办公室可直接访问 [Releases](https://github.com/Hin1120X/ReCall/releases) 下载软件。本地接续原有 README 初始提交，GitHub 浏览器登录及推送预检通过；用户允许沿用已核实的 Hin1120X 及 GitHub 隐私邮箱，仅为本项目配置提交身份。云端构建与发布结果见 [Actions](https://github.com/Hin1120X/ReCall/actions) 和 [实施记录](implementation-plan.md)；工作流文件存在不代表执行成功。

首次 [Recall 0.5.0](https://github.com/Hin1120X/ReCall/releases/tag/v0.5.0) 已于2026-10-19发布，CI与Release工作流均成功。已匿名下载公开软件ZIP，核对外部SHA-256、全部138个程序文件及离线升级预览；本机原程序和业务数据未替换。

## 自动检查与发布范围

- `.github/workflows/ci.yml`：推送 `main` 或提交 PR 时，在 GitHub 托管的 Windows x64 环境使用 Node.js 24，执行 `npm ci`、类型检查、单元测试和构建。仓库权限为只读。
- `.github/workflows/release.yml`：仅推送 `v主版本.次版本.修订版本` 标签时发布，标签必须严格等于 `v` 加 `package.json` 中的版本。使用同样的安装、检查和测试，再运行 `npm run package`，该命令包含构建。
- 发布上传 `Recall-版本-Windows-x64.zip` 和同名 `.zip.sha256`，上传前检查文件存在并验证 ZIP 哈希。由该标签生成 Release，标记为 Latest；同标签已有 Release 时创建失败，不覆盖旧包。
- 普通 CI 没有发布权限。只有发布 job 获得 `contents: write`；上传步骤使用 GitHub 自动提供的 `GITHUB_TOKEN`，不需要把个人令牌写入代码或另存 OpenCode 密钥。

托管构建仅验证代码、单元测试和打包。全局双击 Shift、窗口前台与输入焦点、真实中文输入法、通知和办公室操作体验，仍需在本机或目标电脑验收；CI 通过不代表这些桌面行为已经通过。

工作流只使用 GitHub 官方 [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) 与 [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)，固定到对应完整提交 SHA。后续更新 Actions 时，应核对官方版本和对应提交。

## 开发电脑发布步骤

1. 提交准备发布的改动，确认本机相关检查及桌面验收通过。只从已验收的 `main` 提交创建发布标签。
2. 新版本先更新 `package.json` 和 `package-lock.json`。例如下一个修订版可运行 `npm version patch --no-git-tag-version`，随后更新版本说明并提交；不要为重发同一个包移动旧标签。
3. 已配置正确远程仓库后，在 PowerShell 中读取版本、创建标签并推送。以下命令供正式发布时执行，当前准备工作不会执行推送：

   ```powershell
   $releaseVersion = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
   git tag -a "v$releaseVersion" -m "Recall $releaseVersion"
   git push origin main
   git push origin "v$releaseVersion"
   ```

4. 在仓库的 Actions 页面检查 Release 工作流全部成功，再进入 Releases，确认相应版本含两个软件附件。首次接入仍须在 GitHub 实际跑通，不能以本地 YAML 检查替代。

版本不匹配、检查失败、软件包缺失或哈希不一致都会阻止发布。若发布因网络或权限失败，先检查 Releases：尚未创建 Release 时可重跑失败的工作流；已有同标签 Release 时不要强制覆盖、删标签重发，应核对现有附件，再用新版本号发布修正。

不要提交 `%LOCALAPPDATA%\Recall`、业务 `data`、备份、公司原始资料、认证文件或密钥，也不要强制添加本机缓存和发布目录。GitHub 发布的 ZIP 由干净的源码构建，办公室数据库不随程序包上传。

## 办公室首次部署

1. 打开 [Recall 最新发布入口](https://github.com/Hin1120X/ReCall/releases/latest)。当前仓库为公开仓库，下载无需登录；此入口始终指向标记为 Latest 的正式发布版。
2. 在该版本的 Assets 中下载 **`Recall-版本-Windows-x64.zip`**，并保留对应的 **`.zip.sha256`**。页面自动附带的 **Source code (zip/tar.gz)** 是源码，不是可运行的软件包。
3. 将软件 ZIP 完整解压到本机程序目录，双击其中 `Recall.exe`。不能只复制 EXE；办公室无需安装 Node.js、npm、Git 或下载项目源码。
4. 首次使用选择建立新记录；已有旧版记录则按接续提示选择原数据。正式数据位置为 `%LOCALAPPDATA%\Recall\data`，默认备份位于 `%LOCALAPPDATA%\Recall\backups`，以设置页显示的实际路径为准。

需要校验下载文件时，在两个文件所在目录运行，替换成实际版本文件名：

```powershell
$archivePath = 'Recall-版本-Windows-x64.zip'
$expectedHash = (Get-Content -LiteralPath "$archivePath.sha256" -Raw).Trim()
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedHash -notmatch '^[a-f0-9]{64}$' -or $expectedHash -cne $actualHash) {
  throw '文件校验失败，请重新下载，不要安装。'
}
```

SHA-256 用于发现下载损坏或变化，不是发布者数字签名；使用已确认仓库发布的附件。

## 办公室后续升级

下载 Latest 中比当前版本更新的完整软件 ZIP，在 Recall **工作台 → 设置与数据 → 选择离线更新包** 中选中它并核对版本。确认后程序保存草稿、完整备份、替换程序并重开，继续使用办公室原数据。当前没有自动联网检查或下载更新。

办公室无法直接访问 GitHub 时，可在家下载这两个发布附件，通过允许的离线方式带到办公室，再执行相同升级流程。不要把家里的数据库、备份或认证复制过去覆盖办公室数据。

手动更换程序或从更早版本升级的流程，以及失败后的数据保护边界，见 [本地部署与升级](deployment.md)。遇到迁移或升级错误应保留错误信息和原数据；不要用旧程序强行打开新版数据库，也不要用旧库覆盖现有库。

## 运行用量

发布打包仅在推送版本标签时运行；普通代码推送及 PR 仍会执行 CI。私有仓库的 GitHub 托管 runner 消耗账号或组织的 Actions 配额，超出额度可能计费或暂停，Windows 用量需在 GitHub 账单页查看。当前没有配置额外大型 runner，也没有上传 Actions 构建产物副本；实际规则以 [GitHub Actions 计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions) 为准。
