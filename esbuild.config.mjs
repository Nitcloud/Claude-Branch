import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");
const isServerOnly = process.argv.includes("--server-only");

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  treeShaking: true,
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: ["webview/index.tsx"],
  bundle: true,
  outfile: "dist/webview/index.js",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: false,
  treeShaking: true,
  loader: {
    ".css": "css",
    ".svg": "text",
  },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
};

/** @type {esbuild.BuildOptions} */
const serverConfig = {
  entryPoints: ["server/index.ts"],
  bundle: true,
  outfile: "dist/server.js",
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  treeShaking: true,
  external: [],
};

async function build() {
  if (isWatch) {
    if (isServerOnly) {
      const srvCtx = await esbuild.context(serverConfig);
      const webCtx = await esbuild.context(webviewConfig);
      await Promise.all([srvCtx.watch(), webCtx.watch()]);
      console.log("Watching server + webview...");
    } else {
      const extCtx = await esbuild.context(extensionConfig);
      const webCtx = await esbuild.context(webviewConfig);
      const srvCtx = await esbuild.context(serverConfig);
      await Promise.all([extCtx.watch(), webCtx.watch(), srvCtx.watch()]);
      console.log("Watching all targets...");
    }
  } else {
    const targets = isServerOnly
      ? [esbuild.build(serverConfig), esbuild.build(webviewConfig)]
      : [
          esbuild.build(extensionConfig),
          esbuild.build(webviewConfig),
          esbuild.build(serverConfig),
        ];

    await Promise.all(targets);
    console.log("Build complete.");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
