import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages ではリポジトリ名の下に置かれるので、ビルド時にパスを渡す
  base: process.env.BASE_PATH ?? "/",
  oxc: {
    jsx: { runtime: "automatic", importSource: "preact" },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
