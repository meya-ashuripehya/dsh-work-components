/**
 * 棋类辅助引擎：只从官方发布页按需下载，作为独立进程运行（stdin/stdout 协议），不并入、不链接、不提交到本仓库。
 * 版本、下载地址与 sha256 全部钉死；升级时同时改这里与 README「依赖」一节。
 *
 * 平台键：`${process.platform}-${process.arch}`。bins 依次试用：前一个起不来（CPU 不支持 AVX2 等）就换下一个。
 * 资产里带 fallback 的（KataGo）：主资产的程序都起不来时，再下载 fallback 资产。
 */

const GH = 'https://github.com'

export const ASSIST_ENGINES = {
  xiangqi: {
    game: 'xiangqi',
    id: 'pikafish',
    name: 'Pikafish',
    repo: `${GH}/official-pikafish/Pikafish`,
    license: 'GPL-3.0',
    version: 'Pikafish-2026-09-06',
    protocol: 'uci',
    // 一个 7z 内含各平台程序与 pikafish.nnue
    assets: {
      common: {
        url: `${GH}/official-pikafish/Pikafish/releases/download/Pikafish-2026-09-06/Pikafish.2026-09-06.7z`,
        sha256: '41952bbfe2520faceb5902c69e6ab4845cc999841d2b49a95cc1be7867a25e5b',
        size: 53603424,
        kind: '7z',
      },
    },
    bins: {
      'win32-x64': ['Pikafish-Windows-x86-64-universal.exe'],
      'linux-x64': ['Pikafish-Linux-x86-64-universal'],
      'darwin-x64': ['Pikafish-MacOS-universal'],
      'darwin-arm64': ['Pikafish-MacOS-universal'],
    },
    files: ['pikafish.nnue'],
    binPrefix: 'Pikafish-',
  },
  chess: {
    game: 'chess',
    id: 'stockfish',
    name: 'Stockfish',
    repo: `${GH}/official-stockfish/Stockfish`,
    license: 'GPL-3.0',
    version: 'sf_19',
    protocol: 'uci',
    // universal 构建在运行时自选 AVX2 / AVX-512 / SSE 等指令集
    assets: {
      'win32-x64': {
        url: `${GH}/official-stockfish/Stockfish/releases/download/sf_19/stockfish-windows-x86-64-universal.zip`,
        sha256: '3c8bf1f9ea66a09350a40df4f632288285ac206d99f33ab5842c408fc30b48a7',
        size: 81431614,
        kind: 'zip',
      },
      'linux-x64': {
        url: `${GH}/official-stockfish/Stockfish/releases/download/sf_19/stockfish-linux-x86-64-universal.tar.gz`,
        sha256: '9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f',
        size: 81388977,
        kind: 'tgz',
      },
      'linux-arm64': {
        url: `${GH}/official-stockfish/Stockfish/releases/download/sf_19/stockfish-linux-arm64-universal.tar.gz`,
        sha256: 'fe26cfd1d9db4c8af3d21e24d9ff34cacb31c1f940085a7583da11796f2bac01',
        size: 80181250,
        kind: 'tgz',
      },
      'darwin-arm64': {
        url: `${GH}/official-stockfish/Stockfish/releases/download/sf_19/stockfish-macos-universal.tar.gz`,
        sha256: 'a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77',
        size: 82323876,
        kind: 'tgz',
      },
    },
    bins: {
      'win32-x64': ['stockfish/stockfish-windows-x86-64-universal.exe'],
      'linux-x64': ['stockfish/stockfish-linux-x86-64-universal'],
      'linux-arm64': ['stockfish/stockfish-linux-arm64-universal'],
      'darwin-arm64': ['stockfish/stockfish-macos-universal'],
    },
    files: [],
  },
  gomoku: {
    game: 'gomoku',
    id: 'rapfi',
    name: 'Rapfi',
    repo: `${GH}/dhbloo/rapfi`,
    license: 'GPL-3.0',
    version: '250615',
    protocol: 'piskvork',
    // 官方发布包 Rapfi-engine.7z 内含各平台程序、config.toml 与 networks 仓库的 mix9svq 权重
    assets: {
      common: {
        url: `${GH}/dhbloo/rapfi/releases/download/250615/Rapfi-engine.7z`,
        sha256: '1a3e24024062a153ac079060ee9589a37c6bdd1ecc54fed3908793c519594e05',
        size: 36786619,
        kind: '7z',
      },
    },
    bins: {
      'win32-x64': ['pbrain-rapfi-windows-avx2.exe', 'pbrain-rapfi-windows-sse.exe'],
      'linux-x64': ['pbrain-rapfi-linux-clang-avx2', 'pbrain-rapfi-linux-clang-sse'],
      'darwin-arm64': ['pbrain-rapfi-macos-apple-silicon'],
    },
    files: ['config.toml', 'model210901.bin', 'mix9svqfreestyle_bsmix.bin.lz4'],
    binPrefix: 'pbrain-rapfi-',
  },
  go: {
    game: 'go',
    id: 'katago',
    name: 'KataGo',
    repo: `${GH}/lightvector/KataGo`,
    license: 'MIT',
    netLicense: 'KataGo 网络许可证',
    version: 'v1.18.1',
    protocol: 'katago',
    // v1.18.1 是最近一个带 CPU（Eigen）构建的版本；先用 AVX2 版，起不来再换通用 Eigen 版
    assets: {
      'win32-x64': {
        url: `${GH}/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigenavx2-windows-x64.zip`,
        sha256: '0d62ffa41ee04dd89dd1b80fe45e306c837231cb1e2dccb4f5780d0ca7c313db',
        size: 5899607,
        kind: 'zip',
        fallback: {
          url: `${GH}/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigen-windows-x64.zip`,
          sha256: '074485cf150c38aa3bb14ac9f54f2952ffefbceb44673709bbb8a83650bf95d6',
          size: 5903072,
          kind: 'zip',
        },
      },
      'linux-x64': {
        url: `${GH}/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigenavx2-linux-x64.zip`,
        sha256: '33e79780dbe3bf6ee859e16f64952cdfc90f7210c8f71ad978ffcba85ad20d79',
        size: 41821245,
        kind: 'zip',
        fallback: {
          url: `${GH}/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigen-linux-x64.zip`,
          sha256: '993b642601e806037003d11e43775e7b4fc65281aed9b9469b7122f18fc16811',
          size: 41780528,
          kind: 'zip',
        },
      },
    },
    // 官方 kata1 训练网络里体积较小、CPU 上够快的 b15c192（katagotraining.org）
    network: {
      url: 'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b15c192-s1672170752-d466197061.txt.gz',
      sha256: '09456899f1b9155217f4ca059cf8a68f79b7eba22cf6b7c00ffb7f17ce067967',
      size: 48038914,
      name: 'kata1-b15c192-s1672170752-d466197061.txt.gz',
    },
    bins: {
      'win32-x64': ['katago.exe'],
      'linux-x64': ['katago'],
    },
    files: ['analysis_example.cfg'],
  },
}

export function platformKey() {
  return `${process.platform}-${process.arch}`
}

/** 本平台可用的资产；没有则 null（不支持本平台）。 */
export function assetFor(spec, key = platformKey()) {
  if (!spec?.bins?.[key]) return null
  return spec.assets[key] || spec.assets.common || null
}

/** 给设置页与 README 用的公开信息。 */
export function publicInfo(spec) {
  return {
    id: spec.id,
    name: spec.name,
    repo: spec.repo,
    license: spec.license,
    ...(spec.netLicense ? { netLicense: spec.netLicense } : {}),
    version: spec.version,
  }
}
