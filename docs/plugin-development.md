# 独立开发插件

插件不需要放在 snap-rail 工作区内开发。推荐每个插件独立维护一个 Gitea 仓库，在仓库中安装 `@snap-rail/plugin-sdk`，用 SDK 提供的 manifest schema、tsdown 构建预设和 CLI 完成开发与发布。

```sh
pnpm dlx snap-rail-plugin init my-driver --template driver
cd my-driver
pnpm install
pnpm build
snap-rail-plugin doctor .
```

CLI 生成的 `AGENTS.md` 是插件仓库的短规范：它列出允许的 SDK 入口、manifest、能力声明、Host/Renderer 边界和发行物规则。Agent 只需阅读该文件与 `@snap-rail/plugin-sdk` 的类型声明，不需要扫描 snap-rail 主仓库。

## Manifest 是插件的协议入口

`package.json` 的 `snapRail` 必须通过 `snapRailManifestSchema` 校验。插件要明确声明 `kind`、`layer`、`framework`、`clientOnly`、`client.entry`，以及 `capabilities.provides/requires`。能力是版本化的服务契约，例如驱动声明：

```json
{
  "snapRail": {
    "kind": "driver",
    "layer": "equipment",
    "capabilities": {
      "requires": [{ "id": "equipment.runtime", "range": "^1.0.0" }]
    }
  }
}
```

能力提供者和消费者都必须在 manifest 中写出版本范围。Host 侧使用 `hostBundle`，Renderer 侧使用 `clientBundle`；Renderer 只允许使用 SDK 文档列出的种子模块和 `./contract` 纯契约面。驱动使用纯类型的 `@snap-rail/equipment/driver` 注册契约，只有 Host 面导入 `@snap-rail/equipment` 服务。

## 发布签名

发布者用 Ed25519 私钥对发行 manifest 和每个发行文件的 SHA-256 摘要签名。签名发行物包含 `META-INF/release.json` 与 `META-INF/signature.json`。客户端安装前先验文件摘要、签名算法、key id 和 publisher，再解压到插件池。

首次建立发布者身份时运行 `pnpm run plugin:generate-key -- .keys gitea-main-2026 --publisher snap-rail`。私钥只留在发布机，`.public.pem` 或生成的 trust JSON 才进入客户端部署配置；打包时传 `pnpm run pack:plugins -- --sign-key .keys/gitea-main-2026.private.pem --key-id gitea-main-2026 --publisher snap-rail`。

客户端的信任根位于 `<home>/trusted-release-keys.json`，它不在插件池中，因此插件不能通过安装自身来授权自身。文件形状：

```json
{
  "keys": [
    {
      "keyId": "gitea-main-2026",
      "publisher": "snap-rail",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----"
    }
  ]
}
```

## 本地 Gitea + Nginx 验证

Gitea 负责源码仓库和发布权限，Nginx 只托管静态插件源。主仓库的 `deploy.nginx.example.conf` 提供了 `/plugins/`、`/desktop/` 和根目录的静态映射。先在本地生成发行 zip，再运行：

```sh
pnpm run plugin:generate-key -- .keys gitea-main-2026 --publisher snap-rail
pnpm run publish:local -- --sign-key .keys/gitea-main-2026.private.pem --key-id gitea-main-2026 --publisher snap-rail
pnpm run verify:market -- --feed dist-publish/plugins --trust .keys/gitea-main-2026.trust.json
```

将 `deploy.config.json` 的同步目标设置为 Nginx 的静态目录，客户端的插件源设置为 `http://127.0.0.1:8088/plugins/`。市场 feed 只携带包名、版本、文件名、sha256、签名 key id 和能力元数据；下载地址由客户端把纯文件名解析到已配置的 feed 根地址，不能由 feed 条目注入任意 URL。

组合（recipe）仍然是静态 JSON/YAML。客户端逐个完成签名校验和安装，所有插件成功后才原子写入预设文件；Gitea 的 PR 可以审核源码，Nginx 的目录可以被离线复制到工控机。
