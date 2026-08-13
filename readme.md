# Yohaku Remote Deploy

通过 GitHub Actions 构建 Yohaku Docker 镜像，推送到 GitHub Container Registry (GHCR)，并调用 Dokploy API 触发部署。

## 路线（routes）

两套并行：

| route | 源分支 | rolling tags | immutable tag | dokploy app secret |
|-------|--------|--------------|---------------|--------------------|
| `main`  | `main` (Next.js, 未来合 remix 后变 RR7) | `latest`, `main`, `nextjs` | `main-<sha>` | `DOKPLOY_APP_ID_MAIN` |
| `remix` | `refactor/remix` (React Router 7)        | `remix`                    | `remix-<sha>` | `DOKPLOY_APP_ID_REMIX` |

`:latest` 永远跟 main，合并完成自然指向 RR7；`:nextjs` 是 Next.js 阶段之别名，merge 之日删除 `deploy-main.yml` 中此 tag，最后一份 build 即自动锁定为 Next.js archive。

## 工作流

```
yohaku 仓 push (main / refactor/remix)
       ↓
yohaku 仓 notify-remote-deploy.yml 调 repository_dispatch
       ↓
yohaku-remote-deploy 编排仓 deploy-<route>.yml
       ↓
检查 build_hash.<route> 去重 → 构建 Dockerfile → 推 GHCR
       ↓
调 Dokploy API 触发 redeploy
       ↓
Dokploy 拉新 image，部署
```

## 文件

```
.github/workflows/
  deploy-main.yml      # main route
  deploy-remix.yml     # remix route
  testflight.yml       # iOS TestFlight（EAS build + submit）
build_hash.main        # main route 去重指针（CI 自动维护）
build_hash.remix       # remix route 去重指针（CI 自动维护）
```

## Dokploy 配置

### Registry credential

`Dashboard → Settings → Registry → Add Registry`：

| 字段 | 值 |
|------|-----|
| Name | `ghcr` |
| Registry URL | `ghcr.io` |
| Username | GitHub 用户名 |
| Password | GitHub PAT (`read:packages`) |

### Application（main）

- buildType: `dockerImage`
- dockerImage: `ghcr.io/innei/yohaku:latest`
- registry: `ghcr`

### Application（remix）

- buildType: `dockerImage`（务必从 `dockerfile` 切到 `dockerImage`）
- sourceType: `docker`（务必从 `github` 切到 `docker`，避免 dokploy 端再 build）
- dockerImage: `ghcr.io/innei/yohaku:remix`
- registry: `ghcr`

> autoDeploy 可关可不关。GitHub Actions 完成后会显式 curl `application.deploy` 触发 redeploy。

## 触发方式

| 来源 | 触发哪个 workflow |
|------|------------------|
| yohaku 仓 push main           | `repository_dispatch` `trigger-main` → `deploy-main.yml` |
| yohaku 仓 push refactor/remix | `repository_dispatch` `trigger-remix` → `deploy-remix.yml` |
| yohaku 仓手动 TestFlight      | `repository_dispatch` `trigger-testflight` → `testflight.yml` |
| 手动                          | `workflow_dispatch`（部署支持 `force_build`；TestFlight 支持 `source_ref` / `notes`） |

编排仓自身 push **不再**触发任何 build（避免改 workflow 时误触发部署）。

## GitHub Secrets（yohaku-remote-deploy 仓）

| Secret | 说明 |
|--------|------|
| `GH_PAT` | 可访问 `innei-dev/yohaku` 私有仓的 PAT（`repo` scope） |
| `DOKPLOY_URL` | Dokploy 实例地址（不带尾部斜杠） |
| `DOKPLOY_API_TOKEN` | Dokploy API Key |
| `DOKPLOY_APP_ID_MAIN`  | main route 的 Dokploy Application ID |
| `DOKPLOY_APP_ID_REMIX` | remix route 的 Dokploy Application ID |
| `BASE_URL` | Docker build-arg，站点根 URL（无尾部斜杠） |
| `TELEGRAM_BOT_TOKEN` | （可选）Telegram 通知用 bot token |
| `AFTER_DEPLOY_SCRIPT` | （可选）部署后执行的 shell 脚本 |
| `EXPO_TOKEN` | TestFlight 必填。Expo access token（https://expo.dev/settings/access-tokens） |
| `EXPO_ASC_APP_ID` | （可选）App Store Connect Apple ID（数字）。填了会写入本次 `eas.json` submit |
| `EXPO_ASC_API_KEY` | （可选）App Store Connect API key 的 `.p8` 全文 |
| `EXPO_ASC_API_KEY_ID` | （可选）与上一行配套的 Key ID |
| `EXPO_ASC_API_KEY_ISSUER_ID` | （可选）与上一行配套的 Issuer ID |

## TestFlight

```
yohaku 仓 Actions → Trigger Remote TestFlight
       ↓
repository_dispatch  event_type=trigger-testflight
       ↓
yohaku-remote-deploy  testflight.yml
       ↓
checkout innei-dev/yohaku@source_ref（含 submodule）
       ↓
eas build -p ios --profile production --wait --auto-submit
       ↓
App Store Connect → TestFlight
```

不跟 `build_hash.*` 去重：每次 dispatch 都打一个新 build number。同一时间只跑一条（`concurrency: testflight`，不取消进行中的提交）。

### 一次性准备

1. App Store Connect 建好 App，Bundle ID 必须是 `in.innei`，Team `KAMM5N88X3`（Yuhao Jiang）。建完把数字 Apple ID 填进 `EXPO_ASC_APP_ID`（或写进源仓 `apps/mobile/eas.json` 的 `submit.production.ios.ascAppId`）。
2. 在本机：`cd apps/mobile && npx eas-cli login && npx eas-cli init`，把 `expo.extra.eas.projectId` 写进 `app.json` 并提交。
3. 配置签名：`npx eas-cli credentials -p ios`，选 production / App Store distribution。CI 只持有 `EXPO_TOKEN` 就能复用 Expo 上的证书和 profile。
4. 推荐再在 App Store Connect → Users and Access → Integrations → App Store Connect API 建一把 **App Manager** key，把 `.p8` / Key ID / Issuer ID 放进上面三个 `EXPO_ASC_*` secret，避免 submit 阶段 2FA。
5. 源仓 `innei-dev/yohaku` 已有 `.github/workflows/trigger-testflight.yml`，沿用现有 `secrets.PAT` 对编排仓发 `repository_dispatch`。

### 触发

- 源仓：Actions → **Trigger Remote TestFlight**。`ref` 留空则构建当前 run 的 SHA；也可以填 `feat/rn` 或某个 commit。
- 编排仓：Actions → **TestFlight (iOS)**，直接填 `source_ref`。

## yohaku 仓 notify 配置

`innei-dev/yohaku` 仓内 `.github/workflows/notify-remote-deploy.yml`，监听 `push: branches: [main, refactor/remix]`，按分支名调对应 `repository_dispatch` event。需要在 yohaku 仓配置：

| Secret | 说明 |
|--------|------|
| `YOHAKU_REMOTE_DEPLOY_PAT` | 可对 `Innei/yohaku-remote-deploy` 执行 `repository_dispatch` 的 PAT（`repo` scope） |

## 强制重建

在编排仓的 Actions 页面手动跑 workflow，勾 `force_build: true`，忽略 `build_hash.<route>` 比较直接 rebuild。

## 故障排除

### Build 阶段：镜像推送失败

1. `GITHUB_TOKEN` 需要 `packages: write`（workflow 已声明）
2. 仓库 Settings → Actions → General → Workflow permissions = `Read and write`
3. 仓库 Settings → Actions → General → Allow GitHub Actions to create and approve pull requests（store job push hash 用）

### Deploy 阶段：Dokploy 调用失败

1. `DOKPLOY_URL` 不带尾部斜杠
2. `DOKPLOY_API_TOKEN` 在 Dokploy `Profile → Generate API Key`
3. `DOKPLOY_APP_ID_*` 取自 Application URL 末段

### Dokploy 拉取 image 失败

1. Settings → Registry 已配 `ghcr` 凭证，PAT 含 `read:packages`
2. Application 配的 `dockerImage` 路径正确（注意 GHCR owner 大小写）
3. GHCR package 已公开，或 dokploy 凭证有访问权

## 切到 RR7 (main) 后的清理

当 `refactor/remix` 合并进 `main` 后：

1. 删 `deploy-remix.yml`、`build_hash.remix`
2. 删 `deploy-main.yml` 中 `:nextjs` tag（保留 `:latest` `:main` `:main-<sha>`）
3. Dokploy 删 remix application，main application `dockerImage` 不需要改
4. yohaku 仓 `notify-remote-deploy.yml` 去掉 `refactor/remix` 分支
